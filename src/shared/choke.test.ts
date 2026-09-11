import { describe, expect, it } from 'vitest';
import { choke, chokeSentence } from './planShape';

describe('choke', () => {
  it('finds the step that reads a lot and passes on a little', () => {
    // The step from the plan that prompted this: it uses an index, so
    // `heat` calls it cool, and it is where the query spends its time.
    const c = choke(26_385, 19);
    expect(c).not.toBeNull();
    expect(c!.dropped).toBe(26_366);
    expect(c!.kept).toBe(19);
  });

  it('ignores a small drop however bad the ratio', () => {
    // Throwing away 40 rows is not why anything is slow.
    expect(choke(41, 1)).toBeNull();
  });

  it('ignores a step that passes on most of what it reads', () => {
    expect(choke(100_000, 90_000)).toBeNull();
  });

  it('says a very small survival as a ratio, not a rounded percentage', () => {
    // "0.0% survives" reads as a rounding error rather than as the finding.
    expect(chokeSentence(choke(28_616, 1)!)).toContain('1 row in 28,616 survives');
    expect(chokeSentence(choke(26_385, 19)!)).toContain('26,366 rows go no further');
  });

  it('uses a percentage when there is one worth printing', () => {
    expect(chokeSentence(choke(10_000, 1_000)!)).toContain('10% survives');
  });

  it('survives nonsense rather than printing Infinity', () => {
    expect(choke(Number.NaN, 1)).toBeNull();
    expect(choke(1_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
