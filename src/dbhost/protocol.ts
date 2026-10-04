// The wire between the main process and a connection host child.
//
// Deliberately small and JSON-only: it crosses a process boundary, and a
// structured-clone-friendly shape keeps the utilityProcess and the plain
// `child_process.fork` used by the future CLI interchangeable.

import type { ConnectSpec, SchemaSnapshot } from '../db/adapter';
import type { HealthScope } from '../shared/health';
import type { Cell, ColumnMeta } from '../shared/types';
import type { FindRequest, TableStat } from '../shared/baseline';

export type HostRequest =
  | { id: string; op: 'connect'; spec: ConnectSpec }
  | { id: string; op: 'ping' }
  | { id: string; op: 'introspect'; schemas?: string[]; tables?: string[] }
  | { id: string; op: 'listSchemas' }
  | { id: string; op: 'listTables'; unfiltered?: boolean }
  | { id: string; op: 'useSchema'; name: string }
  | { id: string; op: 'currentSchema' }
  | { id: string; op: 'run'; runId: string; sql: string; params?: unknown[]; maxRows: number; chunkRows: number; write?: boolean }
  | { id: string; op: 'txn'; action: 'begin' | 'commit' | 'rollback' | 'state' }
  | { id: string; op: 'ack'; runId: string; seq: number }
  | { id: string; op: 'cancel'; runId: string }
  | { id: string; op: 'explain'; sql: string; analyze: boolean; params?: unknown[] }
  | { id: string; op: 'slowQuerySupport' }
  | { id: string; op: 'slowQueries'; limit: number }
  | { id: string; op: 'slowQueryExample'; digest: string }
  | { id: string; op: 'resetSlowQueries' }
  | { id: string; op: 'health'; scope?: HealthScope }
  | { id: string; op: 'killSession'; sessionId: string; terminate: boolean }
  /// The server's own table statistics for one schema — estimated rows per
  /// table and the highest id handed out — for the seed gate and the seed's
  /// id block. Catalog reads; no row leaves the host, and no table is
  /// scanned except where the server has no estimate and `countUnknown`
  /// asks for a bounded count instead.
  | { id: string; op: 'seedStats'; schema: string; countUnknown: boolean; cap: number }
  /// Baseline discovery (docs/design/baselines.md): rows and bytes for
  /// every table in these schemas from the server's statistics, one catalog
  /// query. A table the statistics call empty is checked with one
  /// `SELECT 1 … LIMIT 1`, because InnoDB's estimate says 0 for a small
  /// table it has not sampled yet, and "empty" means "copy nothing".
  | { id: string; op: 'baselineStats'; schemas: string[] }
  /// A bounded search of one table for a starting point. The SQL is built
  /// here from the request by src/shared/baseline.ts — identifiers quoted,
  /// the term bound — so no statement text crosses the wire.
  | { id: string; op: 'baselineFind'; req: FindRequest }
  /// How many rows of one table belong to the starting points: one bounded
  /// COUNT, to turn the size estimate from "an average tenant" into this one.
  /// The distinct values of a few columns among a table's first `sample`
  /// rows — a polymorphic pair's type names, Django's content types. The
  /// sample bounds the scan; the limit bounds the answer.
  | { id: string; op: 'baselineDistinct'; schema: string; table: string; columns: string[]; sample: number; limit: number }
  | { id: string; op: 'baselineCount'; schema: string; table: string; column: string; values: string[] }
  | { id: string; op: 'close' };

export type HostResponse =
  /// Reply to a request, keyed by its id.
  | { kind: 'reply'; id: string; ok: true; value: unknown }
  | { kind: 'reply'; id: string; ok: false; error: string }
  /// Out-of-band result stream, keyed by runId rather than request id.
  | { kind: 'chunk'; runId: string; seq: number; columns?: ColumnMeta[]; rows: Cell[][] }
  | { kind: 'done'; runId: string; rowCount: number; affectedRows?: number | null; truncated: boolean; durationMs: number }
  | { kind: 'failed'; runId: string; message: string };

export interface SeedStatsValue {
  tables: Array<{
    table: string;
    /// The server's estimate, a bounded count where it had none, or null.
    rows: number | null;
    /// An estimate rather than a count.
    approx: boolean;
    /// A bounded count that reached the cap: "at least this many".
    capped: boolean;
  }>;
  /// The highest id any table in the schema has handed out, when the
  /// server keeps one (AUTO_INCREMENT, a sequence, SQLite's rowid).
  maxId: number | null;
}

export type BaselineStatsValue = TableStat[];

export interface BaselineFindValue {
  rows: Cell[][];
}

export interface PingValue {
  ok: boolean;
  serverVersion?: string;
  error?: string;
}

export type IntrospectValue = SchemaSnapshot;

/// A plain `Omit<HostRequest, 'id'>` collapses the union to the keys every
/// member shares — which is just `op` — so callers lose `runId`, `spec`
/// and the rest. Distributing over the union keeps each member intact.
export type HostRequestBody = HostRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;
