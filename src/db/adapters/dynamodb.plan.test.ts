import { describe, expect, it } from 'vitest';
import { describePlan } from './dynamodb';

const names = Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(3, '0')}`);

describe('describePlan', () => {
  it('describes the budget from the top when nothing is requested', () => {
    const plan = describePlan(names, [], 60);
    expect(plan).toHaveLength(60);
    expect(plan[0]).toBe('t000');
  });

  it('puts a requested table first even when it is past the budget', () => {
    // The bug this pins: `LOCAL.event-log-v2` sat outside the first 60 of
    // 228 tables, so it never got a key schema and the model answered "I
    // don't see an events table" about a table sitting right there.
    const plan = describePlan(names, ['t299'], 60);
    expect(plan[0]).toBe('t299');
    expect(plan).toHaveLength(60);
  });

  it('never spends budget on a table the account does not have', () => {
    const plan = describePlan(names, ['nope'], 5);
    expect(plan).toEqual(['t000', 't001', 't002', 't003', 't004']);
  });

  it('does not describe the same table twice', () => {
    const plan = describePlan(names, ['t002', 't002'], 5);
    expect(plan).toEqual(['t002', 't000', 't001', 't003', 't004']);
  });

  it('honours every request even when they alone exceed the budget', () => {
    const plan = describePlan(names, ['t010', 't011', 't012'], 2);
    expect(plan).toEqual(['t010', 't011', 't012']);
  });
});
