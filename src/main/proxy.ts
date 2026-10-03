// The proxy: one address your services keep connecting to, forwarded to
// whichever database is active — your own server, or a ticket copy. See
// docs/design/baselines.md.
//
// Byte for byte. It never reads a query or rewrites a schema name, so
// anything that works against a server works through it, cross-schema
// queries included. Loopback only: it binds 127.0.0.1 and a local socket,
// never an outside interface.
//
// Switching the target closes every connection it is carrying. A pool that
// kept its old sockets would go on talking to the old database; a closed
// one reconnects on its next query, and lands on the new one.

import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ProxyClient } from '../shared/instances';

export type Upstream = { host: string; port: number };

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
}

let tcp: net.Server | null = null;
let unix: net.Server | null = null;
let socketPath: string | null = null;
let listenPort: number | null = null;
let resolveUpstream: () => Promise<Upstream> = async () => {
  throw new Error('The proxy has nowhere to send connections.');
};
const pairs = new Set<Pair>();

function handle(client: net.Socket): void {
  client.pause();
  resolveUpstream()
    .then((to) => {
      const upstream = net.connect({ host: to.host, port: to.port });
      const pair = { client, upstream };
      pairs.add(pair);
      const end = () => {
        pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', end).on('close', end);
      upstream.on('error', end).on('close', end);
      upstream.once('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    })
    .catch(() => client.destroy());
}

function listen(server: net.Server, opts: net.ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error) => reject(err);
    server.once('error', fail);
    server.listen(opts, () => {
      server.off('error', fail);
      resolve();
    });
  });
}

/// Something answers on a socket path: a server is using it, and it is not
/// ours to delete.
function socketAnswers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ path: file });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export async function startProxy(opts: {
  port: number;
  socket: string | null;
  upstream: () => Promise<Upstream>;
}): Promise<void> {
  await stopProxy();
  resolveUpstream = opts.upstream;
  const server = net.createServer(handle);
  try {
    await listen(server, { host: '127.0.0.1', port: opts.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EADDRINUSE'
        ? `Port ${opts.port} is in use — most likely by your own server. Move it to another port once, and the proxy takes this one.`
        : `The proxy could not listen on port ${opts.port}: ${(err as Error).message}`,
    );
  }
  tcp = server;
  listenPort = opts.port;
  if (opts.socket) {
    if (await socketAnswers(opts.socket)) {
      await stopProxy();
      throw new Error(`${opts.socket} belongs to a running server. Move its socket once, and the proxy takes this path.`);
    }
    await fs.rm(opts.socket, { force: true });
    const s = net.createServer(handle);
    await listen(s, { path: opts.socket });
    await fs.chmod(opts.socket, 0o777).catch(() => undefined);
    unix = s;
    socketPath = opts.socket;
  }
}

export async function stopProxy(): Promise<void> {
  dropConnections();
  const close = (s: net.Server | null) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));
  await Promise.all([close(tcp), close(unix)]);
  tcp = null;
  unix = null;
  listenPort = null;
  if (socketPath) await fs.rm(socketPath, { force: true }).catch(() => undefined);
  socketPath = null;
}

/// Close every connection the proxy carries. New ones go wherever the
/// upstream resolver now says.
export function dropConnections(): number {
  const n = pairs.size;
  for (const p of [...pairs]) {
    p.client.destroy();
    p.upstream.destroy();
  }
  pairs.clear();
  return n;
}

export function setUpstream(fn: () => Promise<Upstream>): void {
  resolveUpstream = fn;
}

export function proxyRunning(): boolean {
  return tcp !== null;
}

export function proxyConnections(): number {
  return pairs.size;
}

/// `lsof -F pcn` output for established TCP sockets on the proxy's port:
/// the processes at the other end of each connection, without overdb.
export function parseClients(out: string, port: number, self: number): ProxyClient[] {
  const by = new Map<number, ProxyClient>();
  let pid = 0;
  let cmd = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) cmd = line.slice(1).trim();
    else if (line.startsWith('n') && pid && pid !== self) {
      // A client's own socket reads `local->127.0.0.1:<port>`.
      if (!line.includes(`->127.0.0.1:${port}`) && !line.includes(`->localhost:${port}`)) continue;
      const c = by.get(pid) ?? { process: cmd, pid, connections: 0 };
      c.connections++;
      by.set(pid, c);
    }
  }
  return [...by.values()].sort((a, b) => b.connections - a.connections || a.process.localeCompare(b.process));
}

/// Who is connected through the proxy right now, by process. TCP only:
/// lsof cannot name the far end of a Unix socket portably.
export function proxyClients(): Promise<ProxyClient[]> {
  const port = listenPort;
  if (!port || process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/lsof', ['+c', '0', '-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcn'], { env: process.env });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 3_000);
    child.stdout.on('data', (b) => (out += b.toString('utf-8')));
    child.on('error', () => resolve([]));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseClients(out, port, process.pid));
    });
  });
}
