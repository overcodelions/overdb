// The engine seam. Every database overdb speaks to is reached through a
// `DbAdapter`, and nothing in this directory may import `electron` —
// these run under Electron's utilityProcess today and under plain node
// (`overdb serve --mcp`) later. src/db/noElectron.test.ts enforces it.

import type { Cell, ColumnMeta, Engine, SslMode, TableInfo } from '../shared/types';
import type { Variant } from '../shared/engines';
import type { SlowQuerySupport, StatementStat } from '../shared/slowQueries';
import type { HealthScope, HealthSnapshot } from '../shared/health';

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
  /// Paths, read by this process at connect time — see src/db/tls.ts. The
  /// key never travels: main puts a PATH in the spec, and the file is
  /// opened here, in the child that will use it.
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  /// The hostname TLS should be verified against, when it differs from the
  /// address being dialled. Set when the connection runs through an SSH
  /// tunnel: the socket goes to 127.0.0.1 and the certificate still has to
  /// match the real server, or verify-full becomes unusable behind a
  /// bastion and everybody downgrades to `require`.
  tlsServerName?: string;
  /// sqlite only.
  file?: string;
  /// dynamodb only. Credentials come from the AWS provider chain — env,
  /// SSO, or this named profile — and never from overdb's own secret store,
  /// because AWS already solved this and copying a session token into
  /// another application's storage is strictly worse.
  region?: string;
  profile?: string;
  /// Table-name patterns this connection is scoped to (src/shared/
  /// tableFilter.ts). A display and context filter, never a boundary.
  tableFilter?: string;
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
/// buffered ahead of the ack window.
export interface StreamOptions {
  maxRows?: number;
  /// Run this statement OUTSIDE the read-only envelope, because the user
  /// armed a write. Main decides this and consumes the arm; nothing in the
  /// renderer can set it, and an unarmed write still meets the server's own
  /// refusal rather than a check of ours.
  write?: boolean;
}

export interface QueryHandle {
  columns: ColumnMeta[];
  /// Rows a write actually changed, when the engine reports it. Null for a
  /// query that returns rows — those are counted as they stream. Reporting
  /// "0 rows" for a DELETE that removed one is worse than saying nothing.
  affectedRows?: number | null;
  next(n: number): Promise<{ rows: Cell[][]; done: boolean }>;
  close(): Promise<void>;
}

export interface DbAdapter {
  connect(spec: ConnectSpec): Promise<void>;
  ping(): Promise<{ ok: true; serverVersion: string; variant: Variant } | { ok: false; error: string }>;
  /// `tables` names specific tables whose shape is wanted even if a
  /// describe budget would otherwise have skipped them. Engines that
  /// introspect a whole schema at once ignore it — naming the schema
  /// already covers its tables. DynamoDB does not have that luxury: every
  /// table is a separate control-plane call, so an explicit list is the only
  /// way to say "this one matters".
  introspect(opts: { schemas?: string[]; tables?: string[] }): Promise<SchemaSnapshot>;
  /// Everything the connection could look at. On MySQL these are databases,
  /// on Postgres schemas within the connected database, on SQLite just
  /// 'main' plus anything ATTACHed.
  listSchemas(): Promise<string[]>;
  /// Every table in every visible schema, NAMES ONLY. One cheap catalog
  /// query, so cross-schema completion (`other_db.<tab>`) works without
  /// paying to introspect columns for databases you never open.
  /// `unfiltered` bypasses the connection's own tableFilter. Only the
  /// filter-preview in the connection form wants this: everywhere else, a
  /// scoped connection showing tables it is scoped away from would be a bug.
  listTables(opts?: {
    unfiltered?: boolean;
  }): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>>;
  /// Switch what unqualified names resolve to. Cheap on MySQL (`USE`) and
  /// Postgres (`search_path`); switching Postgres DATABASES is not this —
  /// that needs a new connection.
  ///
  /// Returns what the session resolves to AFTERWARDS, read back from the
  /// server rather than echoed. The UI shows that value, so a switch that
  /// silently didn't take can't leave the picker claiming it did.
  useSchema(name: string): Promise<string>;
  /// What unqualified names resolve to right now, straight from the server.
  /// The single source of truth for the schema picker.
  currentSchema(): Promise<string | null>;
  query(sql: string, params?: unknown[], maxRows?: number): Promise<QueryResult>;
  stream(sql: string, params?: unknown[], opts?: StreamOptions): Promise<QueryHandle>;
  /// Manual transactions. Held OPEN across statements, so everything after
  /// this — reads included — sees the uncommitted work, which is the whole
  /// reason to want one. An open transaction holds locks, so main puts an
  /// idle timeout on it rather than trusting anyone to remember.
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  inTransaction(): boolean;
  /// Out-of-band cancel. Returns false when the engine has no interrupt
  /// (SQLite) — the supervisor then kills the host process instead, which
  /// is cheap because reopening a local file costs about a millisecond.
  cancel(): Promise<boolean>;
  /// `params` are the bound values for a statement that still has
  /// placeholders in it (src/shared/params.ts). Planning a statement full
  /// of `$1` is not the same act as planning the query you meant: Postgres
  /// refuses it outright, and every engine that accepts it plans a shape
  /// rather than a search. So the values go along, and the plan describes
  /// the query you were actually about to run.
  explain(
    sql: string,
    analyze: boolean,
    params?: unknown[],
  ): Promise<{ format: 'json' | 'text'; plan: string }>;
  /// Whether this SERVER can report per-statement cost.
  ///
  /// Not derivable from engine or variant, which is why it is a call and
  /// not a constant: pg_stat_statements is an extension somebody has to
  /// have both preloaded and created, performance_schema can be compiled
  /// out or switched off, and Aurora ships one on and the other off. Worse,
  /// catalog presence does not imply readability — a normal Aurora user can
  /// SELECT from pg_stat_statements and get every statement's text replaced
  /// by `<insufficient privilege>`. So implementations probe by performing
  /// the real read, not by inspecting catalogs.
  slowQuerySupport(): Promise<SlowQuerySupport>;
  /// Aggregated statement cost. Ordering happens in the caller, so one read
  /// serves all three orderings and the client-side baseline diff.
  slowQueries(opts: { limit: number }): Promise<StatementStat[]>;
  /// A REAL statement matching this digest — actual literal values, not
  /// the normalized text.
  ///
  /// Exists because the normalized text cannot be planned: `?` and `$1`
  /// are not values, so EXPLAIN rejects it outright, and substituting NULL
  /// turns every predicate into an impossible one and yields a plan that
  /// describes nothing. The servers do keep recent real executions, so the
  /// honest way to plan a digest is to plan one of those.
  ///
  /// Null whenever no example is in reach, which is common: these buffers
  /// are small and hold only recent statements. A null here means the Plan
  /// affordance should be absent, not that it should fall back to faking
  /// one.
  slowQueryExample(digest: string): Promise<string | null>;
  /// Zero the server's counters. Only ever called when `slowQuerySupport()`
  /// reported `resettable`.
  resetSlowQueries(): Promise<void>;
  /// What the server says about itself right now — sessions, connection
  /// headroom, cache, sizes, unused indexes.
  ///
  /// Every field is nullable and every part is allowed to fail on its own:
  /// a managed server hides some of these views from ordinary users, and a
  /// single missing permission must cost one row of the dashboard rather
  /// than all of it. What could not be read comes back in `notes`.
  ///
  /// `scope: 'pulse'` asks for only the half that moves second to second
  /// and skips everything that walks storage, so a fast poll costs the
  /// server almost nothing. The fields it did not read come back at their
  /// empty values — an adapter must not guess at them, and the caller is
  /// expected to lay the result over its last full reading with
  /// `mergePulse` rather than to treat the gaps as answers.
  health(scope?: HealthScope): Promise<HealthSnapshot>;
  /// Stop someone else's statement (`terminate: false`) or close their
  /// connection (`terminate: true`).
  ///
  /// This is the one call in this interface that acts on the server rather
  /// than reading from it, and it deliberately does NOT go through the
  /// read-only envelope — cancelling a runaway statement is exactly what
  /// you want to be able to do on a read-only production connection. The
  /// permission question is answered above it, in main: see the prod rule
  /// on `perf:killSession`.
  ///
  /// Returns rather than throws, because "that session has already gone" is
  /// the common case and is not an error.
  killSession(id: string, opts: { terminate: boolean }): Promise<{ ok: boolean; error?: string }>;
  close(): Promise<void>;
}
