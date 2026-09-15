import type { Engine } from './engines';

/// What the server says about itself, right now.
///
/// The distinction that makes this pane worth building: `slowQueries.ts`
/// answers "what is expensive here" from the server's aggregated history.
/// This answers "what is happening here" — who is connected, what they are
/// waiting on, how much room is left, and which of the things you were told
/// to keep an eye on has moved. Both read catalog and statistics views
/// only; neither touches a row of anyone's data.
///
/// Every field is nullable, and that is load-bearing. A managed Postgres
/// hides `pg_stat_replication` from non-superusers; MySQL's
/// `performance_schema` can be off; SQLite has no sessions at all because
/// it has no server. A dashboard that renders 0% where it should say "this
/// server would not tell me" is worse than one that shows nothing: the
/// first is a wrong reading, the second is a missing one. So anything
/// unavailable arrives as null with a sentence in `notes` saying why.

export interface Session {
  /// The server's own handle for it — a Postgres pid, a MySQL thread id.
  /// Stringified because MySQL's is a bigint.
  id: string;
  user: string | null;
  /// The `application_name` / connection attribute, when the client set one.
  application: string | null;
  clientAddress: string | null;
  database: string | null;
  /// 'active', 'idle', 'idle in transaction', … verbatim from the server.
  state: string | null;
  /// What it is blocked on, when the server says. This is the field that
  /// turns "the database is slow" into "sixty sessions are waiting on one
  /// lock held by that one".
  waitEvent: string | null;
  /// The statement, normalized only in that the server may truncate it.
  query: string | null;
  /// How long the current statement — or the idle period — has been going.
  seconds: number | null;
  /// True for overdb's own connection. Offering to kill the session you are
  /// reading the list through is a trap worth removing.
  isSelf: boolean;
  /// Session ids holding a lock this one wants. Postgres only.
  blockedBy: string[];
}

export interface TableSize {
  schema: string;
  table: string;
  /// Heap/data bytes, excluding indexes.
  bytes: number;
  indexBytes: number | null;
  /// The planner's estimate, not a count — counting rows on every table of
  /// a large database to fill a dashboard would be its own outage.
  estimatedRows: number | null;
}

export interface IndexUsage {
  schema: string;
  table: string;
  index: string;
  scans: number;
  bytes: number | null;
  unique: boolean;
}

export interface ScanRatio {
  schema: string;
  table: string;
  sequentialScans: number;
  sequentialRowsRead: number;
  indexScans: number;
  estimatedRows: number | null;
}

/// A panel an engine fills in for itself.
///
/// The fixed fields of this snapshot are the questions every server-shaped
/// engine answers the same way — who is connected, how much room is left,
/// which tables are biggest. The rest is not shared and pretending it is
/// produces the worst of both: a Postgres field left null on Redshift
/// where the real answer is a different fact entirely (nothing is
/// "unused index" on a database with no indexes; what bites you there is
/// a table that has gone unsorted), and a renderer that grows a switch on
/// engine and has to be edited to add one.
///
/// So an adapter describes its own panels and the pane draws them without
/// knowing what it is drawing. Rows are deliberately the shape every card
/// on this screen already has: a name, an optional second line, a number,
/// and a bar when there is a ratio worth seeing.
export interface HealthPanel {
  key: string;
  title: string;
  rows: HealthPanelRow[];
  /// The sentence under the rows. The same rule as everywhere in this
  /// file: a number with nothing next to it is a number nobody acts on.
  note?: string;
  /// Shown in place of the rows when there are none, for a panel worth
  /// keeping on screen to say that nothing is wrong.
  empty?: string;
}

export interface HealthPanelRow {
  label: string;
  /// A second, quieter line — what the number is measured against, or
  /// where the row came from.
  sub?: string;
  value: string;
  /// 0..1, drawn as a bar. Omitted where a bar would imply a comparison
  /// that is not there.
  ratio?: number;
  tone?: ReadingTone;
}

export interface HealthSnapshot {
  engine: Engine;
  capturedAt: string;
  serverVersion: string | null;
  /// Seconds since the server started, when it will say.
  uptimeSeconds: number | null;
  sessions: Session[];
  /// Sessions in use against the server's ceiling. The number people
  /// actually get paged for.
  connections: { used: number; max: number | null; reservedForSuperuser?: number | null } | null;
  /// Proportion of block reads served from cache, 0..1. Null when the
  /// server does not expose it.
  cacheHitRatio: number | null;
  /// Bytes of the current database, when the engine has such a thing.
  databaseBytes: number | null;
  /// Biggest tables first. Capped by the caller.
  tables: TableSize[];
  /// Indexes the planner has never chosen. Cost paid on every write for
  /// nothing.
  unusedIndexes: IndexUsage[];
  /// Tables the planner keeps reading end to end.
  sequentialScans: ScanRatio[];
  /// Transactions committed vs rolled back since the counters were reset.
  /// Cumulative — `pushTxnSample` and `txnWindow` turn reads of it into a
  /// rate.
  transactions: { committed: number; rolledBack: number } | null;
  /// Where work is queuing, as far as SQL can see. Null where the engine
  /// has no such thing or would not say.
  pressure: Pressure | null;
  /// Replication lag in bytes, per replica, when visible.
  replication: Array<{ client: string | null; state: string | null; lagBytes: number | null }>;
  /// Panels this engine describes for itself — the facts that have no
  /// equivalent on the others. Drawn after the built-in cards, in order.
  panels: HealthPanel[];
  /// What this server would not say, and why. Shown rather than swallowed —
  /// "you need pg_stat_statements" is a more useful answer than a blank
  /// panel.
  notes: string[];
}

/// How much of the dashboard to read.
///
/// The two halves cost wildly different amounts, and the difference is not
/// a matter of degree. `pulse` is what changes between one second and the
/// next — who is connected, what they are waiting on, the cache and
/// rollback counters, how far behind the replicas are — and every one of
/// those is a view the server keeps in memory. `full` adds the storage
/// half: table sizes, unused indexes, scan counts, each of which stats a
/// file per relation or walks a statistics table with a row per object.
///
/// That is what makes a one-second refresh defensible: it reads the pulse
/// and nothing else. A poll that walked every relation every second would
/// be the load, and it would show up in the slow-query pane next door.
export type HealthScope = 'full' | 'pulse';

/// Lay a pulse reading over the last full one.
///
/// The storage fields of a pulse snapshot are empty because it did not ask,
/// and everywhere else in this file an empty list means "there is nothing
/// here". Confusing the two would blank the size and index panels on every
/// fast tick. So the last measured storage reading is carried forward, and
/// the pane captions it with when it was actually taken — a number from a
/// minute ago, said to be from a minute ago, beats one that flickers.
export function mergePulse(previous: HealthSnapshot, pulse: HealthSnapshot): HealthSnapshot {
  const notes = [...pulse.notes];
  // Whatever the storage half had to say about itself — a missing
  // permission, an estimate warning — belongs with the rows it is about,
  // which are the rows being carried forward.
  for (const note of previous.notes) if (!notes.includes(note)) notes.push(note);
  return {
    ...pulse,
    databaseBytes: pulse.databaseBytes ?? previous.databaseBytes,
    tables: previous.tables,
    unusedIndexes: previous.unusedIndexes,
    sequentialScans: previous.sequentialScans,
    // A panel is whatever its adapter made it, and an adapter that had
    // nothing to say on a pulse did not measure it again rather than
    // finding it empty.
    panels: pulse.panels.length > 0 ? pulse.panels : previous.panels,
    notes,
  };
}

export function emptyHealth(engine: Engine): HealthSnapshot {
  return {
    engine,
    capturedAt: new Date().toISOString(),
    serverVersion: null,
    uptimeSeconds: null,
    sessions: [],
    connections: null,
    cacheHitRatio: null,
    databaseBytes: null,
    tables: [],
    unusedIndexes: [],
    sequentialScans: [],
    transactions: null,
    pressure: null,
    replication: [],
    panels: [],
    notes: [],
  };
}

export type ReadingTone = 'good' | 'watch' | 'bad' | 'unknown';

/// One line of the dashboard: a number, and what it means.
///
/// The interpretation lives here rather than in the view because a
/// threshold is a claim about databases, not about layout, and a claim
/// belongs somewhere it can be tested.
export interface Reading {
  key: string;
  label: string;
  value: string;
  tone: ReadingTone;
  /// Why this tone. Present even when everything is fine — "99.4% of reads
  /// came from cache" is worth reading, and a number with no sentence next
  /// to it is a number nobody acts on.
  note: string;
}

/// One read of the transaction counters, and when it was taken.
export interface TxnSample {
  at: number;
  committed: number;
  rolledBack: number;
}

/// Commits and rollbacks between two reads of the counters.
export interface TxnWindow {
  committed: number;
  rolledBack: number;
  seconds: number;
}

/// How far back the rollback rate looks.
///
/// The counters run from server start, so their ratio is a lifetime
/// average: a burst of failures from last month keeps it red long after
/// it stopped. The difference across the last few minutes is what is
/// happening now, and five is long enough that a one-second poll is not
/// judging three transactions.
export const ROLLBACK_WINDOW_MS = 5 * 60_000;

/// Below this many transactions in the window, a percentage is noise.
const TXNS_TO_JUDGE = 20;

/// Add a counter reading, keeping just enough history to span the window.
///
/// A counter that went backwards was reset — a restart, a failover, a
/// stats reset — and a difference across that would be negative nonsense,
/// so history starts again from the new reading.
export function pushTxnSample(
  samples: TxnSample[],
  transactions: HealthSnapshot['transactions'],
  at: number,
  windowMs = ROLLBACK_WINDOW_MS,
): TxnSample[] {
  if (!transactions) return samples;
  const next = { at, ...transactions };
  const last = samples[samples.length - 1];
  if (last && (next.committed < last.committed || next.rolledBack < last.rolledBack)) return [next];
  return trimToWindow([...samples, next], at, windowMs);
}

/// Keep the newest reading at or past the window's edge, so the window is
/// always the full span rather than whatever fell just inside it.
function trimToWindow<T extends { at: number }>(samples: T[], at: number, windowMs: number): T[] {
  const out = [...samples];
  while (out.length > 2 && out[1].at <= at - windowMs) out.shift();
  return out;
}

export function txnWindow(samples: TxnSample[]): TxnWindow | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    committed: last.committed - first.committed,
    rolledBack: last.rolledBack - first.rolledBack,
    seconds: (last.at - first.at) / 1000,
  };
}

/// The share of a window's transactions that rolled back, when there were
/// enough of them to mean anything.
export function windowRollbackRatio(window: TxnWindow | null): number | null {
  if (!window) return null;
  const total = window.committed + window.rolledBack;
  return total >= TXNS_TO_JUDGE ? window.rolledBack / total : null;
}

function rollbackReading(health: HealthSnapshot, window: TxnWindow | null): Reading {
  // MySQL's Com_commit and Com_rollback count the statements, so a
  // statement run under autocommit is in neither. Postgres counts every
  // transaction.
  const counted = health.engine === 'mysql' ? 'explicit COMMIT/ROLLBACK statements' : 'transactions';
  const toneOf = (ratio: number): ReadingTone => (ratio > 0.1 ? 'bad' : ratio > 0.02 ? 'watch' : 'good');
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

  if (!window) {
    const { committed, rolledBack } = health.transactions!;
    const total = committed + rolledBack;
    return {
      key: 'rollbacks',
      label: 'Rollback rate',
      value: pct(total > 0 ? rolledBack / total : 0),
      // A lifetime average is not a claim about now, so it is not coloured
      // like one.
      tone: 'unknown',
      note: `All ${counted} since the counters were last reset. The current rate shows from the next read.`,
    };
  }

  const { committed, rolledBack, seconds } = window;
  const total = committed + rolledBack;
  const span = `the last ${formatDuration(seconds)}`;
  if (total === 0) {
    return { key: 'rollbacks', label: 'Rollback rate', value: 'none', tone: 'good', note: `No ${counted} in ${span}.` };
  }
  const ratio = rolledBack / total;
  const tally = `${rolledBack.toLocaleString()} of ${total.toLocaleString()} ${counted} in ${span}`;
  if (total < TXNS_TO_JUDGE) {
    return { key: 'rollbacks', label: 'Rollback rate', value: pct(ratio), tone: 'unknown', note: `${tally} — too few to call.` };
  }
  const tone = toneOf(ratio);
  return {
    key: 'rollbacks',
    label: 'Rollback rate',
    value: pct(ratio),
    tone,
    note:
      (tone === 'bad'
        ? 'More than one in ten is failing. Something is erroring in a loop. '
        : tone === 'watch'
          ? 'A noticeable share roll back. '
          : 'Almost everything commits. ') + `${tally}.`,
  };
}

/// Where the server is short of room, read without leaving SQL.
///
/// Every field is a view the server keeps in memory, so all of it rides the
/// pulse. CPU and memory are missing on purpose: no SQL connection can see
/// the host, and the only thing that can is the cloud provider's metrics.
export interface Pressure {
  /// Statements executing right now, our own read excluded.
  running: number;
  /// Sessions waiting on a lock right now.
  lockWaits: number | null;
  /// Age of the oldest open transaction.
  oldestTransactionSeconds: number | null;
  /// InnoDB's history list length: row versions kept because an open
  /// transaction might still read them. MySQL only.
  undoBacklog: number | null;
  /// Lifetime counters. Reads of them become rates.
  counters: PressureCounters;
}

/// `work` is queries on MySQL and transactions on Postgres — whichever the
/// server counts.
export type PressureCounters = Partial<Record<'work' | 'tempToDisk' | 'refused' | 'deadlocks', number>>;

export interface CounterSample {
  at: number;
  values: PressureCounters;
}

/// Short enough that a rate reads as now, long enough that a one-second
/// poll is not dividing by one.
export const PRESSURE_WINDOW_MS = 60_000;

/// Add a counter reading. Any counter that went backwards means a reset,
/// and history starts again.
export function pushCounterSample(
  samples: CounterSample[],
  values: PressureCounters | null,
  at: number,
  windowMs = PRESSURE_WINDOW_MS,
): CounterSample[] {
  if (!values) return samples;
  const next = { at, values };
  const last = samples[samples.length - 1];
  const reset =
    last &&
    (Object.keys(values) as Array<keyof PressureCounters>).some((k) => {
      const before = last.values[k];
      return before !== undefined && values[k]! < before;
    });
  if (reset) return [next];
  return trimToWindow([...samples, next], at, windowMs);
}

/// Per-second rates across the samples, for the counters both ends have.
export function counterRates(samples: CounterSample[]): PressureCounters | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  if (seconds <= 0) return null;
  const out: PressureCounters = {};
  for (const k of Object.keys(last.values) as Array<keyof PressureCounters>) {
    const before = first.values[k];
    if (before !== undefined) out[k] = (last.values[k]! - before) / seconds;
  }
  return out;
}

/// One line under the pressure card, and the phrase it contributes to the
/// card's note when it is the reason for the tone.
export interface PressureFact {
  key: string;
  label: string;
  value: string;
  tone: ReadingTone;
  why: string | null;
}

export function pressureFacts(health: HealthSnapshot, rates: PressureCounters | null): PressureFact[] {
  const p = health.pressure;
  if (!p) return [];
  const mysql = health.engine === 'mysql';
  const perSecond = (v: number) =>
    v === 0 ? '0' : v < 0.1 ? '<0.1' : v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString();
  const out: PressureFact[] = [];

  if (rates?.work !== undefined) {
    out.push({ key: 'work', label: mysql ? 'queries/s' : 'txns/s', value: perSecond(rates.work), tone: 'good', why: null });
  }
  if (p.lockWaits !== null) {
    const w = p.lockWaits;
    out.push({
      key: 'locks',
      label: 'waiting on locks',
      value: w.toLocaleString(),
      tone: w >= 5 ? 'bad' : w > 0 ? 'watch' : 'good',
      why: w > 0 ? `${w.toLocaleString()} waiting on locks` : null,
    });
  }
  if (p.oldestTransactionSeconds !== null) {
    const s = p.oldestTransactionSeconds;
    out.push({
      key: 'oldest',
      label: 'oldest transaction',
      value: formatDuration(s),
      tone: s > 3600 ? 'bad' : s > 300 ? 'watch' : 'good',
      why: s > 300 ? `a transaction open for ${formatDuration(s)}` : null,
    });
  }
  if (p.undoBacklog !== null) {
    const u = p.undoBacklog;
    out.push({
      key: 'undo',
      label: 'undo backlog',
      value: u.toLocaleString(),
      tone: u > 1_000_000 ? 'bad' : u > 100_000 ? 'watch' : 'good',
      why: u > 100_000 ? `${u.toLocaleString()} old row versions held, slowing reads` : null,
    });
  }
  if (rates?.tempToDisk !== undefined) {
    const t = rates.tempToDisk;
    out.push({
      key: 'temp',
      label: mysql ? 'temp tables to disk/s' : 'temp files/s',
      value: perSecond(t),
      tone: t > 5 ? 'watch' : 'good',
      why: t > 5 ? 'sorts and joins spilling to disk' : null,
    });
  }
  if (rates?.deadlocks !== undefined) {
    const d = rates.deadlocks;
    out.push({
      key: 'deadlocks',
      label: 'deadlocks/s',
      value: perSecond(d),
      tone: d > 0 ? 'watch' : 'good',
      why: d > 0 ? 'deadlocks in the last minute' : null,
    });
  }
  if (rates?.refused !== undefined) {
    const r = rates.refused;
    out.push({
      key: 'refused',
      label: 'refused/s',
      value: perSecond(r),
      tone: r > 0 ? 'bad' : 'good',
      why: r > 0 ? 'connections refused at max_connections' : null,
    });
  }
  return out;
}

const TONE_RANK: Record<ReadingTone, number> = { bad: 3, watch: 2, good: 1, unknown: 0 };

function pressureReading(health: HealthSnapshot, rates: PressureCounters | null): Reading {
  const flagged = pressureFacts(health, rates)
    .filter((f) => f.why !== null)
    .sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
  const why = flagged.map((f) => f.why).join('; ');
  return {
    key: 'pressure',
    label: 'Pressure',
    value: `${health.pressure!.running.toLocaleString()} running`,
    // Running statements alone never set the tone: whether twelve is a lot
    // depends on the host's cores, which SQL cannot see.
    tone: flagged[0]?.tone ?? 'good',
    note:
      why !== ''
        ? `${why[0].toUpperCase()}${why.slice(1)}.`
        : 'Nothing waiting on locks or held open long. Compare running statements with the instance’s vCPUs.',
  };
}

/// What `readings()` needs beyond one snapshot: the change across recent
/// reads. Without it — the first read — the rollback rate is the lifetime
/// figure, said to be, and pressure has no rates.
export interface ReadingContext {
  txns?: TxnWindow | null;
  rates?: PressureCounters | null;
}

export function readings(health: HealthSnapshot, context: ReadingContext = {}): Reading[] {
  const out: Reading[] = [];

  if (health.connections) {
    const { used, max } = health.connections;
    const ratio = max ? used / max : null;
    out.push({
      key: 'connections',
      label: 'Connections',
      value: max ? `${used} of ${max}` : String(used),
      tone: ratio === null ? 'unknown' : ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'watch' : 'good',
      note:
        ratio === null
          ? 'The server did not report a ceiling.'
          : ratio > 0.9
            ? 'Near the ceiling. New connections will start being refused.'
            : ratio > 0.7
              ? 'Filling up. A connection pool that grows under load will hit the ceiling before you do.'
              : 'Plenty of room.',
    });
  }

  if (health.cacheHitRatio !== null) {
    const pct = health.cacheHitRatio;
    out.push({
      key: 'cache',
      label: 'Cache hit ratio',
      value: `${(pct * 100).toFixed(1)}%`,
      tone: pct >= 0.99 ? 'good' : pct >= 0.95 ? 'watch' : 'bad',
      note:
        pct >= 0.99
          ? 'Nearly every read came from memory.'
          : pct >= 0.95
            ? 'Some reads are going to disk. Worth watching if it keeps falling.'
            : 'Most of the working set does not fit in memory — the commonest cause of a database that got slow without the queries changing.',
    });
  }

  const idleInTransaction = health.sessions.filter(
    (s) => (s.state ?? '').startsWith('idle in transaction') && (s.seconds ?? 0) > 60,
  );
  if (health.sessions.length > 0) {
    out.push({
      key: 'idle-in-txn',
      label: 'Idle in transaction',
      value: String(idleInTransaction.length),
      tone: idleInTransaction.length > 0 ? 'bad' : 'good',
      note:
        idleInTransaction.length > 0
          ? 'A session holding a transaction open and doing nothing holds its locks too, and blocks vacuum. This is usually an application that forgot to commit.'
          : 'No session is sitting on an open transaction.',
    });
  }

  const blocked = health.sessions.filter((s) => s.blockedBy.length > 0);
  if (blocked.length > 0) {
    out.push({
      key: 'blocked',
      label: 'Blocked sessions',
      value: String(blocked.length),
      tone: 'bad',
      note: `Waiting on locks held by ${new Set(blocked.flatMap((s) => s.blockedBy)).size} other session(s).`,
    });
  }

  const longest = health.sessions
    .filter((s) => s.state === 'active' && !s.isSelf)
    .reduce<number>((max, s) => Math.max(max, s.seconds ?? 0), 0);
  if (health.sessions.length > 0) {
    out.push({
      key: 'longest',
      label: 'Longest running',
      value: longest > 0 ? formatDuration(longest) : 'none',
      tone: longest > 300 ? 'bad' : longest > 60 ? 'watch' : 'good',
      note:
        longest > 300
          ? 'Something has been running for over five minutes.'
          : longest > 60
            ? 'One statement has been going for more than a minute.'
            : 'Nothing has been running long.',
    });
  }

  if (health.transactions) out.push(rollbackReading(health, context.txns ?? null));
  if (health.pressure) out.push(pressureReading(health, context.rates ?? null));

  if (health.databaseBytes !== null) {
    out.push({
      key: 'size',
      label: 'Database size',
      value: formatBytes(health.databaseBytes),
      tone: 'good',
      note: 'Total on-disk size, indexes included.',
    });
  }

  const laggards = health.replication.filter((r) => (r.lagBytes ?? 0) > 64 * 1024 * 1024);
  if (health.replication.length > 0) {
    out.push({
      key: 'replication',
      label: 'Replicas',
      value: String(health.replication.length),
      tone: laggards.length > 0 ? 'watch' : 'good',
      note:
        laggards.length > 0
          ? `${laggards.length} replica(s) more than 64 MB behind. A read from one of those is reading the past.`
          : 'All replicas are keeping up.',
    });
  }

  return out;
}

/// The readings that get a chart, in the order they are drawn.
///
/// Not a styling decision. These are the ones a server can be in trouble
/// over in a way a single number hides: a connection count means nothing
/// without its ceiling, a ratio means nothing without the band it moves
/// in, running statements mean nothing without their trend, and a size
/// means nothing without the split between the rows you keep and the
/// indexes you pay for. Everything else `readings()` produces
/// is a count that is either zero or interesting, and a count reads fine
/// as a count.
const CHARTED = ['connections', 'cache', 'rollbacks', 'pressure', 'size'] as const;

/// Split the readings into the ones drawn as cards and the ones drawn as a
/// strip of counts.
///
/// Order is preserved within each half, and a charted reading the server
/// withheld simply does not appear — the caller must not assume how many.
export function splitReadings(rows: Reading[]): { charted: Reading[]; counts: Reading[] } {
  const charted: Reading[] = [];
  const counts: Reading[] = [];
  for (const key of CHARTED) {
    const row = rows.find((r) => r.key === key);
    if (row) charted.push(row);
  }
  for (const row of rows) {
    if (!CHARTED.includes(row.key as (typeof CHARTED)[number])) counts.push(row);
  }
  return { charted, counts };
}

/// How the connected sessions divide up, right now.
///
/// The four buckets are ordered by how much they should worry you, and
/// they are exclusive: a session blocked on a lock is counted as blocked
/// and not also as active, because the interesting fact about it is what
/// it is waiting for, not that the server calls it running.
///
/// `idle` is nearly always the largest, and that is the honest picture of
/// a connection pool rather than a rendering problem to correct — a pool
/// whose sessions are mostly busy is a pool that is about to run out.
export function sessionStates(health: HealthSnapshot): {
  active: number;
  idleInTransaction: number;
  blocked: number;
  idle: number;
  total: number;
  /// Everything that is not plain idle — the number worth putting next to
  /// the connection count, because it is the one that moves.
  awake: number;
} {
  let active = 0;
  let idleInTransaction = 0;
  let blocked = 0;
  let idle = 0;

  for (const s of health.sessions) {
    const state = s.state ?? '';
    if (s.blockedBy.length > 0) blocked++;
    else if (state.startsWith('idle in transaction')) idleInTransaction++;
    else if (state === 'idle') idle++;
    else active++;
  }

  const total = health.sessions.length;
  return { active, idleInTransaction, blocked, idle, total, awake: total - idle };
}

/// What the sessions are waiting on, commonest first.
///
/// A count of who is in each state at this instant — NOT time spent, which
/// neither engine will hand a client without the wait-event summary tables
/// most managed servers leave off. Said plainly in the pane rather than
/// implied by a bar, because a bar that looks like a duration and is not
/// one is the kind of chart that gets somebody paged for the wrong thing.
///
/// Sessions the server reports no wait for are omitted rather than
/// bucketed as "none": they are not waiting, and a row saying so would be
/// the largest bar on a healthy server.
export function waitEvents(health: HealthSnapshot, limit = 8): Array<{
  event: string;
  count: number;
  /// Whether this particular wait is one to act on. Lock waits are; a
  /// daemon sitting on an empty queue is not.
  blocking: boolean;
}> {
  const counts = new Map<string, { count: number; blocking: boolean }>();
  for (const s of health.sessions) {
    const event = s.waitEvent?.trim();
    if (!event) continue;
    const blocking = s.blockedBy.length > 0 || /lock/i.test(event);
    const prev = counts.get(event);
    if (prev) {
      prev.count++;
      prev.blocking = prev.blocking || blocking;
    } else {
      counts.set(event, { count: 1, blocking });
    }
  }
  return [...counts.entries()]
    .map(([event, v]) => ({ event, count: v.count, blocking: v.blocking }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event))
    .slice(0, limit);
}

/// Append a sample to a fixed-length history, oldest first.
///
/// The server keeps no history of any of this — every read is a snapshot —
/// so the only honest series is the one built out of the reads this pane
/// has already made. That is why every sparkline drawn from it is captioned
/// with when the pane opened: it is not the last hour, it is however long
/// you have been looking.
export function pushSample(series: number[], value: number | null, cap = 120): number[] {
  if (value === null || !Number.isFinite(value)) return series;
  const next = series.length >= cap ? series.slice(series.length - cap + 1) : series.slice();
  next.push(value);
  return next;
}

/// Indexes worth removing, and what removing them buys.
///
/// Never phrased as an instruction. An index with zero scans on THIS server
/// may be the one that carries the nightly job, or may have been created an
/// hour ago; the counter says what the planner has done since the stats
/// were last reset, and nothing more. Saying that plainly is the difference
/// between a useful list and a dangerous one.
export function unusedIndexSummary(health: HealthSnapshot): string | null {
  const real = health.unusedIndexes.filter((ix) => !ix.unique);
  if (real.length === 0) return null;
  const bytes = real.reduce((sum, ix) => sum + (ix.bytes ?? 0), 0);
  return `${real.length} index${real.length === 1 ? '' : 'es'} the planner has not chosen once${
    bytes > 0 ? `, holding ${formatBytes(bytes)}` : ''
  }. That is a cost on every write — but the counter only covers the window since these statistics were reset, so check before dropping anything.`;
}

/// Tables the planner reads end to end, worst first.
///
/// A sequential scan is not a problem by itself: on a small table it is the
/// right plan, which is why this is ranked by rows read rather than by scan
/// count, and why tiny tables are excluded outright.
export function seqScanOffenders(health: HealthSnapshot, minRows = 5_000): ScanRatio[] {
  return health.sequentialScans
    .filter((s) => s.sequentialScans > 0 && (s.estimatedRows ?? 0) >= minRows)
    .sort((a, b) => b.sequentialRowsRead - a.sequentialRowsRead)
    .slice(0, 20);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/// Whether killing a session is even a thing on this engine, and what the
/// two verbs mean here.
///
/// Cancel stops the statement and leaves the connection; terminate closes
/// the connection and rolls back whatever it was doing. They are different
/// enough that offering one button for both would be a bug.
export function killSupport(engine: Engine): {
  cancel: boolean;
  terminate: boolean;
  note: string | null;
} {
  switch (engine) {
    case 'postgres':
      return { cancel: true, terminate: true, note: null };
    case 'mysql':
      return { cancel: true, terminate: true, note: null };
    case 'sqlite':
      return {
        cancel: false,
        terminate: false,
        note: 'SQLite has no server and no sessions — there is nothing to kill.',
      };
    default:
      return {
        cancel: false,
        terminate: false,
        note: 'This engine does not expose sessions over its client protocol.',
      };
  }
}
