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
  transactions: { committed: number; rolledBack: number } | null;
  /// Replication lag in bytes, per replica, when visible.
  replication: Array<{ client: string | null; state: string | null; lagBytes: number | null }>;
  /// What this server would not say, and why. Shown rather than swallowed —
  /// "you need pg_stat_statements" is a more useful answer than a blank
  /// panel.
  notes: string[];
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
    replication: [],
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

export function readings(health: HealthSnapshot): Reading[] {
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

  if (health.transactions) {
    const { committed, rolledBack } = health.transactions;
    const total = committed + rolledBack;
    const ratio = total > 0 ? rolledBack / total : 0;
    out.push({
      key: 'rollbacks',
      label: 'Rollback rate',
      value: `${(ratio * 100).toFixed(1)}%`,
      tone: ratio > 0.1 ? 'bad' : ratio > 0.02 ? 'watch' : 'good',
      note:
        ratio > 0.1
          ? 'More than one transaction in ten is failing. Something is erroring in a loop.'
          : ratio > 0.02
            ? 'A noticeable share of transactions roll back.'
            : 'Almost everything commits.',
    });
  }

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

/// The four readings that get a chart, in the order they are drawn.
///
/// Not a styling decision. These are the four a server can be in trouble
/// over in a way a single number hides: a connection count means nothing
/// without its ceiling, a ratio means nothing without the band it moves
/// in, and a size means nothing without the split between the rows you
/// keep and the indexes you pay for. Everything else `readings()` produces
/// is a count that is either zero or interesting, and a count reads fine
/// as a count.
const CHARTED = ['connections', 'cache', 'rollbacks', 'size'] as const;

/// Split the readings into the ones drawn as cards and the ones drawn as a
/// strip of counts.
///
/// Order is preserved within each half, and a charted reading the server
/// withheld simply does not appear — the caller must not assume four.
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
