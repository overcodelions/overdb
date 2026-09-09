import { describe, expect, it } from 'vitest';
import { isSortable, quoteIdent, wrapWithOrderBy } from './orderBy';

describe('quoteIdent', () => {
  it('uses the engine\'s own quoting', () => {
    expect(quoteIdent('create_date', 'mysql')).toBe('`create_date`');
    expect(quoteIdent('create_date', 'postgres')).toBe('"create_date"');
    expect(quoteIdent('create_date', 'sqlite')).toBe('"create_date"');
  });

  it('escapes a quote inside the identifier', () => {
    // Legal, rare, and the difference between a sort and a syntax error.
    expect(quoteIdent('we`ird', 'mysql')).toBe('`we``ird`');
    expect(quoteIdent('we"ird', 'postgres')).toBe('"we""ird"');
  });
});

describe('wrapWithOrderBy', () => {
  it('wraps rather than editing the original statement', () => {
    const out = wrapWithOrderBy('select a, b from t', 'a', 'desc', 'postgres');
    expect(out).toContain('select a, b from t');
    expect(out).toContain('order by "a" desc');
  });

  it('strips a trailing semicolon so the derived table parses', () => {
    expect(wrapWithOrderBy('select 1;', 'x', 'asc', 'mysql')).not.toContain(';\n)');
  });

  it('composes with a statement that already sorts or limits', () => {
    // The reason for wrapping instead of rewriting: the inner ORDER BY and
    // LIMIT keep their meaning, and the outer sort applies to the result.
    const out = wrapWithOrderBy('select a from t order by b limit 10', 'a', 'asc', 'postgres');
    expect(out).toContain('order by b limit 10');
    expect(out.trimEnd().endsWith('order by "a" asc')).toBe(true);
  });

  it('composes with a CTE', () => {
    const out = wrapWithOrderBy('with x as (select 1 as a) select * from x', 'a', 'desc', 'postgres');
    expect(out).toContain('with x as (select 1 as a)');
    expect(out).toContain('order by "a" desc');
  });
});

describe('isSortable', () => {
  it('allows reads only', () => {
    // Wrapping a write would change what it does; a statement with no
    // result set has nothing to sort.
    expect(isSortable('read')).toBe(true);
    expect(isSortable('write')).toBe(false);
    expect(isSortable('ddl')).toBe(false);
    expect(isSortable('unknown')).toBe(false);
  });
});
