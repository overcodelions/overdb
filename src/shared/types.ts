// The shared contract: every type that crosses a process boundary, plus
// the two maps that define the renderer ↔ main seam.
//
// One rule governs this file: **no type here carries a credential.** A
// `Connection` holds a `secretRef` — a key into the main-process secret
// store — and never a password. The renderer receives `Connection`s, so
// anything added here is, by construction, something the renderer may
// see. `src/main/secretsNeverCrossIpc.test.ts` enforces the same rule on
// IPC return types.

/// The three CLIs overdb can drive. Named once: it indexes the model
/// settings, so a union spelled out per call site drifts.
export type AiTool = 'claude' | 'codex' | 'gemini';

export type { Engine, Variant } from './engines';
import type { HandoffDraft } from './overcliHandoff';
import type { Engine, Variant } from './engines';
import type { FormatStyle } from './formatSql';
// Type-only, and slowQueries.ts imports `Cell` back from here. The cycle
// is erased at compile time — neither module emits a runtime import of the
// other — but it is why both sides must stay `import type`.
import type { SlowQuerySupport, StatementStat } from './slowQueries';
import type { HealthScope, HealthSnapshot } from './health';
import type { HistoryEntry, RunRecord, SavedQuery } from './history';
import type { SshTunnel } from './sshTunnel';
import type { SeedGate } from './seedGate';
import type { SeedInvestigation, SeedScript, SeedScriptCheck } from './seedSql';
import type { BaselineRecipe, FindRequest, TableStat } from './baseline';
import type { BuildProgress } from './baselineBuild';
import type { BaselineRecord, HelperStatus, ProxyClient, ProxyConfig, ProxyState, ProxyTarget, TicketState } from './instances';
export type { SshTunnel } from './sshTunnel';
export type { FormatStyle } from './formatSql';
export type { HistoryEntry, RunRecord, SavedQuery } from './history';
export type { ParamBinding, ParamScope, ParamSlot, ParamType } from './params';
import type { ParamBinding } from './params';

/// Drives more than a label: statement-timeout defaults, whether writes
/// need arming, and how loudly the UI shouts before a mutation.
/// Ordered the way work flows, and that order is load-bearing: it is the
/// order the sidebar renders, which puts prod at the bottom where it is
/// hardest to click by accident.
export type EnvKind = 'local' | 'dev' | 'sandbox' | 'staging' | 'prod' | 'other';

/// 'require' encrypts and checks nothing; 'verify-ca' checks the
/// certificate chain but not the hostname, which is what a private CA plus
/// a CNAME or an IP endpoint needs; 'verify-full' checks both.
export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/// Where the password comes from.
///
/// 'none' covers trust auth and unix-socket logins, which are the common
/// case for a local database and should not require inventing a password.
/// 'command' is the escape hatch that makes every other secret manager
/// work — Vault, Secrets Manager, `pass`, an internal wrapper — without
/// overdb needing to know about any of them. 'aws-iam' is not a stored
/// secret at all: it mints a short-lived token per connection.
export type SecretSource = 'none' | 'stored' | 'env' | 'op' | 'command' | 'aws-iam';

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  /// What the server actually is, as opposed to which driver talks to it.
  /// Absent until the connection has been opened once (or imported from a
  /// source that names its driver), which is why every reader falls back to
  /// `engine`. See src/shared/engines.ts.
  variant?: Variant;
  env: EnvKind;
  /// Network engines. Absent for sqlite.
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /// sqlite only — absolute path to the database file.
  file?: string;
  /// dynamodb: the region is the namespace a table name is unique within,
  /// so it plays the role `database` plays elsewhere. With `secretSource`
  /// 'aws-iam' it is the region the auth token is signed for — normally
  /// left blank, because an RDS endpoint names its own region.
  region?: string;
  /// A named AWS profile, for dynamodb and for 'aws-iam'. Credentials
  /// themselves come from the AWS provider chain and are never copied into
  /// overdb's store — which is the point of both features.
  awsProfile?: string;
  /// Which table names this connection shows, as prefixes or globs — see
  /// src/shared/tableFilter.ts. DynamoDB has no schema to separate sandbox
  /// tables from production ones, so the naming convention is the only
  /// namespace there is and this is how you tell overdb about it.
  ///
  /// Narrows browsing and AI context. NOT a boundary: a filtered-out table
  /// is still queryable by naming it, and IAM is what actually limits these
  /// credentials.
  tableFilter?: string;
  ssl?: SslMode;
  defaultSchema?: string;
  /// Tables the user pinned into every AI prompt for this connection,
  /// qualified `schema.table`.
  ///
  /// Automatic selection scores table names against the question, which is
  /// the right default — you should not have to know your own schema to ask
  /// about it. But it is a guess, and a guess with no override is why "I
  /// don't see an events table" is a dead end. A pin is unconditional: it
  /// goes in whether or not it scored, and it forces the table's shape to be
  /// loaded even when a describe budget skipped it.
  pinnedTables?: string[];
  /// Schemas folded out of the table explorer for this connection, by name.
  ///
  /// A big MySQL host is 26 schemas of which you work in two, and the other
  /// 24 are not a list you scroll past — they are noise you already know
  /// you do not want. Persisted per connection because which ones matter is
  /// a durable fact about the server, not about this session.
  ///
  /// A display filter, like tableFilter: a hidden schema is still queryable
  /// by naming it, and hiding one does not change what the AI is told.
  hiddenSchemas?: string[];
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
  /// Where to look for `secretEnvVar` when it is not in overdb's own
  /// environment: the path to a `.env`-style file.
  ///
  /// This exists because the environment source has one real weakness — an
  /// app launched from the Dock does not inherit your shell — and the
  /// value is nearly always sitting in a file two directories away. Only
  /// the PATH is stored; the file is read in main at connect time and the
  /// value is never returned to the window.
  secretEnvFile?: string;
  /// A 1Password reference (`op://vault/item/field`), resolved by shelling
  /// out to `op` at connect time using your existing session. Storing the
  /// reference rather than the value means the secret never enters
  /// overdb's store at all — strictly better than copying it in.
  secretCommand?: string;
  /// A command whose stdout is the password, stored as ARGV rather than as
  /// a command line — `['vault', 'kv', 'get', '-field=password', 'db/prod']`.
  ///
  /// argv and not a string because overdb spawns it directly with no shell.
  /// A shell string in a config file that can be imported, synced or
  /// hand-edited is arbitrary code execution with a `$(...)` in it; argv
  /// has nothing to interpret. src/shared/argv.ts does the splitting and
  /// refuses shell syntax rather than passing it through as a literal.
  secretArgv?: string[];
  /// Trust anchor and client identity for TLS, as paths on this machine.
  ///
  /// Paths rather than contents, deliberately: a private key pasted into
  /// overdb's store is a copy of the most sensitive file on the disk, and
  /// these are read by the connection host at connect time and never held
  /// anywhere else. `sslRootCert` is what makes verify-full work against a
  /// private CA; `sslCert`/`sslKey` are how CockroachDB and mutual-TLS
  /// Postgres identify you INSTEAD of a password.
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  /// Reach the database through an SSH bastion. See src/shared/sshTunnel.ts:
  /// overdb drives the system `ssh` binary, so your ssh_config and agent
  /// apply and no private key is ever handled here.
  tunnel?: SshTunnel;
  /// Writes are off until you say otherwise, per connection. Persisted,
  /// because "this is my local scratch database" is a durable fact — but
  /// turning it on for a prod connection asks you to type its name first.
  writesEnabled?: boolean;
  /// 'auto' commits each write on its own; 'manual' holds one transaction
  /// open across statements so you can look before committing.
  txnMode?: 'auto' | 'manual';
  /// Floats to the Pinned section. Deliberate rather than automatic: a
  /// most-recent list reorders under you, and muscle memory needs the row
  /// to stay where you left it.
  pinned?: boolean;
  color?: string;
  lastOpenedAt?: string;
  /// Opt-in exposure to `overdb serve --mcp` (v0.3). Off by default:
  /// handing an agent a prod connection should be a deliberate act.
  mcpExposed?: boolean;
  /// The repo(s) holding the code that talks to this database, for handing
  /// a finding to overcli. Only used when the connection is in no env set —
  /// a set's link covers all its members. See src/shared/overcliHandoff.ts.
  repoPaths?: string[];
  /// Which schemas each linked repo's code uses, by repo path. See
  /// src/shared/repoLinks.ts.
  repoSchemas?: Record<string, string[]>;
  /// The linked repo a base recipe is saved in.
  recipeRepo?: string;
  /// A branch, or the proxy's own connection: the connection it was made
  /// from, whose repos and env set it uses.
  branchOf?: string;
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
  pinned?: boolean;
  memberIds: string[];
  baselineId: string;
  /// Which schema each member runs against, by connection id.
  ///
  /// Per member and not one value for the set, because the whole premise is
  /// that these are the same logical database in different places — and
  /// different places name it differently. `acme` locally, `acmedmsandbox`
  /// in sandbox, `acmedmstaging` in staging. One pinned name would either
  /// be wrong on most members or force every statement to be unqualified
  /// and hope each session happens to be pointed the right way.
  ///
  /// Absent for a member means "whatever that connection is already on",
  /// which is the right default and the only one that needs no setup.
  memberSchemas?: Record<string, string>;
  pinnedSchema?: string;
  /// Glob patterns for tables the drift view leaves out when only one side
  /// has them — scratch copies, backups, `tmp_*`. See DiffOptions.
  ignoreTables?: string[];
  /// What the drift view makes of a table only the baseline has. Absent
  /// means `pending`: listed as not deployed yet, not counted as drift.
  baselineOnly?: 'pending' | 'drift' | 'hide';
  archived?: boolean;
  createdAt?: string;
  archivedAt?: string;
  /// The repo(s) whose code uses this database, for handing a finding to
  /// overcli. On the set rather than each member: every env is the same
  /// codebase. See src/shared/overcliHandoff.ts.
  repoPaths?: string[];
  /// Which schemas each linked repo's code uses, by repo path: with one
  /// service per schema, reading the code means reading the right repos.
  repoSchemas?: Record<string, string[]>;
  /// The linked repo a base recipe is saved in.
  recipeRepo?: string;
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
///
/// 'seed' is a person pressing Run on a seed script they have read — the
/// same act as running it from the editor, but main holds it to more: the
/// connection must pass the seed gate again (src/shared/seedGate.ts), only
/// INSERTs and reads get through, and the first write always opens a
/// transaction, whatever the connection's own mode.
export type QueryOrigin = 'editor' | 'grid-edit' | 'saved' | 'seed';

/// How much data a seed should make. 'minimal' is one row per case the need
/// describes; 'realistic' fills around them so a list screen looks lived
/// in; 'volume' is enough to see pagination and slow paths.
export type SeedSize = 'minimal' | 'realistic' | 'volume';

/// One line of the seed flow's "what it's looking at" log. Paths and
/// patterns only — never a file's contents.
export interface SeedStep {
  kind: 'schema' | 'count' | 'read' | 'grep' | 'glob' | 'note';
  text: string;
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

/// One schema's catalog as it was last read from a connection.
export interface SavedCatalog {
  connectionId: string;
  schema: string;
  savedAt: string;
  engine: Engine;
  serverVersion: string;
  info: SchemaInfo;
}

// ---------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  sidebarVisible: boolean;
  sidebarWidth: number;
  /// Height of the SQL editor, in px. Was a fixed 34% with a 1px border —
  /// which is neither adjustable nor visibly adjustable.
  editorHeight: number;
  /// Rows fetched before the grid stops and asks. Bounded on purpose:
  /// an unbounded fetch is how a client runs the machine out of memory.
  /// 10,000 is the point where a wide table still lands in well under a
  /// second but a real result is rarely cut short.
  rowLimit: number;
  /// Which AI CLI to use, or null for "whichever is installed".
  aiTool: AiTool | null;
  /// Model used for the frequent, low-stakes calls (error repair, short
  /// completions). Empty means "the CLI's own default".
  /// The everyday model, per CLI. Blank means the CLI's own default, which
  /// is the right answer until you have a reason otherwise — a wrong model
  /// name is a hard error, so a guessed default would be worse than none.
  aiModel: Record<AiTool, string>;
  aiFastModel: Record<AiTool, string>;
  /// The model claude maps a database with: the standard tier. A map is
  /// read many times and written rarely, so it is worth more than the fast
  /// model, and its many passes are not worth the most capable one. Blank
  /// means claude's own default.
  aiMapModel: string;
  /// A query slower than this offers to explain itself. 0 disables.
  slowQueryMs: number;
  /// Which SQL layout Format produces. Genuinely a matter of taste, so it
  /// is a setting rather than a house style — see src/shared/formatSql.ts.
  formatStyle: FormatStyle;
  /// Whether the health and slow-query panes take the whole window.
  ///
  /// They are not answers to the statement you just ran — they are what
  /// the server is doing and what it remembers — so they do not really
  /// belong in the results half at all, and squeezed under the editor
  /// there is no room for either to say anything. On by default for that
  /// reason; the pane's own control docks it again when you want the
  /// query back in view.
  panesFull: boolean;
  /// One-time suggestions someone has closed, by id. A suggestion that comes
  /// back after "Not now" is nagging; one that never appears again after it
  /// is the deal the button offered.
  dismissedHints: string[];
  /// Where a database map is kept: overdb's own folder (the default — it
  /// stays on this machine), or `.overdb/map/` in the repo a base recipe is
  /// saved in, to share it with the team through git.
  mapLocation: 'overdb' | 'repo';
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarVisible: true,
  sidebarWidth: 260,
  editorHeight: 280,
  rowLimit: 10_000,
  aiTool: null,
  aiModel: { claude: '', codex: '', gemini: '' },
  aiFastModel: { claude: 'haiku', codex: '', gemini: '' },
  aiMapModel: 'sonnet',
  slowQueryMs: 1_000,
  formatStyle: 'default',
  panesFull: true,
  dismissedHints: [],
  mapLocation: 'overdb',
};

/// One turn of an Ask thread, as persisted.
///
/// `sql` is the statement the question was ABOUT, when there was one. The
/// slow-query nudge and the Explain button both ask a question that makes no
/// sense on its own — "Why is this slow?" — and a thread that keeps the
/// question but not the statement is unreadable an hour later.
export interface AskTurn {
  role: 'user' | 'assistant';
  text: string;
  /// Epoch millis, so a thread read tomorrow can say when.
  at: number;
  sql?: string;
  failed?: boolean;
  context?: { included: string[]; total: number };
}

export interface StoreSnapshot {
  connections: Connection[];
  groups: ConnectionGroup[];
  envSets: EnvSet[];
  settings: AppSettings;
  /// Editor contents, keyed by buffer key (src/shared/buffers.ts): a
  /// connection's id for its first tab, suffixed for the rest. A query
  /// written against one schema is usually meaningless against another, so
  /// buffers never cross connections — and they survive restarts, because
  /// losing what you were working on is not an acceptable cost of quitting.
  buffers: Record<string, string>;
  /// Where you were, as opposed to what you wrote.
  ///
  /// Kept apart from `buffers` because the two answer different questions
  /// and are written at different times — one on every keystroke, this one
  /// only when you switch tabs or schemas.
  bufferState: {
    /// Buffer key of the tab in front, per connection id.
    active: Record<string, string>;
    /// The schema each tab was last written against, per buffer key. The
    /// SERVER only has one — see `switchSchema` — so this is what the tab
    /// asks for when you come back to it, not a promise about what is
    /// currently set.
    schema: Record<string, string>;
  };
  /// Statements you have run, newest first, rolled up per statement.
  ///
  /// Durable, which is the whole point: the session log answers "what did
  /// that click just do" and is gone when you quit, and "what was that
  /// query I ran on Tuesday" is asked precisely after quitting.
  history: HistoryEntry[];
  /// Statements you named and kept. Separate from history because the line
  /// between them is intent — see src/shared/history.ts.
  savedQueries: SavedQuery[];
  /// Remembered values for the placeholders in pasted SQL, keyed by slot
  /// (src/shared/params.ts). App-wide rather than per connection, because
  /// each binding carries its OWN per-environment and per-connection
  /// overrides — "the Acme client" is one question whose answer differs by
  /// where it is asked, and splitting the library per connection would
  /// make you re-answer it everywhere.
  ///
  /// Values, not credentials: this file is handed to the renderer whole,
  /// so nothing sensitive belongs here. A password typed into a parameter
  /// box would be persisted in plain text, which is why the params bar
  /// says so rather than pretending otherwise.
  params: ParamBinding[];
  /// Ask threads, per connection id. A conversation is about one database's
  /// tables, so it belongs to that connection and not to the app.
  askThreads: Record<string, AskTurn[]>;
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
/// A connection as the form currently has it: unsaved, and possibly not
/// yet valid. Everything but the engine is optional because a draft is
/// tested WHILE it is being typed.
///
/// `password` travels renderer -> main only, the same direction as
/// `conn:setSecret`. Nothing hands one back (src/main/secretsNeverCrossIpc.test.ts).
export interface ConnectionDraft extends Partial<Omit<Connection, 'id' | 'engine'>> {
  engine: Engine;
  /// Present when editing an existing connection, so a draft whose password
  /// field was left blank can still be tested against the stored one.
  id?: string;
  /// Only when the user just typed one into the form.
  password?: string;
}

/// The outcome of a test. Carries what the SERVER said about itself — the
/// flavour and the version string — because "connected" on its own does not
/// tell you whether you reached the database you meant to.
export interface ConnectionTestResult {
  ok: boolean;
  serverVersion?: string;
  variant?: Variant;
  error?: string;
}

export interface IPCInvokeMap {
  'store:load': () => StoreSnapshot;
  'store:saveConnections': (connections: Connection[]) => void;
  'store:saveGroups': (groups: ConnectionGroup[]) => void;
  'store:saveEnvSets': (envSets: EnvSet[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;
  /// `key` is a buffer key, not a connection id — a connection has several.
  /// See src/shared/buffers.ts.
  'store:saveBuffer': (args: { key: string; text: string }) => void;
  'store:dropBuffer': (args: { key: string }) => void;
  'store:saveBufferState': (args: StoreSnapshot['bufferState']) => void;
  /// One connection's Ask thread. Written after each turn: a conversation
  /// that vanishes when the panel closes is not a conversation.
  'store:saveAskThread': (args: { connectionId: string; turns: AskTurn[] }) => void;
  /// One completed run, folded into the durable history.
  ///
  /// Main does the folding rather than taking a whole array: two windows
  /// or a fan-out finishing mid-write would otherwise race, and the loser's
  /// runs would vanish. Returns the history as it now stands.
  'store:recordRun': (run: RunRecord) => HistoryEntry[];
  'store:clearHistory': () => void;
  'store:saveQueries': (saved: SavedQuery[]) => void;
  /// The placeholder value library, replaced wholesale. Small, and rewritten
  /// only when a value is edited or forgotten.
  'store:saveParams': (params: ParamBinding[]) => void;
  'app:version': () => { app: string; electron: string; node: string; chrome: string };
  'app:openExternal': (url: string) => void;
  /// Reveal one of overdb's own log files in Finder.
  'app:showLog': (file: string) => void;
  /// Restart into an update that has finished downloading. Without this it
  /// installs at the next quit anyway. See src/main/updater.ts.
  'update:quitAndInstall': () => void;
  /// Native file picker for SQLite. The renderer cannot browse the disk
  /// itself; main returns only the chosen path.
  'app:pickSqliteFile': () => string | null;
  'app:pickFolder': () => string | null;
  /// Whether overcli can take a handoff: its inbox folder exists, which only
  /// an overcli that reads it creates. Checked, never cached for long —
  /// installing overcli mid-session should light the button up.
  'overcli:status': () => { available: boolean };
  /// Write one handoff into overcli's inbox. Main stamps it and rebuilds it
  /// from the known fields; see src/shared/overcliHandoff.ts.
  'overcli:send': (draft: HandoffDraft) => { ok: true; id: string } | { ok: false; error: string };
  /// Folder picker for linking a database to the repo that uses it.
  'overcli:pickRepo': (args: { name: string }) => string | null;
  /// The same picker, choosing several folders at once.
  'repo:pickMany': (args: { name: string }) => string[];
  /// Which of the connection's schemas a repo's code uses, by a scan of
  /// the repo: names and counts only, never contents.
  'repo:suggestSchemas': (args: { connectionId: string; path: string }) =>
    | { ok: true; schemas: string[]; suggested: string[] }
    | { ok: false; error: string };
  /// Build the sample shop database — three SQLite files, one per
  /// environment — and return where each one is. See src/main/sample.ts.
  'app:createSample': () => { local: string; staging: string; prod: string };
  /// Save something the renderer produced — a diagram, an exported result —
  /// to a file the user picks. Goes through main for the same reason the
  /// pickers do: the renderer never touches the filesystem, and a blob
  /// download would put the destination outside the user's control.
  ///
  /// `data` is text, or base64 when `encoding` says so — a PNG has no
  /// meaningful string form, and routing it as base64 keeps the channel
  /// from needing a binary type.
  'app:saveFile': (args: {
    suggestedName: string;
    data: string;
    encoding?: 'utf8' | 'base64';
    /// Extensions offered in the dialog, without dots.
    extensions?: string[];
    /// A line shown in the dialog (macOS), for what the file carries.
    message?: string;
  }) => { saved: boolean; path?: string; error?: string };
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
        user?: string; hasPassword?: boolean; ssl?: SslMode; note?: string;
      }>;
    }>;
  };
  /// Move a scanned password into the keychain without it passing through
  /// the renderer. Returns whether one was found and stored.
  'import:commit': (args: { sourceId: string; connectionId: string }) => { stored: boolean; encrypted: boolean };
  /// Whether stored credentials are actually encrypted on this machine.
  'conn:secretsEncrypted': () => { encrypted: boolean; backend: string };
  /// Clipboard goes through main: navigator.clipboard needs a secure
  /// context, and the packaged app loads from file://.
  'app:copyText': (text: string) => void;

  /// Write-only from the renderer's side. Note the absence of a getter:
  /// there is no channel that returns a credential, and
  /// src/main/secretsNeverCrossIpc.test.ts fails the build if one appears.
  'conn:setSecret': (args: { connectionId: string; value: string }) => { ok: boolean; encrypted: boolean };
  'conn:hasSecret': (connectionId: string) => boolean;
  /// Duplicating a connection: copies the stored credential from one
  /// connection's ref to another's, entirely inside main. Returns whether
  /// there was one to copy — never what it was. Without this, a duplicate
  /// would arrive with an empty password and no way to fill it in, since
  /// the renderer that asked for the copy cannot read the original.
  'conn:copySecret': (args: { fromId: string; toId: string }) => boolean;
  /// Deletes the stored credential. Called when a connection is removed,
  /// so a forgotten secret can't outlive the thing it belonged to.
  'conn:deleteSecret': (connectionId: string) => void;
  /// Resolve-and-report, for the connection form: says whether a non-stored
  /// credential source can currently produce a value, WITHOUT returning it.
  ///
  /// Every source answers here, and the answer is always a SENTENCE plus a
  /// length — never a value. That is what lets the form say "this resolves"
  /// without the window ever being able to read what it resolved to.
  'conn:probeSecret': (args: {
    source: SecretSource;
    envVar?: string;
    /// Path to a `.env`-style file to fall back to for `envVar`.
    envFile?: string;
    reference?: string;
    /// Already split (src/shared/argv.ts) — main never splits a string.
    argv?: string[];
    /// 'aws-iam' signs a token for a specific endpoint, so the probe needs
    /// to know which one. No credential goes in or out.
    host?: string;
    port?: number;
    user?: string;
    region?: string;
    profile?: string;
  }) => { ok: boolean; detail: string };
  /// Native file picker for a TLS certificate, private key or SSH identity.
  /// The renderer cannot browse the disk; main returns only the chosen path,
  /// and the file's CONTENTS are read by the connection host at connect
  /// time — they never enter the window.
  'app:pickKeyFile': (kind: 'ca' | 'cert' | 'key' | 'identity' | 'envfile') => string | null;
  /// Try a draft connection without touching any live session: main opens a
  /// throwaway host, connects, reports, and kills it. The only way to find
  /// out whether these settings work is to use them, and doing that by
  /// SAVING them means a failed guess has already replaced a working
  /// connection.
  'conn:test': (draft: ConnectionDraft) => ConnectionTestResult;
  'conn:open': (connectionId: string) => {
    ok: boolean;
    serverVersion?: string;
    error?: string;
    /// What the server reported itself to be. Persisted onto the Connection
    /// by the handler, so the sidebar is right on the next launch too.
    variant?: Variant;
  };
  'conn:close': (connectionId: string) => void;
  'conn:isOpen': (connectionId: string) => boolean;
  /// Which connections are open right now, for a window that has just
  /// loaded. State otherwise only arrives as `conn:state` pushes, and a
  /// reload has already missed every one of them.
  'conn:states': () => string[];
  'conn:introspect': (args: { connectionId: string; schemas?: string[] }) => SchemaSnapshot;
  /// The last catalog read from a connection, per schema — what drift
  /// compares against when that connection cannot be reached right now.
  /// See src/main/catalogStore.ts.
  'catalog:list': (args: { connectionId: string }) => SavedCatalog[];
  'catalog:save': (catalog: SavedCatalog) => void;
  /// What a table filter would actually select, before it is saved.
  ///
  /// A pattern language explained in prose is a guess until you try it, and
  /// the count is a better teacher than any sentence about wildcards. Names
  /// only — the same data `conn:listTables` already returns.
  'conn:previewTableFilter': (args: { connectionId: string; filter: string }) => {
    total: number;
    matched: number;
    /// A few matches, longest-name-last, purely to show the filter bit.
    sample: string[];
    error?: string;
  };
  /// Names only, across every visible schema — the cheap query behind
  /// cross-schema completion.
  'conn:listTables': (connectionId: string) => Array<{
    schema: string; table: string; kind: 'table' | 'view' | 'matview';
  }>;
  'conn:listSchemas': (connectionId: string) => string[];
  /// Returns the schema the session ACTUALLY resolves to afterwards, read
  /// back from the server. The picker renders that, not the request, so a
  /// switch that didn't take is visible instead of silent.
  'conn:useSchema': (args: { connectionId: string; name: string }) => string;
  'conn:currentSchema': (connectionId: string) => string | null;
  /// Database servers already running on this machine, identified by
  /// protocol handshake rather than by port number. No credentials are
  /// sent and nothing is authenticated — see src/main/discoverLocal.ts.
  'conn:discoverLocal': () => Array<{
    engine: Engine;
    host: string;
    port: number;
    version?: string;
    socket?: string;
  }>;
  /// Turning writes on for a prod connection requires `confirm` to equal
  /// the connection's name. Refused rather than silently ignored.
  'conn:setWrites': (args: { connectionId: string; enabled: boolean; confirm?: string }) => {
    ok: boolean;
    error?: string;
  };
  'conn:setTxnMode': (args: { connectionId: string; mode: 'auto' | 'manual' }) => void;
  'txn:commit': (connectionId: string) => { ok: boolean; error?: string };
  'txn:rollback': (connectionId: string) => { ok: boolean; error?: string };

  /// `origin` has no 'ai' member, and there is no second execute channel.
  /// That is how "AI never auto-executes" is enforced structurally rather
  /// than by convention — see src/main/aiNeverExecutes.test.ts.
  'query:run': (args: {
    connectionId: string;
    sql: string;
    /// Bound values. The only way a cell's contents reach the server: an
    /// inline edit interpolates nothing into the statement text.
    params?: unknown[];
    origin: QueryOrigin;
  }) => {
    runId: string;
    /// Whether it ran outside the read-only envelope, so the activity log
    /// can say which statements could actually change anything.
    write: boolean;
  };
  'query:ack': (args: { connectionId: string; runId: string; seq: number }) => void;
  'query:cancel': (args: { connectionId: string; runId: string }) => void;
  /// EXPLAIN, returned raw for the renderer to normalize. Not an execute
  /// channel: it plans a statement, it does not run it.
  'query:explain': (args: {
    connectionId: string;
    sql: string;
    analyze: boolean;
    /// Values for the statement's placeholders, already bound by the
    /// renderer (src/shared/params.ts). A plan of `WHERE name = ?` is not
    /// a plan of the query you meant.
    params?: unknown[];
  }) => {
    format: 'json' | 'text';
    plan: string;
  };

  /// What the SERVER remembers about statement cost — see
  /// src/shared/slowQueries.ts. Separate from `settings.slowQueryMs`, which
  /// times only the statements this session ran.
  ///
  /// Support is asked for on every pane open rather than cached in main: a
  /// GRANT takes effect on the next statement of a session that is already
  /// open, so a user who just got their privileges must not have to
  /// reconnect to see that.
  'perf:slowQuerySupport': (connectionId: string) => SlowQuerySupport;
  'perf:slowQueries': (args: { connectionId: string; limit?: number }) => StatementStat[];
  /// A real execution of one digest, literal values intact, for planning.
  /// Null is the ordinary answer — see DbAdapter.slowQueryExample — and
  /// means the Plan affordance should be absent rather than faked.
  'perf:slowQueryExample': (args: { connectionId: string; digest: string }) => string | null;
  /// Only ever called when support reported `resettable`. Refused rather
  /// than attempted otherwise — main re-checks instead of trusting the
  /// renderer's copy of the answer.
  'perf:resetSlowQueries': (connectionId: string) => { ok: boolean; error?: string };

  /// What the server says about itself right now. Reads statistics views
  /// only — no rows of anyone's data are touched, and it stays read-only
  /// on a prod connection regardless of arm state.
  /// `scope: 'pulse'` reads only the half that moves — sessions,
  /// connections, cache, replication — and skips everything that walks
  /// storage, which is what makes a one-second refresh affordable. The
  /// storage fields come back empty; lay it over the last full reading
  /// with `mergePulse`.
  'perf:health': (connectionId: string, scope?: HealthScope) => HealthSnapshot;
  /// Stop someone else's statement, or close their connection.
  ///
  /// The one perf channel that ACTS. `confirm` carries the typed
  /// connection name, which main requires for a `prod` connection — the
  /// same rule and the same reason as `conn:setWrites`: the accident worth
  /// preventing is doing exactly the right thing to the wrong server.
  'perf:killSession': (args: {
    connectionId: string;
    sessionId: string;
    /// False cancels the running statement; true closes the connection and
    /// rolls back what it held.
    terminate: boolean;
    confirm?: string;
  }) => { ok: boolean; error?: string };

  /// Seed for a ticket. See src/shared/seedGate.ts for what may be seeded
  /// and src/shared/seedSql.ts for what comes back. None of these channels
  /// runs SQL: the script is run by the window, through `query:run` with
  /// origin 'seed', after a person has read it.
  ///
  /// The gate, plus the repo the connection is linked to (the same link the
  /// overcli handoff uses), if any.
  'seed:check': (connectionId: string) => {
    gate: SeedGate | null;
    repo: string | null;
    /// The schema the session is on, which a seed starts from, and every
    /// schema it could also cover.
    schema?: string | null;
    schemas?: string[];
    error?: string;
  };
  /// Read the schema — and, with `readRepo` and claude, the code — and come
  /// back with findings and a plan in words. `revise` redoes the plan from
  /// the previous one and an instruction, without reading the code again.
  /// Progress arrives as `seed:step` events for `jobId`.
  'seed:investigate': (args: {
    jobId: string;
    connectionId: string;
    tool: AiTool;
    need: string;
    size: SeedSize;
    readRepo: boolean;
    /// Schemas the seed covers besides the session's own.
    alsoSchemas?: string[];
    /// Plan from the database map when there is one (the default).
    useMap?: boolean;
    revise?: { previous: SeedInvestigation; instruction: string };
  }) =>
    | { ok: true; investigation: SeedInvestigation; readCode: boolean; mapTables?: number }
    | { ok: false; error: string };
  /// The database map for a connection's env set (or the connection): where
  /// it is kept, what it holds, and how far the code and schemas have moved
  /// since. `status.map` null means none yet. See src/shared/dbMap.ts.
  'map:status': (connectionId: string) =>
    | {
        ok: true;
        status: {
          file: string;
          repos: number;
          map: { builtAt: string; updatedAt: string; tables: number; links: number; learned: number; unmapped: number; schemas: string[] } | null;
          freshness: import('./dbMap').MapFreshness | null;
        } | null;
      }
    | { ok: false; error: string };
  /// Map the database from its linked repos, or refresh what changed.
  /// Progress arrives as `map:progress` events for `jobId`.
  /// `rest` asks about the tables the map has nothing on, which a first
  /// map leaves out when no file names them.
  'map:build': (args: { jobId: string; connectionId: string; refresh: boolean; rest?: boolean }) =>
    | { ok: true; tables: number; links: number; dropped: number; leftOut: number; failures: string[] }
    | { ok: false; error: string };
  'map:cancel': (jobId: string) => void;
  /// The whole map, for the Map pane, the diagram and a base. Null when
  /// there is none yet.
  'map:read': (connectionId: string) => import('./dbMap').DbMap | null;
  /// The schemas a ticket's text is about, by where the map puts its tables.
  'map:schemasFor': (args: { connectionId: string; text: string }) => string[];
  /// Turn an approved plan into a seed, a teardown and a verify query, and
  /// check them against the catalog before returning. A script that fails
  /// the check is retried once with the problems named, then returned with
  /// them so the window can say what is wrong.
  'seed:write': (args: {
    jobId: string;
    connectionId: string;
    tool: AiTool;
    need: string;
    investigation: SeedInvestigation;
    alsoSchemas?: string[];
  }) => { ok: true; script: SeedScript; check: SeedScriptCheck } | { ok: false; error: string; check?: SeedScriptCheck };
  /// Stop an investigation or a write in flight. Its answer is discarded.
  'seed:cancel': (jobId: string) => void;

  /// Baseline discovery — see docs/design/baselines.md. Local connections
  /// only, and reads only: the catalog of every schema, the server's table
  /// statistics, and bounded searches for starting points. Nothing here
  /// writes to the database.
  ///
  /// The catalog and sizes, the repo the connection is linked to, and the
  /// recipe saved there before, if any.
  'baseline:discover': (connectionId: string) =>
    | {
        ok: true;
        snapshot: SchemaSnapshot;
        stats: TableStat[];
        repo: string | null;
        recipe: BaselineRecipe | null;
        recipePath: string;
        recipeError?: string;
      }
    | { ok: false; error: string };
  /// One bounded search for a starting point (at most 50 rows).
  'baseline:find': (args: { connectionId: string; req: FindRequest }) =>
    | { ok: true; rows: Cell[][] }
    | { ok: false; error: string };
  /// Distinct values of a few columns among a table's first `sample` rows:
  /// what a polymorphic type column names. Bounded both ways.
  'baseline:distinct': (args: { connectionId: string; schema: string; table: string; columns: string[]; sample: number; limit: number }) =>
    | { ok: true; rows: Cell[][] }
    | { ok: false; error: string };
  /// Count one table's rows that belong to the starting points — a single
  /// COUNT, for a size estimate that knows how big this tenant is.
  'baseline:measure': (args: { connectionId: string; schema: string; table: string; column: string; values: string[] }) =>
    | { ok: true; rows: number }
    | { ok: false; error: string };
  /// Write the recipe to the linked repo's `.overdb/baseline.json`, or to
  /// overdb's own data when there is no repo.
  'baseline:save': (args: { connectionId: string; recipe: BaselineRecipe }) =>
    | { ok: true; path: string }
    | { ok: false; error: string };
  /// Build the saved recipe into a baseline: an instance overdb starts from
  /// the mysqld on this machine, filled by a builder process that reads your
  /// server and writes only to that instance, then stopped. Progress
  /// arrives as `baseline:progress` events for `jobId`.
  'baseline:build': (args: { jobId: string; connectionId: string }) =>
    | { ok: true; baseline: BaselineRecord }
    /// `log`: the build's log file, kept when it fails.
    | { ok: false; error: string; log?: string };
  'baseline:cancelBuild': (jobId: string) => void;
  /// Read the linked repo with claude for what the schema cannot say —
  /// read-only tools, like the seed investigation. Steps arrive as
  /// `baseline:codeStep` events; the answer comes back raw for the window
  /// to check against its catalog (src/shared/baselineCode.ts).
  'baseline:readCode': (args: {
    jobId: string;
    connectionId: string;
    input: {
      tenant: string | null;
      startingPoints: string[];
      unlinkedLogins: string[];
      ambiguous: Array<{ link: string; alternatives: string[] }>;
      emptied: Array<{ table: string; reason: string }>;
    };
  }) => { ok: true; output: string } | { ok: false; error: string };
  'baseline:cancelReadCode': (jobId: string) => void;
  /// Name a baseline; a rebuild keeps the name.
  'baseline:rename': (args: { id: string; label: string }) => void;
  'baseline:instances': () => { baselines: BaselineRecord[]; tickets: TicketState[]; proxy: ProxyState };
  /// A ticket copy: a clone of a baseline, started on its own port, and the
  /// connection that reaches it — for the window to add to its list.
  'ticket:create': (args: { baselineId: string; name: string; note: string }) =>
    | { ok: true; ticket: TicketState; connection: Connection }
    | { ok: false; error: string };
  'ticket:start': (id: string) => { ok: true; ticket: TicketState } | { ok: false; error: string };
  'ticket:stop': (id: string) => void;
  /// Stops it, deletes its data, and says which connection to remove.
  'ticket:delete': (id: string) => { connectionId: string | null };
  /// A branch's connection, made again from its record — for one that went
  /// missing from the connection list. Null when its source is gone.
  'ticket:connection': (id: string) => Connection | null;
  /// The proxy: on or off, its port and socket, where your own server is.
  'proxy:configure': (next: Partial<ProxyConfig> & { enabled?: boolean }) => ProxyState;
  /// Send new connections somewhere else and close the open ones.
  'proxy:route': (target: ProxyTarget) =>
    | { ok: true; state: ProxyState & { dropped: number } }
    | { ok: false; error: string };
  'proxy:clients': () => ProxyClient[];
  /// "Services see · PROJ-123": a read-only connection to the proxy, to
  /// query what services reach. Null while the proxy is off.
  'proxy:connection': () => Connection | null;
  /// The background helper (src/helper/index.ts): whether it is installed
  /// and answering. Enabling installs a LaunchAgent and hands it the proxy
  /// and the copies; disabling removes it and takes them back.
  'helper:status': () => HelperStatus;
  'helper:enable': () => { ok: true; status: HelperStatus } | { ok: false; error: string };
  'helper:disable': () => { ok: true; status: HelperStatus } | { ok: false; error: string };

  /// Which AI CLIs are installed. The whole AI surface hides when none are.
  'ai:detect': () => { claude: boolean; codex: boolean; gemini: boolean };
  /// Ask a question about the connected database. Returns PROSE plus any SQL
  /// it proposed — note there is no way to run that SQL from here: the only
  /// execute channel is `query:run`, whose origin union has no 'ai' member.
  'ai:ask': (args: {
    connectionId: string;
    tool: 'claude' | 'codex' | 'gemini';
    /// 'refine' rewrites ONE statement to a follow-up instruction:
    /// `editorText` is the statement to change, `question` is the change.
    mode: 'ask' | 'sql' | 'explain' | 'fix' | 'faster' | 'refine';
    /// Required for mode 'fix': the statement that failed and what the
    /// server said about it.
    failingSql?: string;
    errorText?: string;
    question: string;
    editorText?: string;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
    /// Qualified `schema.table` names that must be in the prompt regardless
    /// of what the scorer thinks of them.
    pinned?: string[];
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
  | { kind: 'query:done'; runId: string; rowCount: number; affectedRows?: number | null; truncated: boolean }
  | { kind: 'query:error'; runId: string; message: string }
  /// Pushed rather than polled: main already knows which hosts are alive,
  /// and asking it once a second for twenty connections to draw a dot
  /// would be worse in every way.
  | { kind: 'conn:state'; connectionId: string; state: 'open' | 'closed' | 'error' }
  /// An open transaction is state you must not have to remember, so it is
  /// pushed — including when the idle timeout rolls it back for you.
  | { kind: 'txn:state'; connectionId: string; open: boolean; statements: number; expiresAt: number | null }
  /// A line for the seed flow's live log while a model investigates.
  | { kind: 'seed:step'; jobId: string; step: SeedStep }
  | { kind: 'map:progress'; jobId: string; repo: string | null; step: { kind: string; text: string } }
  /// A line of a baseline build's progress.
  | { kind: 'baseline:progress'; jobId: string; progress: BuildProgress }
  | { kind: 'baseline:codeStep'; jobId: string; step: SeedStep }
  /// A menu item the window has to carry out — opening a help sheet, the
  /// palette. See src/main/menu.ts.
  | { kind: 'menu'; command: MenuCommand }
  /// Auto-updater progress, for the restart prompt. See src/main/updater.ts.
  | { kind: 'update:available'; version: string }
  | { kind: 'update:progress'; percent: number }
  | { kind: 'update:downloaded'; version: string };

/// What the application menu can ask the window to do.
export type MenuCommand =
  | 'basics'
  | 'shortcuts'
  | 'about'
  | 'settings'
  | 'palette'
  | 'newConnection'
  | 'importConnections'
  | 'newEnvSet'
  | 'closeTab'
  | 'sample';
