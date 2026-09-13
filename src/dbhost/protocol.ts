// The wire between the main process and a connection host child.
//
// Deliberately small and JSON-only: it crosses a process boundary, and a
// structured-clone-friendly shape keeps the utilityProcess and the plain
// `child_process.fork` used by the future CLI interchangeable.

import type { ConnectSpec, SchemaSnapshot } from '../db/adapter';
import type { HealthScope } from '../shared/health';
import type { Cell, ColumnMeta } from '../shared/types';

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
  | { id: string; op: 'close' };

export type HostResponse =
  /// Reply to a request, keyed by its id.
  | { kind: 'reply'; id: string; ok: true; value: unknown }
  | { kind: 'reply'; id: string; ok: false; error: string }
  /// Out-of-band result stream, keyed by runId rather than request id.
  | { kind: 'chunk'; runId: string; seq: number; columns?: ColumnMeta[]; rows: Cell[][] }
  | { kind: 'done'; runId: string; rowCount: number; affectedRows?: number | null; truncated: boolean; durationMs: number }
  | { kind: 'failed'; runId: string; message: string };

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
