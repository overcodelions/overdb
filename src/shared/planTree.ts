// Putting the shape back into a plan that was flattened to read it.
//
// `parsePlan` emits one row per step with a `depth`, which is the right shape
// for a table and the wrong one for a picture: it makes six independent
// subqueries hanging off one table look like six consecutive stages of a
// pipeline. They are not. In the MySQL plan that prompted this, `partner0_`
// carries six materialized subqueries — the `IN (…) OR IN (…)` chain — and
// none of them feeds another. Drawing them end to end says the fifth waits
// on the fourth, which is a claim the plan never made.
//
// The tree is already in the flat list; `depth` is the whole of it. This
// rebuilds it so a renderer can say what is a SEQUENCE (siblings, one after
// another) and what is a BRANCH (children, each feeding the step above).

import type { PlanRow } from './plan';

export interface PlanNode {
  row: PlanRow;
  /// Position in the flat list, so a renderer can key off it and cross-
  /// reference the table below the picture.
  index: number;
  /// Steps that feed this one: a subquery, a derived table, a Postgres
  /// child node. Independent of each other — that is the whole point.
  children: PlanNode[];
}

/// The flat list as the tree it came from.
///
/// A depth that jumps by more than one attaches to the nearest ancestor
/// rather than being dropped: a plan we half-understand is still worth
/// drawing, and an orphaned step would silently vanish from the picture
/// while remaining in the table underneath it.
export function planTree(rows: PlanRow[]): PlanNode[] {
  const roots: PlanNode[] = [];
  const stack: PlanNode[] = [];

  rows.forEach((row, index) => {
    const node: PlanNode = { row, index, children: [] };
    while (stack.length && stack[stack.length - 1].row.depth >= row.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });

  return roots;
}

/// How many steps a subtree covers, itself included — what a renderer needs
/// to decide whether a branch fits in what is left of its budget.
export function countSteps(nodes: PlanNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countSteps(node.children), 0);
}

/// The subqueries hanging off a step: independent of each other, each its
/// own circuit feeding this one.
export function branchesOf(node: PlanNode): PlanNode[] {
  return node.children.filter((c) => c.row.branch === true);
}

/// The steps that BUILD this one — a materialized subquery's own join
/// order, read as a sequence. The counterpart to `branchesOf`, and the
/// distinction the parser had to make because depth cannot: children that
/// are not branches are one chain, not several alternatives.
export function chainOf(node: PlanNode): PlanNode[] {
  return node.children.filter((c) => c.row.branch !== true);
}

/// Everything under a node, at any depth.
export function descendants(node: PlanNode): PlanNode[] {
  return node.children.flatMap((c) => [c, ...descendants(c)]);
}

/// Rows a subtree reads in total, the node itself included.
export function rowsOf(node: PlanNode): number {
  return [node, ...descendants(node)].reduce(
    (n, d) => n + (d.row.actualRows ?? d.row.rows ?? 0) * Math.max(1, d.row.loops ?? 1),
    0,
  );
}

/// What feeds a step and is NOT drawn on the main line.
///
/// Two different relationships with the same consequence for a picture:
/// independent subqueries attached to a condition, or the several steps
/// that build one materialized table. Either way the rows are real, they
/// are usually most of the query, and the main line does not show them.
export function feedersOf(node: PlanNode): PlanNode[] {
  const branches = branchesOf(node);
  return branches.length > 0 ? branches : chainOf(node);
}

/// What to call a subquery.
///
/// Its own head is `<materialized_subquery>` or `<subquery2>`, which names
/// nothing and is the same for all six of them. The table it reads hardest
/// is what anyone actually calls it — and it is the table you would go and
/// index.
export function subqueryName(node: PlanNode, resolve: (title: string) => string = (t) => t): string {
  const real = [node, ...descendants(node)]
    .filter((n) => !n.row.title.startsWith('<'))
    .sort((a, b) => rowsOf(b) - rowsOf(a));
  return resolve(real[0]?.row.title ?? node.row.title);
}

/// Names for a set of sibling subqueries, kept distinct.
///
/// Two of six branches can both be heaviest in `partner` — each one
/// re-scans it, which is the finding — but two rows reading "partner
/// 31,477" and "partner 29,046" look like a rendering fault rather than
/// like the same table being read twice. Where names collide, the one
/// table no sibling shares is appended: "partner · print_media_activation"
/// says both halves of it.
/// `resolve` turns a plan's alias into the table it stands for. Names are
/// compared AFTER it runs: `partner13_` and `partner16_` are different
/// strings and the same table, and it is the table a reader sees.
export function subqueryNames(
  nodes: PlanNode[],
  resolve: (title: string) => string = (t) => t,
): string[] {
  const primary = nodes.map((n) => subqueryName(n, resolve));
  const titlesOf = (node: PlanNode): string[] =>
    [node, ...descendants(node)]
      .filter((n) => !n.row.title.startsWith('<'))
      .sort((a, b) => rowsOf(b) - rowsOf(a))
      .map((n) => resolve(n.row.title));

  return primary.map((name, i) => {
    if (primary.filter((p) => p === name).length === 1) return name;
    const mine = titlesOf(nodes[i]);
    const others = new Set(nodes.flatMap((n, j) => (j === i ? [] : titlesOf(n))));
    const own = mine.find((t) => t !== name && !others.has(t));
    return own ? `${name} · ${own}` : name;
  });
}
