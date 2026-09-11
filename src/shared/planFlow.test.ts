import { describe, expect, it } from 'vitest';
import { chainFlow } from './planFlow';

describe('chainFlow', () => {
  it('reads a step output off the NEXT step loop count', () => {
    // The case from the plan that prompted the module: a 28,616-row scan
    // followed by a one-row lookup that runs 143 times. The scan produced
    // 143 rows, not one.
    const flow = chainFlow([{ per: 28616, runs: 1 }, { per: 1, runs: 143 }], 1);
    expect(flow[0].read).toBe(28616);
    expect(flow[0].out).toBe(143);
    expect(flow[0].dropped).toBe(28473);
  });

  it('gives the last step of the outer chain the returned count', () => {
    const flow = chainFlow([{ per: 1, runs: 143 }], 1);
    expect(flow[0].read).toBe(143);
    expect(flow[0].out).toBe(1);
    expect(flow[0].dropped).toBe(142);
  });

  it('claims no drop on a chain whose statement was never run', () => {
    const flow = chainFlow([{ per: 900, runs: 1 }], null);
    expect(flow[0].dropped).toBe(0);
    expect(flow[0].out).toBe(900);
  });

  it('falls back to the next step row count when no loops are reported', () => {
    const flow = chainFlow([{ per: 5000, runs: 1 }, { per: 40, runs: 1 }], null);
    expect(flow[0].out).toBe(40);
    expect(flow[0].dropped).toBe(4960);
  });

  it('never reports an output larger than what the step read', () => {
    // A consumer that loops more times than the producer has rows: the plan
    // is telling us something we cannot draw, and inventing negative waste
    // is worse than clamping.
    const flow = chainFlow([{ per: 10, runs: 1 }, { per: 1, runs: 900 }], null);
    expect(flow[0].out).toBe(10);
    expect(flow[0].dropped).toBe(0);
  });

  it('reports the widening a multi-row loop causes', () => {
    expect(chainFlow([{ per: 19, runs: 143 }], null)[0].widen).toBe(19);
    expect(chainFlow([{ per: 1, runs: 26385 }], null)[0].widen).toBe(1);
  });

  it('never claims a step that runs once widened anything', () => {
    // A 28,616-row scan is not a step that multiplied its input by 28,616;
    // it has no input to multiply.
    expect(chainFlow([{ per: 28616, runs: 1 }], null)[0].widen).toBe(1);
  });
});

describe('chainFlow with no loop counts', () => {
  it('invents no drop in front of a per-lookup join', () => {
    // EXPLAIN without ANALYZE: an eq_ref reports `rows: 1`, meaning one row
    // PER LOOKUP. Read as a total it made the 28,616-row scan before it
    // look like a filter that discarded 28,615 rows.
    const flow = chainFlow(
      [{ per: 28616, runs: 1 }, { per: 1, runs: 1, driven: true }],
      null,
    );
    expect(flow[0].out).toBe(28616);
    expect(flow[0].dropped).toBe(0);
  });

  it('still trusts a reported loop count over the per-lookup rule', () => {
    const flow = chainFlow(
      [{ per: 28616, runs: 1 }, { per: 1, runs: 143, driven: true }],
      null,
    );
    expect(flow[0].out).toBe(143);
    expect(flow[0].dropped).toBe(28473);
  });

  it('still reports a drop in front of an ordinary step', () => {
    const flow = chainFlow([{ per: 9000, runs: 1 }, { per: 30, runs: 1 }], null);
    expect(flow[0].dropped).toBe(8970);
  });
});

describe('chainFlow and the WHERE clause', () => {
  it('necks the stream down by what the condition keeps', () => {
    // The whole point: 28,616 rows read, a condition that keeps 0.28% of
    // them, and a picture that used to draw all 28,616 flowing onward.
    const flow = chainFlow(
      [{ per: 28616, runs: 1, filtered: 0.28 }, { per: 1, runs: 1, driven: true }],
      null,
    );
    expect(flow[0].out).toBe(81);
    expect(flow[0].dropped).toBe(28535);
    expect(flow[0].estimated).toBe(true);
  });

  it('keeps at least one row when the condition rounds to none', () => {
    const flow = chainFlow([{ per: 900, runs: 1, filtered: 0.01 }], null);
    expect(flow[0].out).toBe(1);
  });

  it('prefers a measured loop count over the filter estimate', () => {
    const flow = chainFlow(
      [{ per: 28616, runs: 1, filtered: 0.28 }, { per: 1, runs: 143 }],
      null,
    );
    expect(flow[0].out).toBe(143);
    expect(flow[0].estimated).toBe(false);
  });

  it('prefers what the statement returned over the filter estimate', () => {
    const flow = chainFlow([{ per: 28616, runs: 1, filtered: 0.28 }], 12);
    expect(flow[0].out).toBe(12);
    expect(flow[0].estimated).toBe(false);
  });

  it('marks a 100% filter as no drop at all', () => {
    const flow = chainFlow([{ per: 500, runs: 1, filtered: 100 }], null);
    expect(flow[0].dropped).toBe(0);
  });
});
