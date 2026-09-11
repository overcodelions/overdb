// The shape of the work, as opposed to the plan's own numbers.
//
// A plan is a table of estimates, and reading one is a skill. But the thing
// that makes a query slow is almost always a single ratio: how many rows the
// server had to READ against how many you asked to keep. `select * from
// panel_widget where name = 'Tracking'` reading ten thousand rows to return
// three is not slow because ten thousand is a big number — it is slow because
// 3,333 of every 3,334 rows read were thrown away.
//
// This module turns a parsed plan into the few numbers that ratio needs, so
// the panel can draw it instead of asking someone to infer it.

import type { PlanRow } from './plan';

export interface PlanShape {
  /// Rows read across every step — the total work, as opposed to the single
  /// heaviest step.
  total: number | null;
  /// The step that reads the most, which is nearly always the whole story.
  heaviest: PlanRow | null;
  /// Rows read at the heaviest step, estimated or actual.
  read: number | null;
  /// Whether `read` came from ANALYZE rather than the optimizer's guess.
  measured: boolean;
  /// Rows the statement actually returned, when it has been run.
  returned: number | null;
  /// Rows read per row kept. Null when either half is unknown, or when
  /// nothing was returned — dividing by zero would print Infinity and mean
  /// nothing.
  waste: number | null;
  /// Steps that read anything, heaviest first, for the bars.
  steps: Array<{ row: PlanRow; read: number }>;
}

/// What a step actually reads: rows per scan times the number of scans.
///
/// `rows` is per scan on every engine that reports loops at all, so a step
/// that reads one row 28,616 times reads 28,616 rows. Ignoring the
/// multiplier made the cheapest-looking step in a bad join the one doing
/// nearly all the work.
function readOf(row: PlanRow): number | null {
  const per = row.actualRows ?? row.rows;
  if (per === undefined) return null;
  return per * Math.max(1, row.loops ?? 1);
}

export function planShape(rows: PlanRow[], returned: number | null): PlanShape {
  const steps = rows
    .map((row) => ({ row, read: readOf(row) }))
    .filter((s): s is { row: PlanRow; read: number } => s.read !== null)
    .sort((a, b) => b.read - a.read);

  const heaviest = steps[0] ?? null;
  const read = heaviest?.read ?? null;
  const measured = heaviest?.row.actualRows !== undefined;
  const waste = read !== null && returned !== null && returned > 0 ? read / returned : null;

  return {
    total: steps.length ? steps.reduce((n, s) => n + s.read, 0) : null,
    heaviest: heaviest?.row ?? null,
    read,
    measured,
    returned,
    waste,
    steps,
  };
}

/// The one sentence worth putting under the bars.
///
/// Deliberately says what the number MEANS rather than restating it: "10,000
/// rows read" is already on the bar, and a caption that repeats the bar is a
/// caption nobody reads twice.
export function wasteSentence(shape: PlanShape): string | null {
  if (shape.waste === null || shape.read === null) return null;
  if (shape.waste < 2) {
    return 'Almost every row it reads is a row you keep — this query is not doing wasted work.';
  }
  const per = shape.waste >= 10 ? Math.round(shape.waste).toLocaleString() : shape.waste.toFixed(1);
  return `It reads ${per} rows for every row it keeps. That ratio, not the row count, is what makes a query slow.`;
}

/// How hot this step runs, 0 to 1 — a scan of the whole table with almost
/// nothing surviving is 1. Used for colour, never for a number: it is a
/// judgement, and dressing a judgement up as a percentage would be a lie
/// about how precise it is.
export function heat(row: PlanRow, read: number, maxRead: number): number {
  if (maxRead <= 0) return 0;
  let n = read / maxRead;
  // A full scan is hot even when it is the only step, because "there was
  // nothing else to compare it to" is not a defence.
  if (row.warn) n = Math.max(n, 0.75);
  if (row.key) n = Math.min(n, 0.5);
  if (row.filtered !== undefined && row.filtered <= 5) n = Math.max(n, 0.85);
  return Math.max(0, Math.min(1, n));
}

/// Rows that go in and do not come out.
///
/// This is the thing that actually makes a query slow, and it is the one
/// thing none of the three pictures said out loud. A step that reads 26,385
/// rows and passes on 19 is where the time goes — but it draws as a fat
/// trace entering a calm-looking box with a thin trace leaving it, and if
/// that step happens to use an index, `heat` caps its colour and it is the
/// quietest thing on the board.
///
/// So the drop gets its own name, its own threshold, and the same treatment
/// in all three views.
export interface Choke {
  /// Rows read here that no later step ever sees.
  dropped: number;
  /// Rows that survive.
  kept: number;
  /// Survivors as a fraction of what was read, 0 to 1.
  surviving: number;
}

/// Below this many rows a drop is not worth drawing attention to: throwing
/// away 40 rows is not why anything is slow, however bad the ratio looks.
const CHOKE_MIN_DROPPED = 500;
/// A step that passes on more than a quarter of what it reads is doing its
/// job, not throttling.
const CHOKE_MAX_SURVIVING = 0.25;

export function choke(read: number, out: number): Choke | null {
  if (!Number.isFinite(read) || !Number.isFinite(out)) return null;
  const dropped = read - out;
  if (dropped < CHOKE_MIN_DROPPED) return null;
  const surviving = read > 0 ? out / read : 1;
  if (surviving > CHOKE_MAX_SURVIVING) return null;
  return { dropped, kept: Math.max(0, out), surviving };
}

/// How to say it. Percentages below a tenth of one percent are written as a
/// ratio instead — "0.0%" reads as a rounding error rather than as the
/// finding it is.
export function chokeSentence(c: Choke): string {
  const pct = c.surviving * 100;
  const share =
    pct >= 0.1
      ? `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% survives`
      : `1 row in ${Math.round(1 / Math.max(c.surviving, 1e-9)).toLocaleString()} survives`;
  return `${c.dropped.toLocaleString()} rows go no further — ${share}`;
}

/// A filter percentage as something readable. Below a tenth of one percent
/// `0.0%` reads as a rounding error rather than as the finding it is, so it
/// is written as a ratio instead.
export function share(filtered: number): string {
  if (filtered >= 0.1) return `${filtered < 10 ? filtered.toFixed(2).replace(/\.?0+$/, '') : Math.round(filtered)}%`;
  return `1 row in ${Math.round(100 / Math.max(filtered, 1e-6)).toLocaleString()}`;
}
