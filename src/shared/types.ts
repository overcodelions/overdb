// The shared contract: every type that crosses a process boundary, plus
// the two maps that define the renderer ↔ main seam.
//
// One rule governs this file: **no type here carries a credential.** A
// `Connection` holds a `secretRef` — a key into the main-process secret
// store — and never a password. The renderer receives `Connection`s, so
// anything added here is, by construction, something the renderer may
// see. `src/main/secretsNeverCrossIpc.test.ts` enforces the same rule on
// IPC return types.

export type Engine = 'postgres' | 'mysql' | 'sqlite';

/// Drives more than a label: statement-timeout defaults, whether writes
/// need arming, and how loudly the UI shouts before a mutation.
export type EnvKind = 'local' | 'dev' | 'staging' | 'prod' | 'other';

export type SslMode = 'disable' | 'require' | 'verify-full';

/// 'none' covers trust auth and unix-socket logins, which are the common
/// case for a local database and should not require inventing a password.
export type SecretSource = 'none' | 'stored' | 'env' | 'op';

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  env: EnvKind;
  /// Network engines. Absent for sqlite.
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /// sqlite only — absolute path to the database file.
  file?: string;
  ssl?: SslMode;
  defaultSchema?: string;
  /// Where the password comes from. Made explicit rather than inferred
  /// from which field happens to be set, so "this connection has no
  /// password" is a stated fact and not an accident.
  secretSource?: SecretSource;
  /// A KEY into the main-process secret store, never the secret itself.
  /// Only meaningful when secretSource is 'stored'.
  secretRef?: string;
  /// Name of an environment variable holding the password, read from the
  /// app's own environment at connect time. Nothing is copied into our
  /// store, so rotating the variable rotates the credential.
  secretEnvVar?: string;
  /// A 1Password reference (`op://vault/item/field`), resolved by shelling
  /// out to `op` at connect time using your existing session. Storing the
  /// reference rather than the value means the secret never enters
  /// overdb's store at all — strictly better than copying it in.
  secretCommand?: string;
  color?: string;
  lastOpenedAt?: string;
  /// Opt-in exposure to `overdb serve --mcp` (v0.3). Off by default:
  /// handing an agent a prod connection should be a deliberate act.
  mcpExposed?: boolean;
}

/// A durable grouping — "these are Payments". The sidebar's collapsible
/// sections. A connection may belong to many.
export interface ConnectionGroup {
  id: string;
  name: string;
  connectionIds: string[];
  collapsed?: boolean;
  createdAt?: string;
}

/// The same logical database across environments, pinned to a baseline.
/// Everything — result diff, schema drift — is reported as baseline vs.
/// the others, because an N×N matrix is unreadable but "prod is the
/// truth, staging drifted" is a sentence.
export interface EnvSet {
  id: string;
  name: string;
  memberIds: string[];
  baselineId: string;
  pinnedSchema?: string;
  archived?: boolean;
  createdAt?: string;
  archivedAt?: string;
}

// ---------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------

export type CellKind =
  | 'bool' | 'int' | 'bigint' | 'float' | 'decimal' | 'text' | 'bytes'
  | 'json' | 'date' | 'time' | 'timestamp' | 'timestamptz' | 'interval'
  | 'uuid' | 'array' | 'other';

export interface ColumnMeta {
  name: string;
  /// The engine's own type name, verbatim — shown in the grid header.
  typeName: string;
  kind: CellKind;
  nullable: boolean | null;
  /// The only thing that makes an inline edit safe: without a known
  /// source table and column, a cell is not editable and the UI says so.
  sourceTable: { schema: string | null; table: string; column: string } | null;
}

/// A value over 64 KB ships truncated with its true length, so one large
/// `bytea` can't blow the wire. The full value is fetched on demand.
export interface BinaryCell {
  __bin: true;
  b64: string;
  byteLength: number;
  truncated: boolean;
}

/// Driver type-parsing is deliberately disabled (see src/db/adapters/*),
/// so values arrive as the exact strings the server sent. overdb decides
/// presentation; the driver does not.
export type Cell = null | string | number | boolean | BinaryCell;

/// Where a statement came from. There is deliberately NO 'ai' member:
/// the AI layer proposes SQL into the editor and has no execute path.
/// `src/main/aiNeverExecutes.test.ts` asserts this stays true.
export type QueryOrigin = 'editor' | 'grid-edit' | 'saved';

export type FanoutResult =
  | 'ok' | 'blocked-readonly' | 'blocked-unarmed' | 'connect-failed'
  | 'query-error' | 'timeout' | 'cancelled' | 'truncated';

/// Per-member outcome, never an abort on first failure — the same shape
/// overgit uses for multi-repo actions, for the same reason: a partial
/// result the user can read beats an exception that hides four successes.
export interface FanoutOutcome {
  connectionId: string;
  result: FanoutResult;
  runId?: string;
  rowCount?: number;
  durationMs?: number;
  serverVersion?: string;
  message?: string;
}

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------
// These live here rather than in src/db because three places need them:
// the adapters that produce them, the renderer that draws the tree, and
// src/shared/schemaDiff.ts, which must stay pure and database-free.

export interface ColumnInfo {
  name: string;
  /// Retained as DATA, not as array position — schema diffing has to be
  /// order-independent or every comparison is noise. MySQL cares about
  /// column order and Postgres does not, so it is reported, not assumed.
  ordinal: number;
  typeName: string;
  nullable: boolean;
  defaultExpr: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view' | 'matview';
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface SchemaInfo {
  name: string;
  tables: TableInfo[];
}

export interface SchemaSnapshot {
  engine: Engine;
  serverVersion: string;
  capturedAt: string;
  schemas: SchemaInfo[];
}

// ---------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  sidebarVisible: boolean;
  sidebarWidth: number;
  /// Rows fetched before the grid stops and asks. Small on purpose: the
  /// first thing you do with a table is look at it, and 1,000 rows answers
  /// that in milliseconds. Fetching 100k to scroll past 40 is a tax on
  /// every exploratory query.
  rowLimit: number;
  /// Which AI CLI to use, or null for "none detected / disabled".
  aiTool: 'claude' | 'codex' | 'gemini' | null;
  /// Model used for the frequent, low-stakes calls (error repair, short
  /// completions). Empty means "the CLI's own default".
  aiFastModel: { claude: string; codex: string; gemini: string };
  /// A query slower than this offers to explain itself. 0 disables.
  slowQueryMs: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarVisible: true,
  sidebarWidth: 260,
  rowLimit: 1_000,
  aiTool: null,
  aiFastModel: { claude: 'haiku', codex: '', gemini: '' },
  slowQueryMs: 1_000,
};

export interface StoreSnapshot {
  connections: Connection[];
  groups: ConnectionGroup[];
  envSets: EnvSet[];
  settings: AppSettings;
  /// Editor contents per connection. A query written against one schema is
  /// usually meaningless against another, so each connection keeps its own
  /// buffer — and keeps it across restarts, because losing what you were
  /// working on is not an acceptable cost of quitting the app.
  buffers: Record<string, string>;
}

// ---------------------------------------------------------------------
// The IPC seam
// ---------------------------------------------------------------------

/// Every channel the renderer may invoke. `src/main/ipcContract.test.ts`
/// asserts this set and the `ipcMain.handle` registrations in
/// src/main/index.ts match exactly — TypeScript cannot catch a channel
/// name that exists on only one side.
///
/// Note what is absent: there is no `secret:get`. Secrets are write-only
/// from the renderer's perspective.
export interface IPCInvokeMap {
  'store:load': () => StoreSnapshot;
  'store:saveConnections': (connections: Connection[]) => void;
  'store:saveGroups': (groups: ConnectionGroup[]) => void;
  'store:saveEnvSets': (envSets: EnvSet[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;
  'store:saveBuffer': (args: { connectionId: string; text: string }) => void;
  'app:version': () => { app: string; electron: string; node: string; chrome: string };
  'app:openExternal': (url: string) => void;
  /// Native file picker for SQLite. The renderer cannot browse the disk
  /// itself; main returns only the chosen path.
  'app:pickSqliteFile': () => string | null;
  'app:pickFolder': () => string | null;
  /// Scan the machine for connections defined in other tools. Read-only:
  /// nothing is modified, and nothing is imported until the user picks it.
  'import:scan': (projectRoot?: string) => {
    sources: Array<{
      id: string;
      label: string;
      detail: string;
      candidates: Array<{
        sourceId: string; name: string; origin: string;
        engine: Engine | null; driver: string; env: EnvKind;
        group?: string; host?: string; port?: number; database?: string;
        user?: string; password?: string; note?: string;
      }>;
    }>;
  };
  /// Clipboard goes through main: navigator.clipboard needs a secure
  /// context, and the packaged app loads from file://.
  'app:copyText': (text: string) => void;

  /// Write-only from the renderer's side. Note the absence of a getter:
  /// there is no channel that returns a credential, and
  /// src/main/secretsNeverCrossIpc.test.ts fails the build if one appears.
  'conn:setSecret': (args: { connectionId: string; value: string }) => { ok: boolean; encrypted: boolean };
  'conn:hasSecret': (connectionId: string) => boolean;
  /// Deletes the stored credential. Called when a connection is removed,
  /// so a forgotten secret can't outlive the thing it belonged to.
  'conn:deleteSecret': (connectionId: string) => void;
  /// Resolve-and-report, for the connection form: says whether a non-stored
  /// credential source can currently produce a value, WITHOUT returning it.
  'conn:probeSecret': (args: {
    source: SecretSource;
    envVar?: string;
    reference?: string;
  }) => { ok: boolean; detail: string };
  'conn:open': (connectionId: string) => { ok: boolean; serverVersion?: string; error?: string };
  'conn:close': (connectionId: string) => void;
  'conn:isOpen': (connectionId: string) => boolean;
  'conn:introspect': (args: { connectionId: string; schemas?: string[] }) => SchemaSnapshot;
  /// Names only, across every visible schema — the cheap query behind
  /// cross-schema completion.
  'conn:listTables': (connectionId: string) => Array<{
    schema: string; table: string; kind: 'table' | 'view' | 'matview';
  }>;
  'conn:listSchemas': (connectionId: string) => string[];
  'conn:useSchema': (args: { connectionId: string; name: string }) => void;

  /// `origin` has no 'ai' member, and there is no second execute channel.
  /// That is how "AI never auto-executes" is enforced structurally rather
  /// than by convention — see src/main/aiNeverExecutes.test.ts.
  'query:run': (args: { connectionId: string; sql: string; origin: QueryOrigin }) => { runId: string };
  'query:ack': (args: { connectionId: string; runId: string; seq: number }) => void;
  'query:cancel': (args: { connectionId: string; runId: string }) => void;
  /// EXPLAIN, returned raw for the renderer to normalize. Not an execute
  /// channel: it plans a statement, it does not run it.
  'query:explain': (args: { connectionId: string; sql: string; analyze: boolean }) => {
    format: 'json' | 'text';
    plan: string;
  };

  /// Which AI CLIs are installed. The whole AI surface hides when none are.
  'ai:detect': () => { claude: boolean; codex: boolean; gemini: boolean };
  /// Ask a question about the connected database. Returns PROSE plus any SQL
  /// it proposed — note there is no way to run that SQL from here: the only
  /// execute channel is `query:run`, whose origin union has no 'ai' member.
  'ai:ask': (args: {
    connectionId: string;
    tool: 'claude' | 'codex' | 'gemini';
    mode: 'ask' | 'sql' | 'explain' | 'fix';
    /// Required for mode 'fix': the statement that failed and what the
    /// server said about it.
    failingSql?: string;
    errorText?: string;
    question: string;
    editorText?: string;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  }) => {
    ok: boolean;
    message: string;
    sql: string | null;
    contextTables: string[];
    totalTables: number;
    error?: string;
  };
}

/// Pushed from main to the renderer over the single `main:event` channel.
export type MainToRendererEvent =
  | { kind: 'query:chunk'; runId: string; seq: number; columns?: ColumnMeta[]; rows: Cell[][] }
  | { kind: 'query:done'; runId: string; rowCount: number; truncated: boolean }
  | { kind: 'query:error'; runId: string; message: string }
  | { kind: 'fanout:progress'; envSetId: string; outcome: FanoutOutcome };
