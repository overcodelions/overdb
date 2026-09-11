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
