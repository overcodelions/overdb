// The plan's warnings, collected into things a person could act on.
//
// `warnFor` marks a single step: this one is a full scan, that one's estimate
// is stale. Printed one per row that is honest and nearly useless — a plan
// with six independent subqueries over the same two unindexed tables raises
// the same warning nine times, and nine identical amber lines read as noise
// rather than as one missing index.
//
// So the warnings are grouped by what you would DO about them. Three full
// scans of `workflow_activation` are one finding with three steps behind it.
// A table joined by six separate subqueries is a finding no per-step check
// could ever raise, because it is a fact about the shape of the statement.

import { keyLabel, type PlanRow } from './plan';
import { resolveStep } from './aliases';
import { branchesOf, planTree, type PlanNode } from './planTree';

export interface Finding {
  /// What is wrong, in one sentence, naming the tables involved.
  text: string;
  /// Whether the numbers in `text` are the server's estimates rather than
  /// counts of what happened. Everything in a plan without ANALYZE is, and
  /// a finding that states an estimate as a fact is a finding that will
  /// eventually be wrong out loud.
  estimated?: boolean;
  /// Rows implicated — how the findings are ranked against each other, and
  /// never shown as a number: it is a sort key, not a measurement.
  weight: number;
  /// Indices into the flat plan, so a caller can point at the steps.
  steps: number[];
}

interface Scored {
  row: PlanRow;
  index: number;
  /// Rows this step reads in total.
  read: number;
}

const FULL_SCAN = new Set(['ALL', 'index', 'Seq Scan']);

function label(row: PlanRow, aliases: Record<string, string>): string {
  return resolveStep(row.title, aliases)?.table ?? row.title;
}

function list(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/// Which subquery each step belongs to.
///
/// The count in "re-joined by N separate subqueries" has to be a count of
/// SUBQUERIES, and a flat scan can only count steps. Those are the same
/// number right up until one subquery joins a table twice, at which point
/// the finding claims a subquery that does not exist.
function branchOfStep(rows: PlanRow[]): Map<number, string> {
  const owner = new Map<number, string>();
  const claim = (node: PlanNode, id: string): void => {
    owner.set(node.index, id);
    for (const child of node.children) claim(child, id);
  };
  planTree(rows).forEach((trunk, t) =>
    branchesOf(trunk).forEach((branch, b) => claim(branch, `${t}:${b}`)),
  );
  return owner;
}

/// Everything worth saying about this plan, worst first.
export function planFindings(rows: PlanRow[], aliases: Record<string, string> = {}): Finding[] {
  const steps: Scored[] = rows.map((row, index) => ({
    row,
    index,
    read: (row.actualRows ?? row.rows ?? 0) * Math.max(1, row.loops ?? 1),
  }));
  const out: Finding[] = [];
  // Without ANALYZE every number below is the optimiser's guess, including
  // the loop counts — those are derived from `rows` × `filtered`, not
  // observed. The findings say so rather than asserting them.
  const measured = rows.some((r) => r.actualRows !== undefined);
  const owner = branchOfStep(rows);

  // ---- Tables read in full, grouped by table -------------------------
  //
  // By TABLE and not by step: the same table scanned inside three sibling
  // subqueries is one missing index, and saying so three times invites
  // three separate attempts to fix it.
  const scans = new Map<string, Scored[]>();
  for (const step of steps) {
    if (!step.row.access || !FULL_SCAN.has(step.row.access) || step.row.key) continue;
    const name = label(step.row, aliases);
    scans.set(name, [...(scans.get(name) ?? []), step]);
  }
  for (const [name, group] of scans) {
    const read = group.reduce((n, s) => n + s.read, 0);
    const indexScan = group[0].row.access === 'index';
    out.push({
      text:
        group.length > 1
          ? `${name} is read end to end ${group.length} times over — ${read.toLocaleString()} rows, and no index is used on any of them.`
          : indexScan
            ? `${name} is walked through its whole index — every entry read, none of them skipped.`
            : `${name} is scanned in full — there is no index on the column being filtered.`,
      weight: read,
      estimated: !measured,
      steps: group.map((s) => s.index),
    });
  }

  // ---- Lookups repeated per driving row ------------------------------
  for (const step of steps) {
    const runs = step.row.loops ?? 1;
    if (runs < 100) continue;
    out.push({
      text: `${label(step.row, aliases)} is looked up ${
        measured ? '' : 'about '
      }${runs.toLocaleString()} times — once per row from the step driving it${
        step.row.key ? `, on ${keyLabel(step.row.key)}` : ''
      }. Cheap once; ${step.read.toLocaleString()} rows in aggregate.`,
      weight: step.read,
      estimated: !measured,
      steps: [step.index],
    });
  }

  // ---- The same table joined by several independent subqueries -------
  //
  // No single step is at fault here, which is exactly why nothing else
  // reports it: six `EXISTS` clauses each re-join the same table and the
  // server has no way to share that work between them.
  const branchTables = new Map<string, Scored[]>();
  for (const step of steps) {
    if (!owner.has(step.index)) continue;
    const name = label(step.row, aliases);
    branchTables.set(name, [...(branchTables.get(name) ?? []), step]);
  }
  for (const [name, group] of branchTables) {
    // Distinct SUBQUERIES, not steps. A table joined twice inside one
    // subquery is one subquery, and counting the steps said two.
    const subqueries = new Set(group.map((s) => owner.get(s.index)));
    if (subqueries.size < 3) continue;
    out.push({
      text: `${name} is re-joined by ${subqueries.size} separate subqueries. They are independent, so the plan cannot share that work between them.`,
      weight: group.reduce((n, s) => n + s.read, 0),
      estimated: !measured,
      steps: group.map((s) => s.index),
    });
  }

  // ---- Estimates the optimiser acted on and got wrong -----------------
  const stale = steps.filter((s) => s.row.warn?.startsWith('Estimate off'));
  if (stale.length) {
    out.push({
      text: `The optimiser's row estimate is an order of magnitude out on ${list(
        stale.map((s) => label(s.row, aliases)),
      )} — it chose this plan on numbers that no longer describe the table. Stale statistics.`,
      weight: stale.reduce((n, s) => n + s.read, 0),
      steps: stale.map((s) => s.index),
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}
