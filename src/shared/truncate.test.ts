import { describe, expect, it } from 'vitest';
import { middleTruncate, nameBudget } from './truncate';

describe('middleTruncate', () => {
  it('leaves a name that fits alone', () => {
    expect(middleTruncate('localhost', 20)).toBe('localhost');
    expect(middleTruncate('localhost', 9)).toBe('localhost');
  });

  it('keeps the fragment that identifies the server', () => {
    // The real case: three connections sharing a prefix. A tail cut renders
    // all three identically; this keeps [EU], [RW] and [acme-pipe].
    const names = [
      'Redshift - @PROD [acme-pipe]',
      'Redshift - @PROD [EU]',
      'Redshift - @PROD [RW]',
    ];
    const cut = names.map((n) => middleTruncate(n, 20));
    expect(new Set(cut).size).toBe(3);
    expect(cut[0]).toContain('acme-pipe]');
    expect(cut[1]).toContain('[EU]');
  });

  it('never exceeds the budget it was given', () => {
    for (const n of ['a'.repeat(60), 'Redshift - @PROD [acme-pipe]', 'x']) {
      for (const budget of [4, 6, 10, 18, 30]) {
        expect(middleTruncate(n, budget).length, `${n}/${budget}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('falls back to a tail cut when there is no middle worth keeping', () => {
    expect(middleTruncate('abcdefgh', 5)).toBe('abcd…');
  });
});

describe('nameBudget', () => {
  it('gives a usable budget at the default width and at the minimum', () => {
    expect(nameBudget(280, 54)).toBeGreaterThan(28);
    expect(nameBudget(180, 12)).toBeGreaterThanOrEqual(20);
  });

  it('never returns something a name cannot be cut to', () => {
    expect(nameBudget(40, 54)).toBeGreaterThanOrEqual(4);
  });
});
