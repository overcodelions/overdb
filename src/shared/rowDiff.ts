// Which rows differ, not just whether they do.
//
// "Same number of rows, different values" is where the comparison used to
// stop, and it is exactly where the question starts: WHICH order is missing
// on staging, and what is different about the one both sides have? So rows
// are matched on a key — the primary key or a unique index of the table the
// server says they came from — and sorted into three piles: only in the
// baseline, only in this member, and present in both with different values.
//
// Without a key there is still an honest answer: the rows as a multiset.
// That says which whole rows one side has and the other does not, and —
// the part the positional check got wrong — it does not call two servers
// that returned the same rows in a different order "different".
//
// A key is never guessed from a column name. It comes from the catalog, and
// it is checked against the rows that actually came back: a primary key of
// `orders` is not unique in a result that joins `orders` to its line items,
// and a key that is not unique would pair rows that have nothing to do with
// each other.

import type { Cell, ColumnMeta, IndexInfo } from './types';
import type { MemberRun } from './fanout';

/// The catalog in the vocabulary a key search wants.
export interface KeyedTable {
  schema: string | null;
  name: string;
  primaryKey: string[];
  indexes: IndexInfo[];
}

export interface KeyChoice {
  /// Result column names, in key order.
  columns: string[];
  /// Where the key came from, for the sentence that names it:
  /// "orders primary key", "orders unique index orders_ref_key", "chosen".
  source: string;
}

export interface RowChange {
  /// The key's values, in `RowDiff.key` order.
  key: Cell[];
  /// The compared columns whose values differ, in `RowDiff.columns` order.
  changed: Array<{ column: string; baseline: Cell; here: Cell }>;
}

export interface RowDiff {
  /// The key rows were matched on, or null for a whole-row comparison.
  key: string[] | null;
  /// The columns compared: those both sides returned, in the baseline's
  /// order. A column only one side has is a schema finding the column
  /// matrix already reports; comparing values under it would make every
  /// row a "change".
  columns: string[];
  /// Rows only the baseline returned, projected onto `columns`.
  onlyBaseline: Cell[][];
  /// Rows only this member returned, projected onto `columns`.
  onlyHere: Cell[][];
  /// Rows both returned under one key with different values. Always empty
  /// without a key: two whole rows either match or they do not.
  changed: RowChange[];
  /// Rows that match exactly.
  same: number;
  /// Every row matched, but not in the same order. Worth a line of its own:
  /// with an ORDER BY it is a real difference, and without one it is noise
  /// the old check reported as "different values".
  orderOnly: boolean;
}

/// Cell equality as strict as the rest of the comparison: a number from one
/// driver and the same digits as a string from another are a difference,
/// because someone downstream will trip over it.
export function cellToken(cell: Cell): string {
  if (cell === null) return 'n';
  switch (typeof cell) {
    case 'string':
      return `s${cell}`;
    case 'number':
      return `d${cell}`;
    case 'boolean':
      return cell ? 'bt' : 'bf';
    default:
      // Binary cells arrive as objects; what they carry is the value.
      return `x${JSON.stringify(cell)}`;
  }
}

function rowToken(row: Cell[]): string {
  return JSON.stringify(row.map(cellToken));
}

function same(a: Cell, b: Cell): boolean {
  return a === b || cellToken(a) === cellToken(b);
}

const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();

/// Keys the catalog offers for this result: for each table the server
/// attributed a column to, its primary key and then its unique indexes —
/// each only when every column of it came back in the result.
export function candidateKeys(columns: ColumnMeta[], tables: KeyedTable[]): KeyChoice[] {
  const out: KeyChoice[] = [];
  const seen = new Set<string>();

  // The tables the server attributed a column to, first-seen order. (The
  // same question `touchedTables` in fanout.ts answers; asked here directly
  // because fanout.ts imports this module.)
  const touchedList: Array<{ schema: string | null; table: string }> = [];
  for (const c of columns) {
    const src = c.sourceTable;
    if (!src) continue;
    if (!touchedList.some((t) => lower(t.table) === lower(src.table) && lower(t.schema) === lower(src.schema))) {
      touchedList.push({ schema: src.schema, table: src.table });
    }
  }

  for (const touched of touchedList) {
    const info = tables.find(
      (t) =>
        lower(t.name) === lower(touched.table) &&
        (touched.schema === null || t.schema === null || lower(t.schema) === lower(touched.schema)),
    );
    if (!info) continue;

    const resultColumnFor = (tableColumn: string): string | null =>
      columns.find(
        (c) =>
          c.sourceTable !== null &&
          lower(c.sourceTable.table) === lower(touched.table) &&
          lower(c.sourceTable.column) === lower(tableColumn),
      )?.name ?? null;

    const offer = (keyColumns: string[], source: string): void => {
      if (!keyColumns.length) return;
      const mapped = keyColumns.map(resultColumnFor);
      if (mapped.some((m) => m === null)) return;
      const names = mapped as string[];
      const id = names.join('\u0000');
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ columns: names, source });
    };

    offer(info.primaryKey, `${info.name} primary key`);
    for (const ix of info.indexes) {
      if (ix.unique) offer(ix.columns, `${info.name} unique index ${ix.name}`);
    }
  }
  return out;
}

/// Why a key cannot pair this run's rows, or null when it can: every key
/// column returned, and no two rows share a key or have a null in it.
export function keyProblem(key: string[], run: MemberRun, name: string): string | null {
  const idx = key.map((k) => run.columns.findIndex((c) => c.name === k));
  const absent = key.filter((_, i) => idx[i] < 0);
  if (absent.length) return `${name} did not return ${absent.join(', ')}.`;

  const seen = new Set<string>();
  for (const row of run.rows) {
    const values = idx.map((i) => row[i]);
    if (values.some((v) => v === null)) {
      return `${name} has a row with no ${key.length === 1 ? 'value' : 'values'} for ${key.join(', ')}.`;
    }
    const token = rowToken(values);
    if (seen.has(token)) {
      return `${key.join(', ')} is not unique in ${name}'s result — two rows share ${values.map(String).join(', ')}.`;
    }
    seen.add(token);
  }
  return null;
}

/// The first candidate that actually pairs both sides' rows.
export function pickKey(
  candidates: KeyChoice[],
  baseline: MemberRun,
  member: MemberRun,
): KeyChoice | null {
  return (
    candidates.find(
      (c) => keyProblem(c.columns, baseline, 'baseline') === null && keyProblem(c.columns, member, 'member') === null,
    ) ?? null
  );
}

/// The two answers, row by row. `key` must have passed `keyProblem` on both
/// sides; pass null to compare whole rows.
export function rowDiff(baseline: MemberRun, member: MemberRun, key: string[] | null): RowDiff {
  const hereNames = new Set(member.columns.map((c) => c.name));
  const columns = baseline.columns.map((c) => c.name).filter((n) => hereNames.has(n));

  const project = (run: MemberRun): Cell[][] => {
    const idx = columns.map((n) => run.columns.findIndex((c) => c.name === n));
    return run.rows.map((row) => idx.map((i) => row[i]));
  };
  const a = project(baseline);
  const b = project(member);

  const usableKey = key && key.length && key.every((k) => columns.includes(k)) ? key : null;
  return usableKey ? keyed(a, b, columns, usableKey) : whole(a, b, columns);
}

function keyed(a: Cell[][], b: Cell[][], columns: string[], key: string[]): RowDiff {
  const keyIdx = key.map((k) => columns.indexOf(k));
  const keyOf = (row: Cell[]): string => rowToken(keyIdx.map((i) => row[i]));

  const theirs = new Map<string, { row: Cell[]; at: number }>();
  b.forEach((row, at) => theirs.set(keyOf(row), { row, at }));

  const onlyBaseline: Cell[][] = [];
  const changed: RowChange[] = [];
  const matched = new Set<string>();
  let sameCount = 0;
  let inOrder = a.length === b.length;

  a.forEach((row, at) => {
    const k = keyOf(row);
    const other = theirs.get(k);
    if (!other) {
      onlyBaseline.push(row);
      return;
    }
    matched.add(k);
    if (other.at !== at) inOrder = false;
    const diffs = columns.flatMap((column, i) =>
      same(row[i], other.row[i]) ? [] : [{ column, baseline: row[i], here: other.row[i] }],
    );
    if (diffs.length) changed.push({ key: keyIdx.map((i) => row[i]), changed: diffs });
    else sameCount += 1;
  });

  const onlyHere = b.filter((row) => !matched.has(keyOf(row)));
  const allMatch = !onlyBaseline.length && !onlyHere.length && !changed.length;

  return {
    key,
    columns,
    onlyBaseline,
    onlyHere,
    changed,
    same: sameCount,
    orderOnly: allMatch && !inOrder,
  };
}

function whole(a: Cell[][], b: Cell[][], columns: string[]): RowDiff {
  // A multiset, not a set: a row returned twice on one side and once on the
  // other is a difference, and it is one row's worth of difference.
  const pool = new Map<string, number>();
  for (const row of b) {
    const t = rowToken(row);
    pool.set(t, (pool.get(t) ?? 0) + 1);
  }

  const onlyBaseline: Cell[][] = [];
  let sameCount = 0;
  for (const row of a) {
    const t = rowToken(row);
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      pool.set(t, n - 1);
      sameCount += 1;
    } else {
      onlyBaseline.push(row);
    }
  }

  const onlyHere: Cell[][] = [];
  for (const row of b) {
    const t = rowToken(row);
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      pool.set(t, n - 1);
      onlyHere.push(row);
    }
  }

  const allMatch = !onlyBaseline.length && !onlyHere.length;
  const inOrder = a.length === b.length && a.every((row, i) => rowToken(row) === rowToken(b[i]));

  return {
    key: null,
    columns,
    onlyBaseline,
    onlyHere,
    changed: [],
    same: sameCount,
    orderOnly: allMatch && !inOrder,
  };
}

/// Whether two answers hold the same rows, in any order. What `compare`
/// asks; the full diff is only worked out for the member being looked at.
export function sameRowSet(baseline: MemberRun, member: MemberRun): boolean {
  const d = rowDiff(baseline, member, null);
  return d.onlyBaseline.length === 0 && d.onlyHere.length === 0;
}

/// The diff in one line, worst thing first.
export function rowDiffSentence(d: RowDiff, baselineName: string, memberName: string): string {
  const parts: string[] = [];
  if (d.onlyBaseline.length) parts.push(`${d.onlyBaseline.length.toLocaleString()} only in ${baselineName}`);
  if (d.onlyHere.length) parts.push(`${d.onlyHere.length.toLocaleString()} only in ${memberName}`);
  if (d.changed.length) parts.push(`${d.changed.length.toLocaleString()} changed`);
  if (!parts.length) {
    return d.orderOnly ? 'The same rows, in a different order.' : 'The same rows.';
  }
  parts.push(`${d.same.toLocaleString()} the same`);
  return `${parts.join(' · ')}.`;
}
