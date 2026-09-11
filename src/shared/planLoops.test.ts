import { describe, expect, it } from 'vitest';
import { drivenRuns, type LoopStep } from './planLoops';

const step = (
  title: string,
  access: string,
  per: number,
  extra: Partial<LoopStep['row']> = {},
): LoopStep => ({
  row: { depth: 0, title, access, ...extra },
  per,
  runs: 1,
  tier: 0,
});

describe('drivenRuns', () => {
  it('finds the lookups a big step drives', () => {
    // `eq_ref` returning one row is not cheap when something calls it 28,616
    // times — and the plan never says the second part.
    const runs = drivenRuns([
      step('partner', 'ALL', 28_616),
      step('client', 'eq_ref', 1),
      step('partner_account_manager', 'eq_ref', 1),
    ]);
    expect(runs).toEqual([
      { first: 1, last: 2, driver: 'partner', times: 28_616 },
    ]);
  });

  it('counts only the rows that survive the driver’s condition', () => {
    const runs = drivenRuns([
      step('partner', 'ALL', 28_616, { filtered: 0.5 }),
      step('client', 'eq_ref', 1),
    ]);
    expect(runs[0].times).toBe(143);
  });

  it('prefers a count the server actually reported', () => {
    const runs = drivenRuns([
      step('partner', 'ALL', 1000),
      { ...step('client', 'eq_ref', 1), runs: 4242 },
    ]);
    expect(runs[0].times).toBe(4242);
  });

  it('does not invent a loop after a step that produces one row', () => {
    expect(drivenRuns([step('a', 'const', 1), step('b', 'eq_ref', 1)])).toEqual([]);
  });

  it('does not span two tiers — a subquery is not the same circuit', () => {
    const inner = { ...step('client', 'eq_ref', 1), tier: 1 };
    expect(drivenRuns([step('partner', 'ALL', 500), inner])).toEqual([]);
  });

  it('says "repeats" rather than a number it cannot know', () => {
    const runs = drivenRuns([
      step('partner', 'ALL', 2, { filtered: 10 }),
      step('client', 'eq_ref', 1),
    ]);
    expect(runs[0].times).toBeNull();
  });
});
