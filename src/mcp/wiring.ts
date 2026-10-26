// The MCP tools wired to a supervisor of connection hosts.
//
// Two processes serve the same tools: the Overdb app started headless
// (src/main/mcpServe.ts, Electron's utilityProcess, credentials from the
// keychain) and plain node (src/mcp/headless.ts, child_process.fork,
// credentials from the server's environment or its AWS role). Everything
// they have in common is here, so the read-only rules cannot drift apart:
//
//   * every session is opened with `readOnly: true`, whatever the
//     connection says, and every statement is sent with `write: false`;
//   * a statement timeout applies even where the app would allow none.
//
// Electron-free: the headless entry reaches this file.

import { randomUUID } from 'node:crypto';

import type { ConnectSpec } from '../db/adapter';
import type { HostRequestBody, HostResponse } from '../dbhost/protocol';
import type { Cell, ColumnMeta, Connection, SchemaSnapshot } from '../shared/types';
import type { HealthSnapshot } from '../shared/health';
import type { SlowQuerySupport, StatementStat } from '../shared/slowQueries';
import { exposedConnections, type CollectedRows, type McpDeps } from './tools';

export const AGENT_TIMEOUT_MS = 30_000;

/// What both supervisors offer. src/main/dbSupervisor.ts satisfies it as a
/// module; src/mcp/nodeSupervisor.ts as an object.
export interface Supervisor {
  openConnection(connectionId: string, spec: ConnectSpec): Promise<unknown>;
  request(connectionId: string, req: HostRequestBody): Promise<unknown>;
  notify(connectionId: string, req: HostRequestBody): void;
  onHostEvent(fn: (event: HostResponse) => void): void;
  onConnectionState(fn: (connectionId: string, state: 'open' | 'closed' | 'error') => void): void;
  isOpen(connectionId: string): boolean;
  openConnectionIds(): string[];
  closeConnection(connectionId: string): Promise<void>;
}

export interface WiringOptions {
  /// Every connection, read fresh on each call.
  connections(): Connection[];
  /// The connection's spec with its credential in it. Read-only and the
  /// timeout are applied on top, here, whatever this returns.
  resolveSpec(conn: Connection): Promise<ConnectSpec>;
  /// Called after a session closes because its connection is no longer
  /// exposed — for the app, the connection's SSH tunnel.
  closed?(connectionId: string): void;
  log(line: string): void;
}

interface Run {
  connectionId: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  resolve(rows: CollectedRows): void;
  reject(err: Error): void;
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('••••••') : text;
}

export function wireMcp(sup: Supervisor, opts: WiringOptions): McpDeps {
  // Rows arrive as chunks keyed by run. Each is acked, which is what lets
  // the host's cursor fetch the next one.
  const runs = new Map<string, Run>();
  sup.onHostEvent((event) => {
    if (event.kind === 'reply') return;
    const run = runs.get(event.runId);
    if (!run) return;
    if (event.kind === 'chunk') {
      if (event.columns) run.columns = event.columns;
      run.rows.push(...event.rows);
      sup.notify(run.connectionId, { op: 'ack', runId: event.runId, seq: event.seq });
    } else if (event.kind === 'done') {
      runs.delete(event.runId);
      run.resolve({ columns: run.columns, rows: run.rows, rowCount: event.rowCount, truncated: event.truncated });
    } else if (event.kind === 'failed') {
      runs.delete(event.runId);
      run.reject(new Error(event.message));
    }
  });
  // A host that died takes its runs with it. Without this the agent's call
  // would wait forever for a `done` nobody is left to send.
  sup.onConnectionState((connectionId, state) => {
    if (state === 'open') return;
    for (const [runId, run] of runs) {
      if (run.connectionId !== connectionId) continue;
      runs.delete(runId);
      run.reject(new Error('The connection closed while the query was running.'));
    }
  });

  /// A session left open on a connection that is no longer exposed is
  /// closed rather than left to idle.
  function connections(): Connection[] {
    const all = opts.connections();
    const exposed = new Set(exposedConnections(all).map((c) => c.id));
    for (const id of sup.openConnectionIds()) {
      if (exposed.has(id)) continue;
      void sup.closeConnection(id).then(() => opts.closed?.(id));
    }
    return all;
  }

  async function ensureOpen(conn: Connection): Promise<void> {
    if (sup.isOpen(conn.id)) return;
    const spec = await opts.resolveSpec(conn);
    spec.readOnly = true;
    spec.statementTimeoutMs = Math.min(spec.statementTimeoutMs ?? AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS);
    const ping = (await sup.openConnection(conn.id, spec)) as { ok?: boolean; error?: string };
    if (!ping?.ok) throw new Error(redact(ping?.error ?? 'Could not connect.', spec.password));
  }

  return {
    connections,
    ensureOpen,
    listTables: async (conn) =>
      (await sup.request(conn.id, { op: 'listTables' })) as Array<{ schema: string; table: string; kind: string }>,
    introspect: async (conn, o) => (await sup.request(conn.id, { op: 'introspect', ...o })) as SchemaSnapshot,
    query: (conn, sql, params, maxRows) =>
      new Promise<CollectedRows>((resolve, reject) => {
        const runId = randomUUID();
        runs.set(runId, { connectionId: conn.id, columns: [], rows: [], resolve, reject });
        sup.request(conn.id, { op: 'run', runId, sql, params, maxRows, chunkRows: 500, write: false }).catch(
          (e: Error) => {
            runs.delete(runId);
            reject(e);
          },
        );
      }),
    health: async (conn) => (await sup.request(conn.id, { op: 'health' })) as HealthSnapshot,
    slowQuerySupport: async (conn) => (await sup.request(conn.id, { op: 'slowQuerySupport' })) as SlowQuerySupport,
    slowQueries: async (conn, limit) => (await sup.request(conn.id, { op: 'slowQueries', limit })) as StatementStat[],
    log: opts.log,
  };
}

/// Each connection's catalog, kept a few minutes: the context's staleness
/// check (and the app's tenant detection) should not re-read every table
/// for each question an agent asks.
export function catalogCache(sup: Pick<Supervisor, 'request'>, ttlMs = 5 * 60_000): (connectionId: string) => Promise<SchemaSnapshot> {
  const kept = new Map<string, { at: number; snapshot: SchemaSnapshot }>();
  return async (connectionId) => {
    const hit = kept.get(connectionId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.snapshot;
    const schemas = (await sup.request(connectionId, { op: 'listSchemas' })) as string[];
    const snapshot = (await sup.request(connectionId, { op: 'introspect', schemas })) as SchemaSnapshot;
    kept.set(connectionId, { at: Date.now(), snapshot });
    return snapshot;
  };
}
