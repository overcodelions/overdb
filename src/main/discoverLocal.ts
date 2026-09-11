// Finding database servers already running on this machine.
//
// Adding a local connection by hand means knowing a port and an engine you
// could simply be told. This asks each candidate port what it is, rather
// than assuming from the number — 3306 answering does not prove MySQL, and
// a MariaDB on 3307 is invisible to a guess.
//
// Both probes are protocol handshakes, not logins: no credentials are sent,
// nothing is authenticated, and the socket closes as soon as the server has
// identified itself. Passwords remain the user's to supply.

import net from 'node:net';
import fs from 'node:fs';
import type { Engine } from '../shared/types';

export interface LocalServer {
  engine: Engine;
  host: string;
  port: number;
  /// What the server said about itself, when it says anything unprompted.
  version?: string;
  /// A unix socket at a well-known path, which is a second signal that this
  /// is a locally-installed server rather than a forwarded port.
  socket?: string;
}

/// Defaults plus the neighbours people actually use when they run two
/// versions side by side. Deliberately short: every entry is a connection
/// attempt, and a long list turns discovery into a port scan.
const CANDIDATES: Array<{ engine: Engine; port: number }> = [
  { engine: 'mysql', port: 3306 },
  { engine: 'mysql', port: 3307 },
  { engine: 'postgres', port: 5432 },
  { engine: 'postgres', port: 5433 },
];

const SOCKETS: Array<{ engine: Engine; path: string }> = [
  { engine: 'mysql', path: '/tmp/mysql.sock' },
  { engine: 'mysql', path: '/var/run/mysqld/mysqld.sock' },
  { engine: 'postgres', path: '/tmp/.s.PGSQL.5432' },
  { engine: 'postgres', path: '/var/run/postgresql/.s.PGSQL.5432' },
];

const PROBE_TIMEOUT_MS = 500;

/// MySQL and MariaDB greet an incoming connection before it says anything:
/// a 4-byte packet header, the protocol version, then a NUL-terminated
/// server version string. Reading it identifies the server exactly, and
/// distinguishes MariaDB from MySQL, without authenticating.
export function parseMysqlGreeting(buf: Buffer): string | null {
  if (buf.length < 6) return null;
  // buf[3] is the packet sequence; buf[4] is the protocol version, 10 for
  // everything since MySQL 4.1. Anything else is not a MySQL server.
  if (buf[4] !== 10) return null;
  const end = buf.indexOf(0, 5);
  if (end === -1) return null;
  const version = buf.subarray(5, end).toString('latin1');
  return version.length > 0 && version.length < 64 ? version : null;
}

/// Postgres says nothing until spoken to. An SSLRequest is the smallest
/// legal thing to say, and the single byte back — 'S' or 'N' — is a reply
/// only a Postgres-protocol server gives.
const SSL_REQUEST = (() => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(80877103, 4);
  return b;
})();

export function isPostgresSslReply(buf: Buffer): boolean {
  return buf.length >= 1 && (buf[0] === 0x53 || buf[0] === 0x4e); // 'S' | 'N'
}

function probe(engine: Engine, host: string, port: number): Promise<LocalServer | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: LocalServer | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));

    socket.connect(port, host, () => {
      if (engine === 'postgres') socket.write(SSL_REQUEST);
    });

    socket.once('data', (buf: Buffer) => {
      if (engine === 'mysql') {
        const version = parseMysqlGreeting(buf);
        done(version ? { engine, host, port, version } : null);
        return;
      }
      done(isPostgresSslReply(buf) ? { engine, host, port } : null);
    });
  });
}

/// Everything answering on this machine, probed in parallel.
export async function discoverLocal(host = '127.0.0.1'): Promise<LocalServer[]> {
  const found = (await Promise.all(CANDIDATES.map((c) => probe(c.engine, host, c.port)))).filter(
    (s): s is LocalServer => s !== null,
  );

  // A socket file corroborates a port we already found; it never invents a
  // server on its own, because a stale socket outlives the server that made
  // it and offering a connection that cannot open helps nobody.
  for (const { engine, path } of SOCKETS) {
    if (!fs.existsSync(path)) continue;
    const match = found.find((s) => s.engine === engine);
    if (match && !match.socket) match.socket = path;
  }

  return found;
}
