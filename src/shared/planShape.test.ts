import { describe, expect, it } from 'vitest';
import { heat, planShape, share, stageSentence, wasteSentence } from './planShape';
import type { PlanRow } from './plan';

const scan: PlanRow = {
  depth: 0,
  title: 'panel_widget',
  access: 'ALL',
  rows: 10_000,
  warn: 'Full table scan — no index used.',
};
const lookup: PlanRow = { depth: 1, title: 'client', access: 'eq_ref', key: 'PRIMARY', rows: 1 };

describe('planShape', () => {
  it('finds the step that reads the most, which is nearly always the story', () => {
    const shape = planShape([lookup, scan], 3);
    expect(shape.heaviest?.title).toBe('panel_widget');
    expect(shape.read).toBe(10_000);
    expect(shape.waste).toBeCloseTo(3333.3, 0);
  });

  it('prefers measured rows over the optimizer’s guess', () => {
    const shape = planShape([{ ...scan, actualRows: 12_500 }], 3);
    expect(shape.read).toBe(12_500);
    expect(shape.measured).toBe(true);
  });

  it('has no ratio when nothing came back', () => {
    // Dividing by zero would print Infinity and mean nothing.
    expect(planShape([scan], 0).waste).toBeNull();
    expect(planShape([scan], null).waste).toBeNull();
  });

  it('ignores steps with no row count at all', () => {
    expect(planShape([{ depth: 0, title: 'Sort' }], 3).steps).toEqual([]);
  });
});

describe('wasteSentence', () => {
  it('names the ratio in rows, not in percentages', () => {
    expect(wasteSentence(planShape([scan], 3))).toContain('3,333 rows for every row');
  });

  it('says so when the query is not wasting work', () => {
    expect(wasteSentence(planShape([{ ...scan, rows: 3 }], 3))).toContain('not doing wasted work');
  });

  it('says nothing when it cannot tell', () => {
    expect(wasteSentence(planShape([scan], null))).toBeNull();
  });
});

describe('heat', () => {
  it('runs a warned full scan hot even when it is the only step', () => {
    // "There was nothing else to compare it to" is not a defence.
    expect(heat(scan, 10_000, 10_000)).toBeGreaterThan(0.7);
  });

  it('keeps an indexed step cool', () => {
    expect(heat(lookup, 1, 10_000)).toBeLessThan(0.5);
  });

  it('runs hot when almost nothing survives the condition', () => {
    expect(heat({ ...lookup, filtered: 2 }, 1, 10_000)).toBeGreaterThan(0.8);
  });
});

describe('looped steps', () => {
  const outer: PlanRow = { depth: 0, title: 'partner', access: 'ALL', rows: 28_616, filtered: 100 };
  const inner: PlanRow = {
    depth: 0,
    title: 'custom_activity',
    access: 'eq_ref',
    key: 'PRIMARY',
    rows: 1,
    loops: 28_616,
  };

  it('counts a step that runs many times as the work it really is', () => {
    // The plan says "1 row" for the inner side of a nested loop. It reads
    // one row PER SCAN, and there are 28,616 scans.
    const shape = planShape([outer, inner], 3);
    expect(shape.steps.find((s) => s.row.title === 'custom_activity')?.read).toBe(28_616);
  });

  it('makes the loop, not the scan, the heaviest step when it is', () => {
    const shape = planShape([outer, { ...inner, rows: 4, loops: 28_616 }], 3);
    expect(shape.heaviest?.title).toBe('custom_activity');
    expect(shape.read).toBe(114_464);
  });

  it('totals the work across every step', () => {
    expect(planShape([outer, inner], 3).total).toBe(57_232);
  });
});

describe('share', () => {
  it('writes a readable percentage', () => {
    expect(share(100)).toBe('100%');
    expect(share(28)).toBe('28%');
    expect(share(2.5)).toBe('2.5%');
  });

  it('writes a vanishing percentage as a ratio', () => {
    // "0.0% survives" reads as a rounding error rather than as the finding
    // it is: one row in thirty thousand.
    expect(share(0.0035)).toBe('1 row in 28,571');
  });
});

describe('passes over the rows', () => {
  const join = (): PlanRow[] => [
    { depth: 0, title: 'p', access: 'ALL', rows: 66517, filtered: 100 },
    { depth: 0, title: 'pw', access: 'ref', key: 'K', rows: 10, loops: 66517 },
    { depth: 0, title: 'temporary table', stage: 'temporary', rows: 665170 },
    { depth: 0, title: 'sort', stage: 'sort', rows: 665170, warn: 'blocks' },
  ];

  it('does not count a sort as rows read', () => {
    // A sort reads no table. Counting it added the join's output to the
    // headline once per pass — 731,687 rows read reported as 2,062,027.
    expect(planShape(join(), null).total).toBe(731_687);
  });

  it('does not let a pass become the heaviest step', () => {
    expect(planShape(join(), null).heaviest?.title).toBe('pw');
  });

  it('keeps them where a view can still find them', () => {
    expect(planShape(join(), null).stages.map((s) => s.row.title)).toEqual([
      'temporary table',
      'sort',
    ]);
  });

  it('says what has to finish before the first row arrives', () => {
    const rows = join();
    rows[2] = { ...rows[2], warn: 'blocks' };
    expect(stageSentence(planShape(rows, null))).toBe(
      'Nothing comes back until all 665,170 rows have been through a temporary table and a sort.',
    );
  });

  it('stays quiet about a pass small enough not to matter', () => {
    // Only a pass the parser flagged is worth a sentence; a sort of twelve
    // rows is not why anything is slow.
    const rows: PlanRow[] = [
      { depth: 0, title: 'p', access: 'ALL', rows: 12 },
      { depth: 0, title: 'sort', stage: 'sort', rows: 12 },
    ];
    expect(stageSentence(planShape(rows, null))).toBeNull();
  });
});

describe('the ratio divides the headline', () => {
  it('measures waste against everything the query reads', () => {
    // Not against the heaviest step. The headline beside the sentence is
    // the total, so a ratio taken from one step handed the reader two
    // numbers that would not divide: 61,474 rows read, 7 returned, and a
    // sentence claiming 4,088 rows per row kept.
    const rows: PlanRow[] = [
      { depth: 0, title: 'p', access: 'ref', key: 'K', rows: 28616, filtered: 0.5 },
      { depth: 1, title: 'workflow_activation', access: 'ALL', rows: 26443 },
      { depth: 1, title: 'custom_activity_activation', access: 'ALL', rows: 4159 },
    ];
    const shape = planShape(rows, 7);
    expect(shape.total).toBe(59_218);
    expect(shape.waste).toBeCloseTo(59_218 / 7);
    expect(wasteSentence(shape)).toContain('8,460');
  });
});
