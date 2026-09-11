// Per-statement cost, as the SERVER remembers it.
//
// Distinct from `settings.slowQueryMs`, which is a stopwatch on statements
// YOU ran in this session. This is the server's own accounting — every
// statement every client has run since the counters were last reset — and
// it is the only thing that answers "what is actually expensive here",
// because the query eating your database is rarely the one you just typed.
//
// Not log files. Neither Postgres nor MySQL will hand a client the text of
// `log_min_duration_statement` output over the wire, and the managed
// services put it behind their own APIs. What both DO expose is an
// in-memory aggregated view — pg_stat_statements and
// performance_schema.events_statements_summary_by_digest — which is
// better anyway: pre-normalized, pre-aggregated, and one cheap query.

import type { Cell } from './types';
import type { Engine, Variant } from './engines';

/// Postgres substitutes this exact string for the query text of statements
/// the current user is not allowed to see. It is not an error and not a
/// null — the row arrives with real timings and a placeholder where the
/// SQL should be, which is the single most confusing thing about reading
/// pg_stat_statements as a non-superuser.
export const PG_REDACTED = '<insufficient privilege>';

export type SlowQuerySource =
  | 'pg_stat_statements'
  | 'performance_schema';

/// One normalized statement's aggregated cost.
///
/// Deliberately NOT the union of every engine's columns — pg_stat_statements
/// has forty-odd and events_statements_summary_by_digest has sixty, and a
/// grid with sixty columns is a worse answer than the eight anyone sorts
/// by. Engine-specific extras ride in `extra`.
export interface StatementStat {
  /// Server-side identity of the normalized statement: Postgres' queryid,
  /// MySQL's DIGEST. Stable across restarts on both, which is what makes
  /// the since-you-opened-this-pane diff possible.
  digest: string;
  /// Normalized text, with literals already replaced BY THE SERVER ($1, ?).
  /// Never the raw statement with values still in it.
  sql: string;
  /// True when the server withheld the text — see PG_REDACTED. The timings
  /// on such a row are real and worth showing; only the text is missing.
  redacted: boolean;
  /// True when the server stored only the FIRST part of the statement.
  /// MySQL caps digest text at performance_schema_max_digest_length (1024
  /// bytes by default), which any ORM-generated join blows through in its
  /// first few lines — and the tail is gone from the server, not merely
  /// unrequested, so no amount of asking again returns it. Worth saying out
  /// loud: a statement that just stops mid-JOIN reads as our bug.
  truncated: boolean;
  calls: number;
  totalMs: number;
  meanMs: number;
  /// Null where the engine does not track it.
  maxMs: number | null;
  rowsReturned: number | null;
  /// The column that actually finds bad queries: a statement examining ten
  /// thousand rows to return one is the finding, and it shows up here long
  /// before it shows up in the timings.
  rowsExamined: number | null;
  /// Calls that ran without using an index. MySQL only; Postgres has no
  /// equivalent counter.
  noIndexUsed: number | null;
  extra: Record<string, Cell>;
}

/// Why per-statement cost is unavailable.
///
/// A discriminated code rather than a message, because the UI renders a
/// different affordance per case: some are one statement away from working,
/// some need a DBA, some need a server restart nobody here can perform.
/// Telling them apart is most of the value of the pane when it is empty.
export type SlowQueryUnavailable =
  /// The extension exists on this server but has not been created. One
  /// statement away, and `ddl` is that statement.
  | { code: 'not-installed'; detail: string; ddl: string }
  /// Needs shared_preload_libraries (Postgres) or a parameter group change
  /// plus a reboot (RDS/Aurora, and `managed` says so). overdb cannot do
  /// either, so it names the knob and stops — an Enable button that always
  /// fails is worse than no button.
  | { code: 'needs-restart'; detail: string; parameter: string; managed: boolean }
  /// Off, but switchable from a session. Distinct from needs-restart
  /// precisely because this one the user can fix right now.
  | { code: 'disabled'; detail: string; parameter: string; sql?: string }
  /// The read errored on privilege. `grant` is the literal statement a DBA
  /// would run, so it can be pasted into a ticket unedited.
  | { code: 'permission-denied'; detail: string; grant: string; serverMessage: string }
  /// The engine has no such thing, and no amount of configuration adds it.
  | { code: 'unsupported'; detail: string; engine: Engine }
  /// Anything else. Never swallowed: the next failure will be one nobody
  /// predicted, and the server's own words are the only clue.
  | { code: 'probe-failed'; detail: string; serverMessage: string };

export type SlowQuerySupport =
  | {
      supported: true;
      source: SlowQuerySource;
      /// Whether this user can zero the counters. False for most managed
      /// users, which is fine — the client-side baseline below covers the
      /// workflow without it.
      resettable: boolean;
      /// 'own-statements-only' is Aurora's default posture for a normal
      /// user: rows come back, timings are real, and every statement run by
      /// someone else has its text redacted. The pane still works, so this
      /// degrades to a banner rather than an empty state.
      visibility: 'all' | 'own-statements-only';
      /// The cap the server puts on stored statement text, when it has a
      /// nameable one. Null where there is nothing useful to point at, and
      /// pointing at the wrong knob is worse than pointing at none.
      textLimit: { parameter: string; bytes: number } | null;
    }
  | { supported: false; reason: SlowQueryUnavailable };

export type SlowQueryOrder = 'total' | 'mean' | 'calls';

/// Codes that can only change by reconnecting to a differently configured
/// server, so a Retry button on them is a lie. Everything else is worth
/// re-probing: a GRANT takes effect on the very next statement of a session
/// that is already open, so the user who just messaged their DBA should be
/// able to press a button rather than reconnect.
export function isRetryable(reason: SlowQueryUnavailable): boolean {
  return reason.code !== 'needs-restart' && reason.code !== 'unsupported';
}

/// MySQL appends this when it truncates DIGEST_TEXT.
///
/// Checked at the very end only. A digest legitimately ends in `(...)` —
/// that is MySQL collapsing a value list, which is normalization rather
/// than loss — and treating it as truncation would mislabel most IN
/// clauses in the pane.
export function digestTruncated(text: string): boolean {
  return /\.\.\.$/.test(text.trimEnd());
}

// ---------------------------------------------------------------------
// Probe error classification
// ---------------------------------------------------------------------
// Keyed on SQLSTATE / errno rather than message text. Messages are
// localized, and Aurora's wording differs from stock on several of these.

/// `available` is whether pg_available_extensions lists it — the thing that
/// separates "run CREATE EXTENSION" from "ask for a restart".
export function classifyPgProbeError(
  err: { code?: string; message?: string },
  ctx: { variant: Variant; available: boolean; user?: string },
): SlowQueryUnavailable {
  const serverMessage = err.message ?? String(err);
  const user = ctx.user ?? 'your_user';
  const managed = ctx.variant === 'aurora-postgres';

  switch (err.code) {
    // undefined_table — the view is not there, so the extension was never
    // created in this database.
    case '42P01':
      return ctx.available
        ? {
            code: 'not-installed',
            detail:
              'pg_stat_statements is available on this server but has not been created in this database.',
            ddl: 'CREATE EXTENSION pg_stat_statements',
          }
        : {
            code: 'needs-restart',
            detail: managed
              ? 'pg_stat_statements is not loaded. On Aurora and RDS it is enabled by adding it to shared_preload_libraries in the parameter group, which needs a reboot.'
              : 'pg_stat_statements is not loaded. It has to be listed in shared_preload_libraries, which needs a server restart.',
            parameter: 'shared_preload_libraries',
            managed,
          };

    // insufficient_privilege — the view exists and this user cannot read it.
    case '42501':
      return {
        code: 'permission-denied',
        detail: 'This user is not allowed to read pg_stat_statements.',
        grant: `GRANT pg_read_all_stats TO ${user}`,
        serverMessage,
      };

    // object_not_in_prerequisite_state — extension row present, library not
    // preloaded. Postgres says so on the read rather than on CREATE.
    case '55000':
      return {
        code: 'needs-restart',
        detail:
          'pg_stat_statements is installed but its library was not preloaded, so it is collecting nothing.',
        parameter: 'shared_preload_libraries',
        managed,
      };

    default:
      return {
        code: 'probe-failed',
        detail: 'Could not read pg_stat_statements.',
        serverMessage,
      };
  }
}

export function classifyMysqlProbeError(
  err: { errno?: number; message?: string },
  ctx: { variant: Variant; user?: string },
): SlowQueryUnavailable {
  const serverMessage = err.message ?? String(err);
  const user = ctx.user ?? 'your_user';

  switch (err.errno) {
    // 1142 tableaccess denied, 1143 columnaccess denied.
    case 1142:
    case 1143:
      return {
        code: 'permission-denied',
        detail: 'This user is not allowed to read the performance schema.',
        grant: `GRANT SELECT ON performance_schema.* TO '${user}'@'%'`,
        serverMessage,
      };

    // 1146 no such table — performance_schema compiled out entirely. No
    // parameter turns this on; it is a different build of the server.
    case 1146:
      return {
        code: 'unsupported',
        detail:
          'This server was built without the performance schema, so it keeps no per-statement history.',
        engine: 'mysql',
      };

    default:
      return {
        code: 'probe-failed',
        detail: 'Could not read performance_schema.events_statements_summary_by_digest.',
        serverMessage,
      };
  }
}

// ---------------------------------------------------------------------
// Since-you-opened-this-pane
// ---------------------------------------------------------------------

/// Subtract a baseline read from a later one, by digest.
///
/// The point of this is that a server up for forty days reports totals
/// nobody can act on: "4.2 s" against an unknown denominator says nothing
/// about whether the change you just made helped. Two reads and a
/// subtraction give the same answer `pg_stat_statements_reset()` would,
/// without needing the privilege to call it — and without stomping on
/// anyone else watching the same server.
///
/// Statements whose call count did not move are dropped: they are not what
/// "since you opened this" means. A digest absent from the baseline is kept
/// whole — it is new, and all of its cost happened in the window.
export function deltaStats(
  baseline: StatementStat[],
  current: StatementStat[],
): StatementStat[] {
  const before = new Map(baseline.map((s) => [s.digest, s]));
  const out: StatementStat[] = [];

  for (const now of current) {
    const then = before.get(now.digest);
    if (!then) {
      out.push(now);
      continue;
    }
    const calls = now.calls - then.calls;
    // Counters can also go DOWN: the server restarted, someone called
    // reset, or the statement was evicted and re-entered. A negative delta
    // is not a number to render, so the row drops out until it accumulates
    // again against the new baseline.
    if (calls <= 0) continue;
    const totalMs = Math.max(0, now.totalMs - then.totalMs);
    out.push({
      ...now,
      calls,
      totalMs,
      meanMs: totalMs / calls,
      // Max is a high-water mark, not a running total — it cannot be
      // subtracted, and reporting the all-time max inside a window that did
      // not contain it would be a lie. Nothing honest to say here.
      maxMs: null,
      rowsReturned: subtract(now.rowsReturned, then.rowsReturned),
      rowsExamined: subtract(now.rowsExamined, then.rowsExamined),
      noIndexUsed: subtract(now.noIndexUsed, then.noIndexUsed),
    });
  }
  return out;
}

function subtract(now: number | null, then: number | null): number | null {
  if (now === null) return null;
  if (then === null) return now;
  return Math.max(0, now - then);
}

/// The statements whose cost moved most, and in which direction.
///
/// Distinct from the sorted list, which answers "what is expensive": this
/// answers "what CHANGED since I started looking", which is the question
/// you actually have after deploying something or adding an index. A
/// statement that has always cost four seconds an hour is not news; one
/// that cost nothing this morning is.
///
/// Ranked by absolute change so an improvement is as visible as a
/// regression — the point of watching this pane after adding an index is
/// to see the number go down, and a list that only shows increases can
/// never show you that it worked.
export function movers(
  baseline: StatementStat[],
  current: StatementStat[],
  limit = 5,
): Array<{ stat: StatementStat; deltaMs: number }> {
  const before = new Map(baseline.map((s) => [s.digest, s]));
  const out: Array<{ stat: StatementStat; deltaMs: number }> = [];

  for (const now of current) {
    const then = before.get(now.digest);
    // A statement absent from the baseline is entirely new in the window,
    // so all of its cost is the change.
    const deltaMs = then ? now.totalMs - then.totalMs : now.totalMs;
    // Counters go down on a restart or a reset, and that is not a
    // statement getting faster — it is the denominator vanishing. Told
    // apart by the call count, which only drops for the same reason.
    if (then && now.calls < then.calls) continue;
    if (deltaMs === 0) continue;
    out.push({ stat: now, deltaMs });
  }

  return out.sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs)).slice(0, limit);
}

/// Each statement's share of the visible total, plus what is left over.
///
/// The denominator is the rows the caller can actually see, never the
/// server's whole history: a bar drawn against a total that includes rows
/// nobody is looking at is a proportion of nothing legible. `rest` is the
/// share held by everything below the cut, which is the number that tells
/// you whether fixing the top few is worth an afternoon or whether the
/// cost is spread across two hundred statements and there is no top few.
export function shares(
  rows: StatementStat[],
  visible: number,
): { shares: number[]; rest: number; totalMs: number } {
  const totalMs = rows.reduce((a, r) => a + r.totalMs, 0);
  if (totalMs <= 0) return { shares: rows.slice(0, visible).map(() => 0), rest: 0, totalMs: 0 };
  const top = rows.slice(0, visible).map((r) => r.totalMs / totalMs);
  return { shares: top, rest: Math.max(0, 1 - top.reduce((a, s) => a + s, 0)), totalMs };
}

export function sortStats(stats: StatementStat[], order: SlowQueryOrder): StatementStat[] {
  const key =
    order === 'mean' ? (s: StatementStat) => s.meanMs
    : order === 'calls' ? (s: StatementStat) => s.calls
    : (s: StatementStat) => s.totalMs;
  return [...stats].sort((a, b) => key(b) - key(a));
}

/// Rows examined per row returned. The ratio that finds a missing index
/// faster than any timing does — but only once there is enough traffic to
/// mean something, hence the call floor. Null when the engine does not
/// report examined rows (Postgres) or the statement returns nothing, which
/// is every write.
export function scanRatio(s: StatementStat): number | null {
  if (s.rowsExamined === null || s.calls < 10) return null;
  if (!s.rowsReturned) return null;
  return s.rowsExamined / s.rowsReturned;
}
