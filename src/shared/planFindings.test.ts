import { describe, expect, it } from 'vitest';
import { planFindings } from './planFindings';
import type { PlanRow } from './plan';

const row = (r: Partial<PlanRow>): PlanRow => ({ depth: 0, title: 't', ...r });

describe('planFindings', () => {
  it('says one thing about a table scanned in several places', () => {
    const found = planFindings([
      row({ title: 'w', access: 'ALL', rows: 26385, depth: 1 }),
      row({ title: 'w', access: 'ALL', rows: 26385, depth: 1 }),
      row({ title: 'w', access: 'ALL', rows: 26385, depth: 1 }),
    ]);
    const scans = found.filter((f) => f.text.includes('end to end'));
    expect(scans).toHaveLength(1);
    expect(scans[0].text).toContain('3 times over');
    expect(scans[0].steps).toEqual([0, 1, 2]);
  });

  it('names the table rather than the alias when the SQL is known', () => {
    const found = planFindings([row({ title: 'w19_', access: 'ALL', rows: 100 })], {
      w19_: 'workflow_activation',
    });
    expect(found[0].text).toContain('workflow_activation');
  });

  it('reports a lookup repeated per driving row', () => {
    const found = planFindings([row({ title: 'p', access: 'eq_ref', key: 'PRIMARY', rows: 1, loops: 26385 })]);
    expect(found[0].text).toContain('26,385 times');
    expect(found[0].text).toContain('on PRIMARY');
  });

  it('leaves a lookup that runs a handful of times alone', () => {
    expect(planFindings([row({ title: 'p', access: 'eq_ref', key: 'PRIMARY', rows: 1, loops: 12 })])).toEqual([]);
  });

  it('reports a table re-joined by several independent subqueries', () => {
    // A subquery is a BRANCH, not merely a step at depth > 0: the steps
    // inside one subquery are also indented, and they are one subquery.
    const found = planFindings([
      row({ title: 'root', depth: 0, rows: 10 }),
      ...Array.from({ length: 4 }, () =>
        row({ title: 'p', depth: 1, branch: true, access: 'eq_ref', key: 'PRIMARY', rows: 1 }),
      ),
    ]);
    expect(found.some((f) => f.text.includes('re-joined by 4 separate subqueries'))).toBe(true);
  });

  it('ranks the heaviest finding first', () => {
    const found = planFindings([
      row({ title: 'small', access: 'ALL', rows: 40 }),
      row({ title: 'big', access: 'ALL', rows: 90000 }),
    ]);
    expect(found[0].text).toContain('big');
  });

  it('has nothing to say about a plan that reads what it needs', () => {
    expect(planFindings([row({ title: 'p', access: 'const', key: 'PRIMARY', rows: 1 })])).toEqual([]);
  });
});

describe('planFindings counts subqueries, not steps', () => {
  it('counts a table joined twice in one subquery as one subquery', () => {
    // Three subqueries, the middle one joining `p` twice. Counting steps
    // reported four subqueries; there are three.
    const found = planFindings([
      row({ title: 'root', depth: 0, rows: 10 }),
      row({ title: 'p', depth: 1, branch: true, rows: 1 }),
      row({ title: 'p', depth: 1, branch: true, rows: 1 }),
      row({ title: 'p', depth: 2, rows: 1 }),
      row({ title: 'p', depth: 1, branch: true, rows: 1 }),
    ]);
    const rejoin = found.find((f) => f.text.includes('re-joined'));
    expect(rejoin?.text).toContain('re-joined by 3 separate subqueries');
  });

  it('hedges counts derived from estimates, and states measured ones plainly', () => {
    const guess = planFindings([row({ title: 'p', access: 'eq_ref', key: 'PRIMARY', rows: 1, loops: 26385 })]);
    expect(guess[0].text).toContain('about 26,385 times');
    expect(guess[0].estimated).toBe(true);

    const seen = planFindings([
      row({ title: 'p', access: 'eq_ref', key: 'PRIMARY', rows: 1, actualRows: 1, loops: 26385 }),
    ]);
    expect(seen[0].text).toContain('is looked up 26,385 times');
    expect(seen[0].estimated).toBe(false);
  });
});
