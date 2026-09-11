// SSH tunnels, as processes with a lifetime tied to a connection.
//
// One `ssh -N -L` child per tunnelled connection, keyed the way hosts are
// keyed in dbSupervisor — by connection id, or by a throwaway id for a
// connection being tested. The rule that keeps this from leaking processes:
// every path that closes a connection host also closes its tunnel, and
// nothing opens a second tunnel for a key without closing the first.
//
// The argv itself, and why each option is there, lives in
// src/shared/sshTunnel.ts so it can be asserted without spawning anything.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { explainSshFailure, tunnelArgv, validateTunnel, type SshTunnel } from '../shared/sshTunnel';
import { execEnv } from './credentialImport/command';

interface Live {
  proc: ChildProcess;
  port: number;
  /// Kept so a failure that arrives after readiness — a bastion dropping
  /// the session mid-query — can still be explained.
  stderr: string;
}

const tunnels = new Map<string, Live>();

/// How long to wait for the forwarded port to start accepting. Generous:
/// a bastion behind a slow VPN, or one that asks a hardware key for a touch,
/// is normal and not an error.
const READY_TIMEOUT_MS = 25_000;

export interface TunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}

/// A free loopback port, from the kernel.
///
/// There is an unavoidable race here — the port is free when we ask and
/// could be taken before ssh binds it — which is precisely what
/// ExitOnForwardFailure turns into a clean, retryable error instead of a
/// tunnel that is silently forwarding nothing.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/// Open (or reopen) the tunnel for `key`, and return the local endpoint the
/// database driver should dial instead of the real host.
///
/// Throws with a sentence rather than an ssh transcript. The transcript is
/// appended, because someone will need to paste it into a ticket.
export async function openTunnel(
  key: string,
  tunnel: SshTunnel,
  fallback: { host: string; port: number },
): Promise<TunnelEndpoint> {
  const invalid = validateTunnel(tunnel);
  if (invalid) throw new Error(`SSH tunnel: ${invalid}`);

  closeTunnel(key);

  const port = await freePort();
  const argv = tunnelArgv(tunnel, port, fallback);
  const proc = spawn('ssh', argv, {
    env: execEnv(),
    shell: false,
    // BatchMode means ssh never wants stdin; closing it guarantees that a
    // prompt we did not anticipate ends the process instead of hanging it.
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const live: Live = { proc, port, stderr: '' };
  tunnels.set(key, live);

  proc.stderr?.on('data', (b: Buffer) => {
    if (live.stderr.length < 4_000) live.stderr += b.toString('utf-8');
  });

  let exited: { code: number | null } | null = null;
  proc.on('exit', (code) => {
    exited = { code };
    // Only if this is still the registered tunnel: a reopen races an old
    // child's exit exactly the way dbSupervisor's hosts do.
    if (tunnels.get(key) === live) tunnels.delete(key);
  });
  proc.on('error', (err) => {
    live.stderr += `\n${err.message}`;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      tunnels.delete(key);
      const explained = explainSshFailure(live.stderr);
      throw new Error(
        `SSH tunnel: ${explained ?? 'ssh exited before the forward was open.'}` +
          (live.stderr.trim() ? `\n${live.stderr.trim().split('\n').slice(0, 4).join('\n')}` : ''),
      );
    }
    if (await canConnect(port)) return { host: '127.0.0.1', port };
    if (Date.now() > deadline) {
      closeTunnel(key);
      throw new Error(
        'SSH tunnel: the forward did not come up within 25s. ' +
          (explainSshFailure(live.stderr) ?? 'The bastion may be waiting on something overdb cannot answer.'),
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function closeTunnel(key: string): void {
  const live = tunnels.get(key);
  if (!live) return;
  tunnels.delete(key);
  try {
    live.proc.kill('SIGTERM');
    // An open forward to a production database is not a thing to leave
    // running because a child declined to take the hint.
    const kill = setTimeout(() => {
      try {
        live.proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2_000);
    kill.unref?.();
  } catch {
    /* already gone */
  }
}

export function closeAllTunnels(): void {
  for (const key of [...tunnels.keys()]) closeTunnel(key);
}

// The backstop, registered here so it cannot be forgotten by a caller.
// `before-quit` covers the ordinary exit; this covers the paths that skip
// it. A forward left open onto a production database after the app is gone
// is the failure worth spending a listener on.
//
// It is not proof against a hard crash or a SIGKILL of the main process:
// nothing running in this process can be. An orphaned `ssh -N` is visible
// in `ps` and dies with the login session.
process.on('exit', () => closeAllTunnels());

/// Whether a connection's tunnel is currently up — the sidebar has no use
/// for this yet, but "is it me or the bastion" is the first question when a
/// tunnelled connection dies, and the answer should not require a log.
export function tunnelIsOpen(key: string): boolean {
  return tunnels.has(key);
}
