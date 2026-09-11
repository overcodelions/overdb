import { describe, expect, it } from 'vitest';
import {
  branchesOf,
  chainOf,
  countSteps,
  feedersOf,
  planTree,
  rowsOf,
  subqueryName,
  subqueryNames,
} from './planTree';
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

describe('what feeds a step', () => {
  const rows: PlanRow[] = [
    { depth: 0, title: 'partner0_', access: 'ref', key: 'uq', rows: 28616, filtered: 0.5 },
    { depth: 1, title: '<materialized_subquery>', access: 'eq_ref', rows: 1, branch: true },
    { depth: 2, title: 'workflowac19_', access: 'ALL', rows: 26443 },
    { depth: 2, title: 'partner18_', access: 'eq_ref', rows: 1, loops: 26443 },
    { depth: 1, title: '<materialized_subquery>', access: 'eq_ref', rows: 1, branch: true },
    { depth: 2, title: 'customacti21_', access: 'ALL', rows: 4159 },
  ];

  it('names a subquery after the table it reads hardest', () => {
    // Its own head is `<materialized_subquery>`, which is the same for all
    // six of them and identifies nothing. The heaviest table inside it is
    // what anyone calls it, and the one they would go and index.
    const [first, second] = planTree(rows)[0].children;
    expect(subqueryName(first)).toBe('workflowac19_');
    expect(subqueryName(second)).toBe('customacti21_');
  });

  it('counts every row under a subquery, loops included', () => {
    const [first] = planTree(rows)[0].children;
    // 1 for the head, 26,443 for the scan, 26,443 for the driven lookup.
    expect(rowsOf(first)).toBe(52_887);
  });

  it('treats the steps building one materialized table as its feeders', () => {
    // Not branches — one thing built from several steps — and nothing
    // pointed at them until feedersOf covered both cases.
    const built: PlanRow[] = [
      { depth: 0, title: 'act', access: 'eq_ref', rows: 1, loops: 143 },
      { depth: 1, title: 'e', access: 'ref', rows: 10, materialized: true },
      { depth: 1, title: 'm', access: 'ref', rows: 467, materialized: true },
    ];
    expect(feedersOf(planTree(built)[0]).map((n) => n.row.title)).toEqual(['e', 'm']);
  });

  it('prefers real branches when a step has both', () => {
    expect(feedersOf(planTree(rows)[0]).every((n) => n.row.branch === true)).toBe(true);
  });
});

describe('naming sibling subqueries apart', () => {
  // Two of six branches are heaviest in `partner` — each re-scans it,
  // which IS the finding — but two rows reading "partner 31,477" and
  // "partner 29,046" look like a rendering fault rather than like the same
  // table being read twice.
  const rows: PlanRow[] = [
    { depth: 0, title: 'partner0_', access: 'ref', rows: 28616, filtered: 0.5 },
    { depth: 1, title: '<materialized_subquery>', rows: 1, branch: true },
    { depth: 2, title: 'partner16_', access: 'ref', rows: 28616, filtered: 0.5 },
    { depth: 2, title: 'printactiv17_', access: 'ref', rows: 19, loops: 143 },
    { depth: 1, title: '<materialized_subquery>', rows: 1, branch: true },
    { depth: 2, title: 'partner13_', access: 'ref', rows: 28616, filtered: 0.5 },
    { depth: 2, title: 'pluginacti14_', access: 'ref', rows: 1, loops: 143 },
  ];
  const alias: Record<string, string> = {
    partner13_: 'partner',
    partner16_: 'partner',
    printactiv17_: 'print_media_activation',
    pluginacti14_: 'panel_widget',
  };
  const resolve = (t: string) => alias[t] ?? t;

  it('separates two subqueries that read the same table hardest', () => {
    expect(subqueryNames(planTree(rows)[0].children, resolve)).toEqual([
      'partner · print_media_activation',
      'partner · panel_widget',
    ]);
  });

  it('compares names after the aliases are resolved, not before', () => {
    // `partner13_` and `partner16_` are different strings and the same
    // table. Unresolved, nothing collides and nothing gets disambiguated —
    // and the reader sees two rows both saying "partner".
    expect(subqueryNames(planTree(rows)[0].children)).toEqual(['partner16_', 'partner13_']);
  });

  it('leaves a name alone when no sibling shares it', () => {
    const solo: PlanRow[] = [
      { depth: 0, title: 'p', rows: 10 },
      { depth: 1, title: '<materialized_subquery>', rows: 1, branch: true },
      { depth: 2, title: 'workflowac19_', access: 'ALL', rows: 26443 },
    ];
    expect(subqueryNames(planTree(solo)[0].children)).toEqual(['workflowac19_']);
  });
});
