// Records for the instances overdb runs: a baseline per source connection,
// and ticket copies cloned from it. See docs/design/baselines.md.

import type { BuildReport } from './baselineBuild';
import type { Connection } from './types';

export interface BaselineRecord {
  id: string;
  /// The local connection it was built from.
  sourceConnectionId: string;
  sourceName: string;
  /// The stopped data directory that IS the baseline.
  datadir: string;
  /// The server binary it was built with, which every copy must run under
  /// — `mysqld`, or `postgres` for a copy of Postgres or Redshift.
  mysqld: string;
  /// Which kind of server that is. Absent on bases built before Postgres.
  flavor?: 'mysql' | 'mariadb' | 'postgres';
  version: string;
  builtAt: string;
  /// When the recipe it was built from was saved, to say "out of date".
  recipeSavedAt: string;
  /// Who it is built around, in the person's words: "Acme", "you@example.com".
  label: string;
  /// The person renamed it, so a rebuild keeps their name.
  named?: boolean;
  bytes: number;
  report: BuildReport;
  /// Where its root (or postgres) password is kept, in main's secret store.
  /// Absent on bases built before copies had one.
  adminSecret?: string;
}

export interface TicketRecord {
  id: string;
  /// "PROJ-123", or whatever the person called it.
  name: string;
  note: string;
  baselineId: string;
  sourceConnectionId: string;
  datadir: string;
  /// Kept across restarts so its connection keeps working.
  port: number;
  /// The overdb connection that reaches it.
  connectionId: string;
  createdAt: string;
  /// When its data was last taken from the base — made, or reset since.
  resetAt?: string;
}

/// A branch's base: the one it was made from, or — once that was rebuilt,
/// which replaces it — its source's base now.
export function baseOf<B extends { id: string; sourceConnectionId: string }>(t: TicketRecord, baselines: B[]): B | undefined {
  return baselines.find((b) => b.id === t.baselineId) ?? baselines.find((b) => b.sourceConnectionId === t.sourceConnectionId);
}

/// Whether the base was built again after this branch took its data: a
/// reset would bring the newer data in.
export function baseIsNewer(t: TicketRecord, base: { builtAt: string } | undefined): boolean {
  return !!base && base.builtAt > (t.resetAt ?? t.createdAt);
}

export interface TicketState extends TicketRecord {
  running: boolean;
}

/// Where the proxy sends new connections: your own server, or a ticket copy.
export type ProxyTarget = { kind: 'server' } | { kind: 'ticket'; id: string };

export interface ProxyConfig {
  /// The port your services already connect to.
  port: number;
  /// The Unix socket clients reach with `host=localhost`, or null to leave
  /// sockets alone.
  socket: string | null;
  /// Where your own server listens once the proxy has its old port.
  server: { host: string; port: number };
  target: ProxyTarget;
}

export interface ProxyClient {
  process: string;
  pid: number;
  /// How many connections this process has open through the proxy.
  connections: number;
}

export interface ProxyState {
  /// The connection whose base this proxy serves: services that used that
  /// database connect here, and its branches are what it switches between.
  /// One proxy per base, so a service using two databases has two.
  source: string;
  config: ProxyConfig;
  running: boolean;
  /// Why it is not listening: a port in use, a socket another server owns.
  error: string | null;
  /// Who holds the port it wanted, when that was the reason — `mysqld` is
  /// your own server, anything else is something else.
  conflict: { port: number; process: string | null } | null;
  connections: number;
  /// Whether it has ever been set up. Until it has, the window suggests
  /// settings from the connection the baselines came from.
  configured: boolean;
  /// Something to know about how it runs — that logins are not warmed for
  /// MySQL's caching_sha2_password, when the background helper runs it.
  note?: string;
}

/// The spare port suggested for the proxy when your own server keeps its
/// own: services are pointed at it once, and nothing else moves.
export const SPARE_PROXY_PORT = 3310;

/// The same, by what the base speaks: a Postgres or Redshift base's proxy
/// sits beside Postgres's 5432 and Redshift's 5439, not among MySQL's ports.
export function spareProxyPort(engine: string | undefined): number {
  return engine === 'postgres' ? 5440 : SPARE_PROXY_PORT;
}

export const DEFAULT_PROXY: ProxyConfig = {
  port: 3306,
  socket: '/tmp/mysql.sock',
  server: { host: '127.0.0.1', port: 3307 },
  target: { kind: 'server' },
};

/// Why a connection cannot be a base's source — and so cannot be copied
/// here or have a proxy — or null when it can. A base is a copy you write
/// to and point services at, read from a server you are allowed to copy:
/// your own, or a shared dev, sandbox or staging one. Production never, and
/// an untagged server is not assumed to be anything else. There is no
/// override; the tag is the decision.
export function devInstanceRefusal(conn: Pick<Connection, 'env' | 'engine'>): string | null {
  if (conn.engine === 'dynamodb') return 'Bases are for SQL databases.';
  if (conn.env === 'prod') return 'Never from production. Build the base from a local, dev, sandbox or staging connection.';
  if (conn.env === 'other') return 'Tag this connection local, dev, sandbox or staging first — an untagged server is treated as one you may not copy.';
  // MySQL and MariaDB are copied into the same kind of server; Postgres and
  // Redshift into Postgres. SQLite is a file and needs no copy.
  if (conn.engine !== 'mysql' && conn.engine !== 'postgres') return 'Copies are for MySQL, MariaDB, Postgres and Redshift servers.';
  return null;
}

/// The overdb connection that shows what a proxy's services see, one per
/// proxy. Hidden from the list and nested under its source.
export function proxyConnectionId(source: string): string {
  return `overdb-proxy:${source}`;
}

export function isProxyConnectionId(id: string): boolean {
  return id === 'overdb-proxy' || id.startsWith('overdb-proxy:');
}

/// A connection overdb made for itself — a branch, or a proxy's "What
/// services see" — rather than one you added. Kept out of environment sets:
/// they come and go with tickets, and they sit under their base already.
export function isOverdbConnection(c: { id: string; secretRef?: string }): boolean {
  return isProxyConnectionId(c.id) || !!c.secretRef?.startsWith('ticket-');
}

/// The background helper, as the window sees it.
export interface HelperStatus {
  installed: boolean;
  /// Answering on its socket.
  running: boolean;
  pid: number | null;
  error: string | null;
}
