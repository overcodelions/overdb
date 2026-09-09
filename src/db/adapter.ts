// The engine seam. Every database overdb speaks to is reached through a
// `DbAdapter`, and nothing in this directory may import `electron` —
// these run under Electron's utilityProcess today and under plain node
// (`overdb serve --mcp`) later. src/db/noElectron.test.ts enforces it.

import type { Cell, ColumnMeta, Engine, SslMode, TableInfo } from '../shared/types';

// Schema shapes live in shared/ so the renderer and the pure diffing
// modules can use them without importing the engine layer.
export type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  SchemaInfo,
  SchemaSnapshot,
  TableInfo,
} from '../shared/types';
import type { SchemaSnapshot } from '../shared/types';

/// A fully resolved connection, password included. This type exists only
/// inside the main process and the connection host; it must never appear
/// in an IPC return type (src/main/secretsNeverCrossIpc.test.ts).
export interface ConnectSpec {
  engine: Engine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: SslMode;
  /// sqlite only.
  file?: string;
  searchPath?: string[];
  /// Session-level read-only, applied via ENGINE features (Postgres
  /// `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite's
  /// `readOnly` open flag) — never by inspecting the SQL string. Statement
  /// classification (src/shared/sqlGuard.ts) exists to give a friendly
  /// prompt, not to be the boundary.
  readOnly: boolean;
  statementTimeoutMs: number | null;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}

/// Incremental cursor over a large result. The caller pulls; nothing is
/// buffered ahead of the ack window (see the streaming protocol in
/// docs/PLAN.md).
export interface QueryHandle {
  columns: ColumnMeta[];
  next(n: number): Promise<{ rows: Cell[][]; done: boolean }>;
  close(): Promise<void>;
}

export interface DbAdapter {
  connect(spec: ConnectSpec): Promise<void>;
  ping(): Promise<{ ok: true; serverVersion: string } | { ok: false; error: string }>;
  introspect(opts: { schemas?: string[] }): Promise<SchemaSnapshot>;
  /// Everything the connection could look at. On MySQL these are databases,
  /// on Postgres schemas within the connected database, on SQLite just
  /// 'main' plus anything ATTACHed.
  listSchemas(): Promise<string[]>;
  /// Every table in every visible schema, NAMES ONLY. One cheap catalog
  /// query, so cross-schema completion (`other_db.<tab>`) works without
  /// paying to introspect columns for databases you never open.
  listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>>;
  /// Switch what unqualified names resolve to. Cheap on MySQL (`USE`) and
  /// Postgres (`search_path`); switching Postgres DATABASES is not this —
  /// that needs a new connection.
  useSchema(name: string): Promise<void>;
  query(sql: string, params?: unknown[], maxRows?: number): Promise<QueryResult>;
  stream(sql: string, params?: unknown[]): Promise<QueryHandle>;
  /// Out-of-band cancel. Returns false when the engine has no interrupt
  /// (SQLite) — the supervisor then kills the host process instead, which
  /// is cheap because reopening a local file costs about a millisecond.
  cancel(): Promise<boolean>;
  explain(sql: string, analyze: boolean): Promise<{ format: 'json' | 'text'; plan: string }>;
  close(): Promise<void>;
}
