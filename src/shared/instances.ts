// Records for the instances overdb runs: a baseline per source connection,
// and ticket copies cloned from it. See docs/design/baselines.md.

import type { BuildReport } from './baselineBuild';

export interface BaselineRecord {
  id: string;
  /// The local connection it was built from.
  sourceConnectionId: string;
  sourceName: string;
  /// The stopped data directory that IS the baseline.
  datadir: string;
  /// The server binary it was built with, which every copy must run under.
  mysqld: string;
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
}

/// The spare port suggested for the proxy when your own server keeps its
/// own: services are pointed at it once, and nothing else moves.
export const SPARE_PROXY_PORT = 3310;

export const DEFAULT_PROXY: ProxyConfig = {
  port: 3306,
  socket: '/tmp/mysql.sock',
  server: { host: '127.0.0.1', port: 3307 },
  target: { kind: 'server' },
};

/// The background helper, as the window sees it.
export interface HelperStatus {
  installed: boolean;
  /// Answering on its socket.
  running: boolean;
  pid: number | null;
  error: string | null;
}
