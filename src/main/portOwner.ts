// Which process is listening on a loopback port.
//
// The seed gate's answer to "is localhost:3306 really a database on this
// machine?" (src/shared/seedGate.ts). A host of `localhost` proves nothing —
// an SSH tunnel, `kubectl port-forward` and a cloud SQL proxy all listen
// there — but the process holding the port does: `mariadbd` is a server,
// `ssh` is a forward.
//
// `lsof`, spawned with argv and no shell (src/main/noShellExec.test.ts).
// By absolute path first: an app launched from the Dock does not inherit
// the shell's PATH. Absent, or unable to see the owner (a server running as
// another user), the answer is null and the gate falls back to row counts.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { classifyListener, type Listener } from '../shared/seedGate';

const TIMEOUT_MS = 3_000;

function lsofPath(): string | null {
  if (process.platform === 'win32') return null;
  for (const p of ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof']) {
    if (fs.existsSync(p)) return p;
  }
  return 'lsof';
}

/// `lsof -F c` output: `p<pid>` then `c<command>` per process. The first
/// command is the owner; a port has one listener.
export function parseLsof(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('c') && line.length > 1) return line.slice(1).trim();
  }
  return null;
}

export function portOwner(port: number): Promise<Listener | null> {
  const lsof = lsofPath();
  if (!lsof || !Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    // `+c 0`: the full command name. The default truncates to nine
    // characters, and `cloud_sql` or `com.docke` classify as nothing.
    const child = spawn(lsof, ['+c', '0', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], {
      env: process.env,
    });
    let out = '';
    let settled = false;
    const done = (v: Listener | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, TIMEOUT_MS);
    child.stdout.on('data', (b) => (out += b.toString('utf-8')));
    child.on('error', () => done(null));
    // lsof exits 1 when it finds nothing it may show — the owner belongs to
    // another user, most often. That is "cannot tell", not an error.
    child.on('close', () => {
      const name = parseLsof(out);
      done(name ? { process: name, kind: classifyListener(name) } : null);
    });
  });
}

/// The port a connection actually reaches, defaulting per engine.
export function connectionPort(engine: string, port: number | undefined): number | null {
  if (port) return port;
  if (engine === 'mysql') return 3306;
  if (engine === 'postgres') return 5432;
  return null;
}
