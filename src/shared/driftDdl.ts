import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './types';
import { consequenceOf, type DriftConsequence, type DriftFinding, type DriftKind } from './schemaDiff';

/// One table's drift, as rows with the two servers side by side.
///
/// Each row is one thing in the table — a column, an index, a key — with
/// what the baseline has on one side and what this member has on the other,
/// and only the words that differ lit. Side by side rather than a `-`/`+`
/// diff: a diff's colours say "removed" and "added", and neither server
/// removed or added anything — they are two servers, and the question is
/// which one says what. Columns that name the server answer it on every
/// row, where a legend at the top answers it once and scrolls away.
///
/// The rows that agree are folded into a count, in place, so a changed
/// column still sits where it sits in the table.

export interface DdlRow {
  /// A run of rows that agree, folded into a count.
  fold?: string;
  /// The column, index or key, or null for the table itself.
  name: string | null;
  /// Its definition on each side, without the name. Null: that side does
  /// not have it.
  baseline: string | null;
  here: string | null;
  /// A few words on what differs.
  note: string;
  consequence?: DriftConsequence;
}

const COLUMN_KINDS = new Set<DriftKind>([
  'column-missing',
  'column-extra',
  'column-type',
  'column-nullability',
  'column-default',
  'column-order',
]);

const WHAT: Partial<Record<DriftKind, string>> = {
  'column-type': 'type',
  'column-nullability': 'nullability',
  'column-default': 'default',
  'column-order': 'position',
};

/// One member's side of a table, for `tableGrid`.
export interface GridMember {
  /// Its findings on this table — none means it matches the baseline here.
  findings: DriftFinding[];
  table: TableInfo | undefined;
}

export interface GridCell {
  /// Its definition on this member; null when the member does not have it.
  value: string | null;
  /// Nothing differs from the baseline here. Drawn as a quiet "same"
  /// rather than the value again, so a row's width goes to the members
  /// that differ.
  same: boolean;
}

export interface GridRow {
  /// A run of rows every member agrees on, folded into a count.
  fold?: string;
  key: string;
  /// The column, index or key, or null for the table itself.
  name: string | null;
  baseline: string | null;
  /// One per member, in the order given.
  cells: GridCell[];
  /// What differs, across every member that differs.
  note: string;
  consequence?: DriftConsequence;
}

/// One table's drift across several members at once, as rows with a cell
/// per member beside the baseline's.
///
/// A row is one thing in the table — a column, an index, a key — shown if
/// ANY member differs on it; each member's cell is its own definition when
/// it differs and "same" when it does not. That is the question a set of
/// three asks: not how each drifted, one at a time, but which of them did,
/// and whether they drifted the same way.
///
/// A table one member lacks (or only one has) is drawn whole, every row
/// shown, the members without it empty.
export function tableGrid(
  baseline: TableInfo | undefined,
  members: GridMember[],
  options: { expand?: boolean } = {},
): GridRow[] {
  const all = members.flatMap((m) => m.findings);
  if (all.length === 0) return [];
  const schema = all[0].schema;
  const fk = (k: ForeignKeyInfo) => foreignKey(k, schema);

  const found = members.map((m) => {
    const map = new Map<string, DriftFinding[]>();
    for (const f of m.findings) {
      const k = keyOf(f);
      if (k) map.set(k, [...(map.get(k) ?? []), f]);
    }
    return map;
  });
  // A member the table is missing from, or that has a table the baseline
  // lacks: every row differs for it, so nothing folds.
  const whole = found.map((m) => m.has('table'));
  const anyWhole = whole.some(Boolean);

  const rows: GridRow[] = [];
  let agreeing: GridRow[] = [];
  const flush = (one: string, many: string) => {
    if (agreeing.length === 0) return;
    if (options.expand) rows.push(...agreeing);
    else {
      const n = agreeing.length;
      rows.push({
        fold: `⋯ ${n} matching ${n === 1 ? one : many}`,
        key: `fold:${rows.length}`,
        name: null,
        baseline: null,
        cells: [],
        note: '',
      });
    }
    agreeing = [];
  };

  const row = (
    key: string,
    name: string | null,
    base: string | null,
    valueOf: (i: number) => string | null,
  ): GridRow => {
    const fs = found.flatMap((m) => m.get(key) ?? []);
    const cells = members.map((_, i) =>
      found[i].has(key) || whole[i] ? { value: valueOf(i), same: false } : { value: base, same: true },
    );
    const notes = [...new Set(fs.map(noteOf))];
    return {
      key,
      name,
      baseline: base,
      cells,
      note: notes.join(' · '),
      consequence: fs.map(consequenceOf).sort(byWeight)[0],
    };
  };
  const place = (r: GridRow, one: string, many: string) => {
    if (r.cells.every((c) => c.same)) agreeing.push(r);
    else {
      flush(one, many);
      rows.push(r);
    }
  };

  if (anyWhole) {
    const size = (t: TableInfo | undefined) =>
      t ? `${t.kind === 'table' ? 'table' : t.kind} · ${t.columns.length} column${t.columns.length === 1 ? '' : 's'}` : null;
    const unread = all.some((f) => f.kind === 'table-missing') && !baseline;
    rows.push(row('table', null, unread ? '( columns not read )' : size(baseline), (i) => size(members[i].table)));
  }
  if (found.some((m) => m.has('kind'))) {
    rows.push(row('kind', null, baseline?.kind ?? null, (i) => members[i].table?.kind ?? null));
  }

  // Columns, in the baseline's order, then any only a member has.
  const names = [...(baseline?.columns ?? []).map((c) => c.name)];
  for (const m of members) for (const c of m.table?.columns ?? []) if (!names.includes(c.name)) names.push(c.name);
  for (const name of names) {
    const b = baseline?.columns.find((c) => c.name === name);
    place(
      row(`col:${name}`, name, b ? column(b) : null, (i) => {
        const h = members[i].table?.columns.find((c) => c.name === name);
        return h ? column(h) : null;
      }),
      'column',
      'columns',
    );
  }
  flush('column', 'columns');

  if (found.some((m) => m.has('pk'))) {
    const pk = (t?: TableInfo) => (t?.primaryKey.length ? `(${t.primaryKey.join(', ')})` : null);
    rows.push(row('pk', 'PRIMARY KEY', pk(baseline), (i) => pk(members[i].table)));
  }

  const indexNames = [...(baseline?.indexes ?? []).map((x) => x.name)];
  for (const m of members) for (const x of m.table?.indexes ?? []) if (!indexNames.includes(x.name)) indexNames.push(x.name);
  for (const name of indexNames) {
    const b = baseline?.indexes.find((x) => x.name === name);
    place(
      row(`idx:${name}`, name, b ? index(b) : null, (i) => {
        const h = members[i].table?.indexes.find((x) => x.name === name);
        return h ? index(h) : null;
      }),
      'index or key',
      'indexes and keys',
    );
  }
  const keyNames = [...(baseline?.foreignKeys ?? []).map((x) => x.name)];
  for (const m of members) for (const x of m.table?.foreignKeys ?? []) if (!keyNames.includes(x.name)) keyNames.push(x.name);
  for (const name of keyNames) {
    const b = baseline?.foreignKeys.find((x) => x.name === name);
    place(
      row(`fk:${name}`, name, b ? fk(b) : null, (i) => {
        const h = members[i].table?.foreignKeys.find((x) => x.name === name);
        return h ? fk(h) : null;
      }),
      'index or key',
      'indexes and keys',
    );
  }
  // A finding on an index the catalog would not describe still gets a row.
  for (const [i, m] of found.entries()) {
    for (const [key, fs] of m) {
      if (rows.some((r) => r.key === key) || !/^(idx|fk):/.test(key)) continue;
      const f = fs[0];
      rows.push(row(key, f.object, f.baseline, (j) => (j === i ? f.here : null)));
    }
  }
  flush('index or key', 'indexes and keys');
  return rows;
}

function keyOf(f: DriftFinding): string | null {
  if (COLUMN_KINDS.has(f.kind)) return `col:${f.object}`;
  if (f.kind.startsWith('index-')) return `idx:${f.object}`;
  if (f.kind.startsWith('foreign-key-')) return `fk:${f.object}`;
  if (f.kind === 'primary-key') return 'pk';
  if (f.kind === 'table-kind') return 'kind';
  if (f.kind === 'table-missing' || f.kind === 'table-extra') return 'table';
  return null;
}

function noteOf(f: DriftFinding): string {
  switch (f.kind) {
    case 'table-missing':
      return 'table missing';
    case 'table-extra':
      return 'extra table';
    case 'column-missing':
      return 'column missing';
    case 'column-extra':
      return 'extra column';
    case 'index-missing':
      return 'index missing';
    case 'index-extra':
      return 'extra index';
    case 'index-uniqueness':
      return 'uniqueness';
    case 'foreign-key-missing':
      return 'foreign key missing';
    case 'foreign-key-extra':
      return 'extra foreign key';
    case 'foreign-key-target':
      return 'references';
    case 'primary-key':
      return 'primary key';
    case 'table-kind':
      return 'kind';
    default:
      return WHAT[f.kind] ?? f.kind;
  }
}

/// One member against the baseline — `tableGrid` with a single member, as
/// baseline/here pairs.
export function tableRows(
  findings: DriftFinding[],
  baseline: TableInfo | undefined,
  here: TableInfo | undefined,
  options: { expand?: boolean } = {},
): DdlRow[] {
  return tableGrid(baseline, [{ findings, table: here }], options).map((r) => ({
    fold: r.fold,
    name: r.name,
    baseline: r.baseline,
    here: r.cells[0] ? (r.cells[0].same ? r.baseline : r.cells[0].value) : null,
    note: r.note,
    consequence: r.consequence,
  }));
}

/// Two short definitions, word by word, with the words each side does not
/// share marked. A longest-common-subsequence over words: `timestamp NOT
/// NULL` against `datetime NOT NULL DEFAULT CURRENT_TIMESTAMP` lights
/// `timestamp` on one side and `datetime`, `DEFAULT CURRENT_TIMESTAMP` on
/// the other, and leaves `NOT NULL` alone on both.
export interface Word {
  text: string;
  changed: boolean;
}

export function wordDiff(a: string, b: string): { a: Word[]; b: Word[] } {
  const x = a.split(/(\s+)/).filter(Boolean);
  const y = b.split(/(\s+)/).filter(Boolean);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const outA: Word[] = [];
  const outB: Word[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      outA.push({ text: x[i++], changed: false });
      outB.push({ text: y[j++], changed: false });
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      outA.push({ text: x[i++], changed: true });
    } else {
      outB.push({ text: y[j++], changed: true });
    }
  }
  while (i < n) outA.push({ text: x[i++], changed: true });
  while (j < m) outB.push({ text: y[j++], changed: true });
  return { a: merge(outA), b: merge(outB) };
}

/// Neighbouring words with the same mark become one run, and the space
/// between two changed words is part of the change — so `DEFAULT
/// CURRENT_TIMESTAMP` is one lit phrase, not two lit words.
function merge(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const space = !w.text.trim();
    const changed = space ? Boolean(words[k - 1]?.changed && words[k + 1]?.changed) : w.changed;
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += w.text;
    else out.push({ text: w.text, changed });
  }
  return out;
}

/// What each consequence is called and what it means, in one line that
/// names the servers. Shared by the drift view and the report made from it,
/// so the two can never describe the same finding differently.
///
/// The line is the point: "3 performance" says nothing to someone deciding
/// whether to care today; "slower queries, no data risk" does.
export const CONSEQUENCE_TEXT: Record<
  DriftConsequence | 'pending',
  {
    title: string;
    /// The heading, when it reads better with a name in it.
    label?: (baseline: string, here: string) => string;
    sub: (baseline: string, here: string) => string;
  }
> = {
  breaks: {
    title: 'Breaks',
    sub: (b, h) => `Queries or inserts written for ${b} fail on ${h}.`,
  },
  integrity: {
    title: 'Integrity',
    sub: (b, h) => `Rows ${b} would refuse can land on ${h}.`,
  },
  behaviour: {
    title: 'Behaviour',
    sub: (_b, h) => `The same statement gets a different result on ${h} — a default, for one.`,
  },
  performance: {
    title: 'Performance',
    sub: (_b, h) => `${h} lacks indexes. Slower queries, no data risk.`,
  },
  extra: {
    title: 'Only here',
    label: (_b, h) => `Only on ${h}`,
    sub: (b) => `${b} does not have these. overdb never drops them for you.`,
  },
  cosmetic: {
    title: 'Cosmetic',
    sub: () => 'Spelling and position. Changes nothing.',
  },
  pending: {
    title: 'Not deployed yet',
    label: (_b, h) => `Not on ${h} yet`,
    sub: (b) => `Tables only ${b} has. Not counted as drift.`,
  },
};

export const CONSEQUENCE_ORDER: Array<DriftConsequence | 'pending'> = [
  'breaks',
  'integrity',
  'behaviour',
  'performance',
  'extra',
  'cosmetic',
  'pending',
];

/// How many findings of each consequence, worst first.
export function tally(findings: DriftFinding[]): Array<[DriftConsequence, number]> {
  const counts = new Map<DriftConsequence, number>();
  for (const f of findings) counts.set(consequenceOf(f), (counts.get(consequenceOf(f)) ?? 0) + 1);
  return [...counts].sort((a, b) => byWeight(a[0], b[0]));
}

export interface TableGroup {
  key: string;
  schema: string;
  table: string;
  findings: DriftFinding[];
  /// Worst first.
  consequences: DriftConsequence[];
}

/// Findings by table, the tables ordered by the worst thing in each.
export function groupTables(findings: DriftFinding[]): TableGroup[] {
  const groups = new Map<string, TableGroup>();
  for (const f of findings) {
    const key = `${f.schema}.${f.table}`;
    const g = groups.get(key) ?? { key, schema: f.schema, table: f.table, findings: [], consequences: [] };
    g.findings.push(f);
    const c = consequenceOf(f);
    if (!g.consequences.includes(c)) g.consequences.push(c);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  for (const g of all) g.consequences.sort(byWeight);
  return all.sort((a, b) => byWeight(a.consequences[0], b.consequences[0]) || a.table.localeCompare(b.table));
}

/// One table across several members: each member's findings on it, in the
/// members' order, and the worst of them first.
export interface GridEntry {
  table: string;
  byMember: DriftFinding[][];
  consequences: DriftConsequence[];
  /// A table only the baseline has, not counted as drift.
  pending: boolean;
}

/// Every table any member differs on, worst first, and apart from them the
/// tables some member has not had deployed yet. Keyed by table name alone:
/// each member is compared in one schema, and the schema's name is allowed
/// to differ between members (`acme` locally, `acmeprod` on prod).
export function gridEntries(
  members: Array<{ findings: DriftFinding[]; pending: DriftFinding[] }>,
): { tables: GridEntry[]; pending: GridEntry[] } {
  const collect = (pick: (m: (typeof members)[number]) => DriftFinding[], pending: boolean) => {
    const byTable = new Map<string, GridEntry>();
    members.forEach((m, i) => {
      for (const f of pick(m)) {
        const e =
          byTable.get(f.table) ??
          { table: f.table, byMember: members.map(() => []), consequences: [], pending };
        e.byMember[i].push(f);
        if (!pending) {
          const c = consequenceOf(f);
          if (!e.consequences.includes(c)) e.consequences.push(c);
        }
        byTable.set(f.table, e);
      }
    });
    const all = [...byTable.values()];
    for (const e of all) e.consequences.sort(byWeight);
    return all.sort(
      (a, b) =>
        (pending ? 0 : byWeight(a.consequences[0], b.consequences[0])) || a.table.localeCompare(b.table),
    );
  };
  return { tables: collect((m) => m.findings, false), pending: collect((m) => m.pending, true) };
}

const WEIGHT: Record<DriftConsequence, number> = {
  breaks: 0,
  integrity: 1,
  behaviour: 2,
  performance: 3,
  extra: 4,
  cosmetic: 5,
};

export function byWeight(a: DriftConsequence, b: DriftConsequence): number {
  return WEIGHT[a] - WEIGHT[b];
}

function column(c: ColumnInfo): string {
  return `${c.typeName}${c.nullable ? '' : ' NOT NULL'}${c.defaultExpr !== null ? ` DEFAULT ${c.defaultExpr}` : ''}`;
}

function index(i: IndexInfo): string {
  return `${i.unique ? 'UNIQUE ' : ''}KEY (${i.columns.join(', ')})`;
}

/// The referenced schema is named only when it is not the table's own.
function foreignKey(k: ForeignKeyInfo, schema: string): string {
  const ref = `${k.refSchema && k.refSchema !== schema ? `${k.refSchema}.` : ''}${k.refTable}`;
  return `FOREIGN KEY (${k.columns.join(', ')}) REFERENCES ${ref}(${k.refColumns.join(', ')})`;
}
