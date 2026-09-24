// The same statement, planned by several servers, compared.
//
// This is the question a result diff cannot answer. Two members return the
// same rows in wildly different times and the comparison can only report the
// times; the reason is in the plans, and it is nearly always the same reason:
// one server has an index the other does not, or has statistics that made it
// choose differently. Both are invisible until the two plans are side by
// side.
//
// Comparing plans across engines sounds impossible and mostly is — Postgres
// and MySQL share no vocabulary for node types. But the finding people
// actually want survives translation: for each table, did this server SEEK
// or did it SCAN? That reduces to four kinds, and those are comparable
// between any two engines. Everything else is shown in the server's own
// words and not diffed, because inventing an equivalence between `Bitmap
// Heap Scan` and `ref` would be making things up.

import type { Engine } from './engines';
import { keyLabel, type PlanRow } from './plan';

/// How a step gets at its rows, reduced to what matters.
export type ScanKind = 'full' | 'range' | 'lookup' | 'none' | 'other';

const FULL = new Set(['all', 'seq scan', 'index', 'index scan', 'index only scan', 'scan']);
const LOOKUP = new Set(['eq_ref', 'const', 'system', 'unique_subquery', 'index_subquery', 'query']);
const RANGE = new Set(['ref', 'range', 'ref_or_null', 'fulltext', 'index_merge', 'bitmap heap scan', 'bitmap index scan']);

export function scanKind(row: PlanRow): ScanKind {
  const access = (row.access ?? '').toLowerCase();
  if (!access) return 'none';
  // An index SCAN is still a scan of the whole index; the distinction that
  // matters is whether the server narrowed the work, not whether an index
  // was involved at all. MySQL's `index` and Postgres's `Index Scan` both
  // land here when no key bounds them.
  if (access === 'index' || access === 'all' || access === 'seq scan') return 'full';
  if (LOOKUP.has(access)) return 'lookup';
  if (RANGE.has(access)) return 'range';
  if (FULL.has(access)) return row.key ? 'range' : 'full';
  return 'other';
}

/// Ordered worst to best, so two members can be ranked against each other.
const SEVERITY: Record<ScanKind, number> = { full: 3, other: 2, range: 1, lookup: 0, none: 2 };

export type PlanTone =
  | 'baseline'
  | 'same'
  /// Same access, different index — worth seeing, not worth alarm.
  | 'differs'
  /// This member reads more of the table than the baseline does.
  | 'worse'
  /// This member reads less. Reported too: it means the baseline is the one
  /// missing an index, and a comparison that only ever blames the far end
  /// is a comparison you stop trusting.
  | 'better'
  | 'absent'
  | 'unknown';

export interface PlanCell {
  memberId: string;
  /// The engine's own words — `ALL`, `Seq Scan`, `eq_ref`.
  access: string | null;
  key: string | null;
  rows: number | null;
  /// Rows this step actually reads: per scan × number of scans. The number
  /// the picture is drawn from, because it is the one that differs by
  /// orders of magnitude between two servers running the same statement —
  /// `rows` alone hides a one-row lookup performed 28,000 times.
  work: number | null;
  kind: ScanKind;
  tone: PlanTone;
}

export interface PlanDiffRow {
  /// The table, as the statement named it.
  table: string;
  cells: PlanCell[];
  interesting: boolean;
}

export interface MemberPlan {
  connectionId: string;
  engine: Engine;
  rows: PlanRow[];
  error: string | null;
}

export interface PlanDiff {
  members: MemberPlan[];
  rows: PlanDiffRow[];
  /// Tables every member reads the same way, counted rather than listed.
  matching: number;
  /// The one sentence worth reading, when there is one.
  headline: string | null;
  /// Rows each member's whole plan reads, by connection id — the headline
  /// number, and the one a bar is worth drawing for.
  totals: Record<string, number>;
  /// The largest single cell, so every bar in the table is on one scale.
  /// Bars on per-cell scales would draw two very different amounts of work
  /// as two identical bars, which is worse than drawing nothing.
  maxWork: number;
}

/// What a step reads in total. Same rule the ledger and the river use.
export function workOf(row: PlanRow): number | null {
  const per = row.actualRows ?? row.rows;
  if (per === undefined) return null;
  return per * Math.max(1, row.loops ?? 1);
}

/// A plan step that reads a table, keyed by the table it reads.
///
/// Steps whose title is not a table — Postgres's `Hash`, `Sort`, `Gather`,
/// MySQL's `<materialized_subquery>` — carry no access path to compare and
/// are left out. What survives is "which tables, reached how", which is the
/// comparable part.
function tableSteps(rows: PlanRow[]): Map<string, PlanRow> {
  const out = new Map<string, PlanRow>();
  for (const row of rows) {
    if (!row.access) continue;
    const name = row.title.replace(/^(seq scan|index (only )?scan|bitmap heap scan) on /i, '').trim();
    if (!name || name.startsWith('<')) continue;
    // First occurrence wins: a table joined twice appears twice, and pairing
    // the second occurrence on one member with the first on another would
    // report a difference that is an artifact of ordering.
    if (!out.has(name)) out.set(name, row);
  }
  return out;
}

/// `nameOf` turns a connection id into what the reader calls that server.
/// The plans only carry ids, and a headline naming a UUID answers nothing.
export function planDiff(
  plans: MemberPlan[],
  baselineId: string | null,
  nameOf: (connectionId: string) => string = (id) => id,
): PlanDiff {
  const members = [...plans].sort(
    (a, b) => Number(b.connectionId === baselineId) - Number(a.connectionId === baselineId),
  );
  const baseline = members.find((m) => m.connectionId === baselineId) ?? members[0] ?? null;
  const steps = new Map(members.map((m) => [m.connectionId, tableSteps(m.rows)]));

  const order: string[] = [];
  for (const source of [baseline, ...members].filter((m): m is MemberPlan => Boolean(m))) {
    for (const name of steps.get(source.connectionId)?.keys() ?? []) {
      if (!order.includes(name)) order.push(name);
    }
  }

  const diffRows: PlanDiffRow[] = [];
  const findings: Array<{ table: string; member: string; kind: ScanKind; baseKind: ScanKind }> = [];
  let matching = 0;

  for (const table of order) {
    const base = baseline ? (steps.get(baseline.connectionId)?.get(table) ?? null) : null;
    const baseKind = base ? scanKind(base) : 'none';

    const cells: PlanCell[] = members.map((m) => {
      if (m.error) {
        return { memberId: m.connectionId, access: null, key: null, rows: null, work: null, kind: 'none', tone: 'unknown' };
      }
      const step = steps.get(m.connectionId)?.get(table) ?? null;
      if (!step) {
        return { memberId: m.connectionId, access: null, key: null, rows: null, work: null, kind: 'none', tone: 'absent' };
      }
      const kind = scanKind(step);
      const cell = {
        memberId: m.connectionId,
        access: step.access ?? null,
        key: step.key ?? null,
        rows: step.rows ?? null,
        work: workOf(step),
        kind,
      };
      if (m.connectionId === baseline?.connectionId) return { ...cell, tone: 'baseline' as PlanTone };
      if (!base) return { ...cell, tone: 'differs' as PlanTone };

      if (SEVERITY[kind] > SEVERITY[baseKind]) {
        findings.push({ table, member: m.connectionId, kind, baseKind });
        return { ...cell, tone: 'worse' as PlanTone };
      }
      if (SEVERITY[kind] < SEVERITY[baseKind]) return { ...cell, tone: 'better' as PlanTone };
      if ((step.key ?? null) !== (base.key ?? null)) return { ...cell, tone: 'differs' as PlanTone };
      return { ...cell, tone: 'same' as PlanTone };
    });

    const interesting = cells.some((c) => c.tone !== 'same' && c.tone !== 'baseline');
    if (interesting) diffRows.push({ table, cells, interesting });
    else matching += 1;
  }

  // Totals come from the WHOLE plan, not from the table rows above: a step
  // that reads no table still reads rows, and a total that quietly left
  // those out would disagree with the ledger for the same plan.
  const totals: Record<string, number> = {};
  for (const m of members) {
    totals[m.connectionId] = m.rows.reduce((n, r) => n + (workOf(r) ?? 0), 0);
  }
  const maxWork = Math.max(
    1,
    ...diffRows.flatMap((r) => r.cells.map((c) => c.work ?? 0)),
    ...members.flatMap((m) => [...(steps.get(m.connectionId)?.values() ?? [])].map((r) => workOf(r) ?? 0)),
  );

  return {
    members,
    rows: diffRows,
    matching,
    headline: headlineFor(findings, baseline, nameOf),
    totals,
    maxWork,
  };
}

function headlineFor(
  findings: Array<{ table: string; member: string; kind: ScanKind; baseKind: ScanKind }>,
  baseline: MemberPlan | null,
  name: (connectionId: string) => string,
): string | null {
  const worst = findings.find((f) => f.kind === 'full') ?? findings[0];
  if (!worst) return null;
  const base = baseline ? 'the baseline' : 'the other member';
  if (worst.kind === 'full' && worst.baseKind !== 'full') {
    return `${name(worst.member)} reads all of ${worst.table}, where ${base} narrows it with an index.`;
  }
  return `${name(worst.member)} reaches ${worst.table} through a wider path than ${base}.`;
}

/// What a cell says, in as few characters as a table cell allows.
export function cellLabel(cell: PlanCell): string {
  if (cell.tone === 'unknown') return '—';
  if (cell.tone === 'absent') return 'not read';
  const access = cell.access ?? '';
  return cell.key ? `${access} · ${keyLabel(cell.key)}` : access || '—';
}
