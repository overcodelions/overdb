import { describe, expect, it } from 'vitest';
import { branchesOf, chainOf, countSteps, planTree } from './planTree';
import type { PlanRow } from './plan';

const row = (depth: number, title: string): PlanRow => ({ depth, title });

describe('planTree', () => {
  it('keeps a flat plan flat', () => {
    const tree = planTree([row(0, 'a'), row(0, 'b'), row(0, 'c')]);
    expect(tree.map((n) => n.row.title)).toEqual(['a', 'b', 'c']);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it('nests a deeper step under the step above it', () => {
    const tree = planTree([row(0, 'outer'), row(1, 'inner'), row(0, 'next')]);
    expect(tree.map((n) => n.row.title)).toEqual(['outer', 'next']);
    expect(tree[0].children.map((n) => n.row.title)).toEqual(['inner']);
  });

  // The case the whole module exists for: six subqueries hanging off one
  // table are siblings, not a six-stage pipeline.
  it('makes sibling subqueries siblings, each with its own chain', () => {
    const tree = planTree([
      row(0, 'partner0_'),
      row(1, '<materialized_subquery>'),
      row(2, 'customacti21_'),
      row(2, 'partner20_'),
      row(1, '<materialized_subquery>'),
      row(2, 'workflowac19_'),
      row(2, 'partner18_'),
      row(0, 'partner0_1_'),
    ]);

    expect(tree.map((n) => n.row.title)).toEqual(['partner0_', 'partner0_1_']);
    const branches = tree[0].children;
    expect(branches).toHaveLength(2);
    expect(branches[0].children.map((n) => n.row.title)).toEqual(['customacti21_', 'partner20_']);
    expect(branches[1].children.map((n) => n.row.title)).toEqual(['workflowac19_', 'partner18_']);
  });

  it('carries the flat index through, so the picture and the table agree', () => {
    const tree = planTree([row(0, 'a'), row(1, 'b'), row(2, 'c')]);
    expect(tree[0].index).toBe(0);
    expect(tree[0].children[0].index).toBe(1);
    expect(tree[0].children[0].children[0].index).toBe(2);
  });

  it('attaches a step that skips a level to the nearest ancestor', () => {
    const tree = planTree([row(0, 'a'), row(3, 'deep'), row(0, 'b')]);
    expect(tree.map((n) => n.row.title)).toEqual(['a', 'b']);
    expect(tree[0].children.map((n) => n.row.title)).toEqual(['deep']);
  });

  it('closes a subtree when the depth comes back up', () => {
    const tree = planTree([row(0, 'a'), row(1, 'b'), row(2, 'c'), row(1, 'd')]);
    expect(tree[0].children.map((n) => n.row.title)).toEqual(['b', 'd']);
    expect(tree[0].children[0].children.map((n) => n.row.title)).toEqual(['c']);
  });

  it('survives an empty plan', () => {
    expect(planTree([])).toEqual([]);
    expect(countSteps([])).toBe(0);
  });

  it('counts every step in a subtree', () => {
    const tree = planTree([row(0, 'a'), row(1, 'b'), row(2, 'c'), row(0, 'd')]);
    expect(countSteps(tree)).toBe(4);
    expect(countSteps(tree[0].children)).toBe(2);
  });
});

describe('branchesOf / chainOf', () => {
  const branch = (depth: number, title: string): PlanRow => ({ depth, title, branch: true });

  it('separates independent subqueries from the chain that builds one', () => {
    const tree = planTree([
      row(0, 'partner0_'),
      branch(1, '<materialized_subquery>'),
      row(2, 'customacti21_'),
      row(2, 'partner20_'),
      branch(1, '<materialized_subquery>'),
      row(2, 'workflowac19_'),
    ]);

    // Two alternatives hang off the table…
    expect(branchesOf(tree[0])).toHaveLength(2);
    expect(chainOf(tree[0])).toHaveLength(0);

    // …and inside one of them, the steps are a sequence, not more branches.
    const first = branchesOf(tree[0])[0];
    expect(branchesOf(first)).toHaveLength(0);
    expect(chainOf(first).map((n) => n.row.title)).toEqual(['customacti21_', 'partner20_']);
  });

  it('treats unmarked children as a chain', () => {
    const tree = planTree([row(0, 'a'), row(1, 'b'), row(1, 'c')]);
    expect(chainOf(tree[0]).map((n) => n.row.title)).toEqual(['b', 'c']);
    expect(branchesOf(tree[0])).toEqual([]);
  });
});
