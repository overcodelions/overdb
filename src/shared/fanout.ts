// Running one statement everywhere, and saying how the answers differ.
//
// The comparison is the point. Four grids side by side is four grids; what
// anyone actually wants to know is "is staging the same as prod, and if not,
// where does it stop being the same". So every member is compared against
// the baseline, and the answer is a DIRECTION — what this member has that
// the baseline does not, and what it is missing — rather than a symmetric
// list of differences that leaves you to work out which side is wrong.
//
// Columns first, rows second, deliberately. A column that exists in one
// environment and not another is a migration that did not land, and it
// explains every row difference underneath it; comparing row counts across a
// schema mismatch produces a number that means nothing.

import type { Cell, ColumnMeta } from './types';
import type { Engine, Variant } from './engines';
import { equivalentSpelling, sameType } from './typeEquiv';

export type MemberStatus =
  | 'pending'
  | 'connecting'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'blocked';

/// One member's run. Mirrors a result tab, minus everything that only makes
/// sense for the single-connection editor (sorting, filtering, inline edits):
/// a fan-out result is read, compared, and thrown away.
export interface MemberRun {
  connectionId: string;
  /// Carried on the run so a comparison can tell a cross-engine spelling
  /// difference from a real one without reaching back into the connection
  /// list for every cell.
  engine: Engine;
  variant?: Variant;
  status: MemberStatus;
  runId: string | null;
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number | null;
  error: string | null;
  /// Rows a write changed. Present for symmetry with the editor's tabs; a
  /// v1 fan-out refuses writes, so it is only ever null today.
  affectedRows: number | null;
}

export function blankRun(connectionId: string, engine: Engine, variant?: Variant): MemberRun {
  return {
    connectionId,
    engine,
    variant,
    status: 'pending',
    runId: null,
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    durationMs: null,
    error: null,
    affectedRows: null,
  };
}

/// How one member's answer differs from the baseline's.
export interface Drift {
  /// Columns the baseline returned and this member did not.
  missingColumns: string[];
  /// Columns this member returned and the baseline did not.
  extraColumns: string[];
  /// Columns both returned, under a genuinely different type.
  changedTypes: Array<{ column: string; baseline: string; here: string }>;
  /// Columns whose type NAME differs but whose type does not — two engines
  /// spelling one thing two ways. Kept apart from `changedTypes` so it can
  /// be shown quietly; folded in with real drift it is what teaches people
  /// to stop reading the verdict.
  equivalentTypes: Array<{ column: string; baseline: string; here: string }>;
  /// Columns both returned, in a different position. Reported separately
  /// from missing and extra because a reordered SELECT * is a schema
  /// difference that changes nothing about the data.
  reordered: string[];
  /// This member's row count minus the baseline's, when both are known.
  rowDelta: number | null;
  /// Whether the two returned the same rows, cell for cell, in order.
  /// Null when either side did not finish, or when what came back was
  /// truncated — a comparison of two capped grids says nothing about the
  /// tables underneath them.
  sameRows: boolean | null;
}

export interface Comparison {
  /// Nothing to compare against, or this member IS the baseline.
  kind: 'baseline' | 'incomparable' | 'match' | 'differs';
  drift: Drift | null;
  /// One line, in the direction the reader is asking about.
  summary: string;
}

function names(columns: ColumnMeta[]): string[] {
  return columns.map((c) => c.name);
}

/// Cell-for-cell equality, which is deliberately strict about nothing but
/// the values: a number from one driver and the same number as a string from
/// another are NOT the same answer to report as identical, because the
/// difference is real and someone downstream will trip over it.
function sameCells(a: Cell[][], b: Cell[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const rowA = a[i];
    const rowB = b[i];
    if (rowA.length !== rowB.length) return false;
    for (let j = 0; j < rowA.length; j++) {
      const x = rowA[j];
      const y = rowB[j];
      if (x === y) continue;
      // Binary cells arrive as objects; compare what they carry rather than
      // the reference, which is never equal across two connections.
      if (x && y && typeof x === 'object' && typeof y === 'object') {
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
      }
      return false;
    }
  }
  return true;
}

export function compare(member: MemberRun, baseline: MemberRun | null): Comparison {
  if (!baseline || baseline.connectionId === member.connectionId) {
    return { kind: 'baseline', drift: null, summary: 'the baseline' };
  }
  if (baseline.status !== 'done' || member.status !== 'done') {
    return {
      kind: 'incomparable',
      drift: null,
      summary:
        member.status === 'error' ? 'did not run'
        : member.status === 'blocked' ? 'not run'
        : baseline.status !== 'done' ? 'nothing to compare against — the baseline did not finish'
        : 'still running',
    };
  }

  const here = names(member.columns);
  const there = names(baseline.columns);
  const hereSet = new Set(here);
  const thereSet = new Set(there);

  const missingColumns = there.filter((c) => !hereSet.has(c));
  const extraColumns = here.filter((c) => !thereSet.has(c));
  const shared = there.filter((c) => hereSet.has(c));

  const changedTypes: Drift['changedTypes'] = [];
  const equivalentTypes: Drift['equivalentTypes'] = [];
  for (const column of shared) {
    const a = baseline.columns.find((c) => c.name === column);
    const b = member.columns.find((c) => c.name === column);
    if (!a || !b || a.typeName === b.typeName) continue;
    const entry = { column, baseline: a.typeName, here: b.typeName };
    if (equivalentSpelling(a.typeName, b.typeName, baseline.variant, member.variant)) {
      equivalentTypes.push(entry);
    } else {
      changedTypes.push(entry);
    }
  }

  // Position is only comparable for the columns both sides have; a column
  // missing from one side shifts every column after it, and reporting all
  // of those as "reordered" buries the one difference that matters.
  const reordered = shared.filter(
    (c) => shared.indexOf(c) !== here.filter((n) => thereSet.has(n)).indexOf(c),
  );

  const rowDelta = member.rowCount - baseline.rowCount;
  const sameRows =
    member.truncated || baseline.truncated
      ? null
      : missingColumns.length || extraColumns.length
        ? false
        : sameCells(member.rows, baseline.rows);

  const drift: Drift = {
    missingColumns,
    extraColumns,
    changedTypes,
    equivalentTypes,
    reordered,
    rowDelta,
    sameRows,
  };

  const schemaDiffers =
    missingColumns.length > 0 || extraColumns.length > 0 || changedTypes.length > 0 || reordered.length > 0;
  if (!schemaDiffers && rowDelta === 0 && sameRows !== false) {
    return {
      kind: 'match',
      drift,
      summary: sameRows === null ? 'same shape and row count — rows not compared, the result was capped' : 'identical',
    };
  }

  return { kind: 'differs', drift, summary: driftSentence(drift) };
}

/// The difference as one line, worst thing first.
///
/// Worst is a schema difference: it explains the row counts underneath it,
/// and a summary that leads with "412 fewer rows" when the real finding is a
/// missing column has buried the answer.
export function driftSentence(drift: Drift): string {
  const parts: string[] = [];

  if (drift.missingColumns.length) {
    parts.push(
      `missing ${drift.missingColumns.length === 1 ? 'column' : 'columns'} ${list(drift.missingColumns)}`,
    );
  }
  if (drift.extraColumns.length) {
    parts.push(`extra ${drift.extraColumns.length === 1 ? 'column' : 'columns'} ${list(drift.extraColumns)}`);
  }
  for (const t of drift.changedTypes.slice(0, 2)) {
    parts.push(`${t.column} is ${t.here}, not ${t.baseline}`);
  }
  if (drift.changedTypes.length > 2) {
    parts.push(`${drift.changedTypes.length - 2} more type differences`);
  }
  if (!drift.missingColumns.length && !drift.extraColumns.length && drift.reordered.length) {
    parts.push(`${drift.reordered.length} column${drift.reordered.length === 1 ? '' : 's'} in a different order`);
  }

  if (drift.rowDelta !== null && drift.rowDelta !== 0) {
    const n = Math.abs(drift.rowDelta).toLocaleString();
    parts.push(drift.rowDelta > 0 ? `${n} more rows` : `${n} fewer rows`);
  } else if (drift.sameRows === false && drift.rowDelta === 0) {
    // Same count, different contents. Easy to miss and worth saying plainly:
    // "no difference in the numbers" is exactly the wrong conclusion.
    parts.push('same number of rows, different values');
  } else if (drift.sameRows === null) {
    // The bug this replaces: a capped result was silently not row-compared
    // whenever ANYTHING else differed, because that sent the verdict down
    // the drift path and this sentence was only ever written on the other
    // one. A schema finding is not a reason to stop saying what was not
    // checked.
    parts.push('rows not compared');
  }

  return parts.length ? parts.join(' · ') : 'differs';
}

function list(values: string[]): string {
  const shown = values.slice(0, 3).join(', ');
  return values.length > 3 ? `${shown} and ${values.length - 3} more` : shown;
}

/// The headline over the member strip: how the set came out overall.
export function fanoutSummary(runs: MemberRun[], baselineId: string | null): string {
  const baseline = runs.find((r) => r.connectionId === baselineId) ?? null;
  const others = runs.filter((r) => r.connectionId !== baseline?.connectionId);
  if (!others.length) return 'One member — nothing to compare against.';

  // Counted across EVERY member, the baseline included. Excluding it made
  // the tally disagree with the screen: two members failed and the summary
  // said one, because the one it left out was the baseline — which is the
  // failure that matters most, since nothing can be compared without it.
  const failed = runs.filter((r) => r.status === 'error').length;
  if (baseline?.status === 'error') {
    return failed === 1
      ? 'The baseline failed — nothing to compare against.'
      : `${failed} failed, the baseline among them — nothing to compare against.`;
  }

  const comparisons = others.map((r) => compare(r, baseline));
  const matched = comparisons.filter((c) => c.kind === 'match').length;
  const differ = comparisons.filter((c) => c.kind === 'differs').length;

  const parts: string[] = [];
  if (matched) parts.push(`${matched} match the baseline`);
  if (differ) parts.push(`${differ} differ`);
  if (failed) parts.push(`${failed} failed`);

  // Said last but decisive: a tally taken while members are still working
  // is a progress report, not a result, and "Nothing finished" was flatly
  // untrue on a set whose baseline had already come back.
  const waiting = inFlight(runs).length;
  if (waiting > 0) {
    parts.push(`${waiting} still running`);
    return parts.join(', ');
  }
  return parts.length ? parts.join(', ') : 'Nothing finished.';
}

/// Why a statement is not allowed to fan out.
///
/// Both refusals are v1 scope rather than principle, and both say so: a
/// write is the one thing you must not do to five environments by pressing
/// ⌘↵ once, and a multi-statement script across N members is an N×M matrix
/// with no honest way to show a half-applied one.
export function fanoutRefusal(kinds: string[]): string | null {
  if (kinds.length > 1) {
    return 'One statement at a time across a set. A script that half-applies on one member and fully applies on another is the kind of state nothing here can show you honestly.';
  }
  const kind = kinds[0];
  if (kind === 'write' || kind === 'ddl') {
    return 'Sets are read-only. Writing to every environment at once is the accident this app exists to prevent — open the member you mean and write there.';
  }
  if (kind === 'txn') {
    return 'Transactions belong to one connection. Open the member you mean and run it there.';
  }
  return null;
}

// ---------------------------------------------------------------------
// The comparison as a table
// ---------------------------------------------------------------------

/// What the comparison could and could not establish about the ROWS.
///
/// Separate from the per-member verdicts, and stated whether or not anything
/// else differs. A capped result used to be reported as "not compared" only
/// when nothing else was wrong; the moment a type differed, that sentence
/// was replaced by the type and the reader was left believing 10,000 rows
/// had been checked.
export interface RowsVerdict {
  compared: boolean;
  /// True while members are still working. The distinction that matters:
  /// `compared: false` on its own reads as a VERDICT — "these could not be
  /// compared" — and saying that about a run still in flight is simply
  /// wrong. Nothing below is final until this is false.
  pending: boolean;
  headline: string;
  detail: string | null;
  /// A statement that WOULD compare, when one can be derived from the one
  /// that could not.
  suggestion: string | null;
}

/// Members that have not settled yet — still queued, connecting, or
/// running. Anything that reports on a fan-out has to ask this first, or it
/// describes a race as a result.
export function inFlight(runs: MemberRun[]): MemberRun[] {
  return runs.filter(
    (r) => r.status === 'pending' || r.status === 'connecting' || r.status === 'running',
  );
}

export function rowsVerdict(runs: MemberRun[], sql: string): RowsVerdict {
  // Asked before anything else. A fan-out is slowest on exactly the member
  // you most want the answer from — the far one, over a VPN — so the window
  // in which a premature verdict is on screen is not a rare edge, it is
  // most of the wait.
  const waiting = inFlight(runs);
  if (waiting.length > 0) {
    const arrived = waiting.reduce((n, r) => n + r.rows.length, 0);
    return {
      compared: false,
      pending: true,
      headline: `Still running on ${waiting.length} of ${runs.length} members.`,
      detail:
        arrived > 0
          ? `${arrived.toLocaleString()} rows have arrived from them so far. Nothing here is the answer yet.`
          : 'Nothing here is the answer yet.',
      suggestion: null,
    };
  }

  const finished = runs.filter((r) => r.status === 'done');
  if (finished.length < 2) {
    return {
      compared: false,
      pending: false,
      headline: 'The rows were not compared.',
      detail:
        finished.length === 0
          ? 'No member finished.'
          : 'Only one member finished, so there is nothing to compare its rows against.',
      suggestion: null,
    };
  }

  const capped = finished.filter((r) => r.truncated);
  if (capped.length) {
    const all = capped.length === finished.length;
    return {
      compared: false,
      pending: false,
      headline: 'The rows were not compared.',
      detail:
        `${all ? 'Every member' : `${capped.length} of ${finished.length} members`} stopped at the ` +
        `row cap, so what came back is the first ${capped[0].rowCount.toLocaleString()} rows each ` +
        'server happened to send, in whatever order it sent them. Comparing those says nothing ' +
        'about the tables underneath.',
      suggestion: countWrapper(sql),
    };
  }

  return {
    compared: true,
    pending: false,
    headline: 'Rows compared in full.',
    detail: null,
    suggestion: null,
  };
}

/// A statement that answers the same question in one row.
///
/// Wrapped rather than rewritten: parsing a FROM clause well enough to
/// rebuild the query is a job this does not need to do, and a suggestion
/// that quietly drops a join or a WHERE would be worse than none.
function countWrapper(sql: string): string | null {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^\s*(select|with)\b/i.test(trimmed)) return null;
  return `select count(*) from (${trimmed}) t`;
}

export type CellTone = 'baseline' | 'same' | 'equivalent' | 'drift' | 'absent' | 'unknown';

export interface MatrixCell {
  memberId: string;
  /// The type as that server spells it, or why there is nothing to show.
  text: string;
  tone: CellTone;
}

export interface MatrixRow {
  column: string;
  cells: MatrixCell[];
  /// Whether anything on this row differs. Rows where nothing does are
  /// counted rather than drawn — twenty identical rows are what stops the
  /// one that is not identical from being seen.
  interesting: boolean;
}

export interface Matrix {
  /// Display order: baseline first, then the set's own order.
  members: MemberRun[];
  rows: MatrixRow[];
  /// Columns every member returned identically, collapsed out of `rows`.
  matching: number;
}

export function columnMatrix(runs: MemberRun[], baselineId: string | null): Matrix {
  const members = [...runs].sort(
    (a, b) => Number(b.connectionId === baselineId) - Number(a.connectionId === baselineId),
  );
  const baseline = members.find((m) => m.connectionId === baselineId) ?? members[0] ?? null;

  // Baseline order first — it is the reference, so its shape is the one to
  // read down — then anything only the others returned.
  const order: string[] = [];
  for (const source of [baseline, ...members].filter((m): m is MemberRun => Boolean(m))) {
    for (const c of source.columns) if (!order.includes(c.name)) order.push(c.name);
  }

  const rows: MatrixRow[] = [];
  let matching = 0;

  for (const column of order) {
    const base = baseline?.columns.find((c) => c.name === column) ?? null;
    const cells: MatrixCell[] = members.map((m) => {
      if (m.status !== 'done') {
        return { memberId: m.connectionId, text: '—', tone: 'unknown' as CellTone };
      }
      const here = m.columns.find((c) => c.name === column);
      if (!here) {
        return { memberId: m.connectionId, text: 'not returned', tone: 'absent' as CellTone };
      }
      if (m.connectionId === baseline?.connectionId) {
        return { memberId: m.connectionId, text: here.typeName, tone: 'baseline' as CellTone };
      }
      if (!base) {
        // The baseline never returned this column, so this cell IS the
        // difference — naming it "extra" on every other member would report
        // one finding N times.
        return { memberId: m.connectionId, text: here.typeName, tone: 'drift' as CellTone };
      }
      if (here.typeName === base.typeName) {
        return { memberId: m.connectionId, text: here.typeName, tone: 'same' as CellTone };
      }
      const tone: CellTone = sameType(here.typeName, base.typeName, m.variant, baseline?.variant)
        ? 'equivalent'
        : 'drift';
      return { memberId: m.connectionId, text: here.typeName, tone };
    });

    const interesting = cells.some((c) => c.tone === 'drift' || c.tone === 'absent' || c.tone === 'equivalent');
    if (interesting) rows.push({ column, cells, interesting });
    else matching += 1;
  }

  return { members, rows, matching };
}

/// A member that took markedly longer than the baseline on the same
/// statement. Reported because it is a finding in its own right: identical
/// data returned four times slower is a missing index somewhere, and the
/// comparison is the only place that difference is visible side by side.
export function slowdown(member: MemberRun, baseline: MemberRun | null): number | null {
  if (!baseline || member.connectionId === baseline.connectionId) return null;
  if (member.durationMs === null || baseline.durationMs === null) return null;
  if (baseline.durationMs < 50 || member.durationMs < 50) return null;
  const ratio = member.durationMs / baseline.durationMs;
  return ratio >= 3 || ratio <= 1 / 3 ? ratio : null;
}

/// The tables a result actually came from.
///
/// Taken from the SERVER's own answer rather than by parsing the statement:
/// every `ColumnMeta` carries the source table the engine attributed that
/// column to, so a join names every table it touched and an expression
/// names none. No parser can be as right as that, and a parser that is
/// wrong here would point the index comparison at a table nobody queried.
///
/// An empty list is a real answer — `select count(*)` reads a table but
/// returns nothing attributable to one — and the caller should say there is
/// nothing to compare rather than guessing.
export function touchedTables(
  columns: ColumnMeta[],
): Array<{ schema: string | null; table: string }> {
  const seen = new Map<string, { schema: string | null; table: string }>();
  for (const c of columns) {
    const src = c.sourceTable;
    if (!src) continue;
    const key = `${(src.schema ?? '').toLowerCase()}.${src.table.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { schema: src.schema, table: src.table });
  }
  return [...seen.values()];
}
