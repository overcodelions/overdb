import { describe, expect, it } from 'vitest';
import { deriveStatement, predicate, withFilter, EMPTY_VIEW } from './gridView';

describe('predicate', () => {
  it('compares a number as a number', () => {
    expect(predicate({ column: 'a_type', op: '=', value: '1' }, 'mysql')).toBe('`a_type` = 1');
  });

  it('quotes text and doubles an embedded quote', () => {
    expect(predicate({ column: 'email', op: '=', value: "o'brien" }, 'postgres')).toBe(
      `"email" = 'o''brien'`,
    );
  });

  it('turns contains into an escaped LIKE', () => {
    // Unescaped, a value containing % would match more than it says.
    expect(predicate({ column: 'email', op: 'contains', value: '50%' }, 'postgres')).toBe(
      `"email" like '%50\\%%'`,
    );
  });

  it('reads a typed null as the null test, not the string', () => {
    // `= 'null'` never matches, and `= NULL` is never true — either way the
    // user would get an empty grid and no explanation.
    expect(predicate({ column: 'partner_id', op: '=', value: 'null' }, 'postgres')).toBe(
      '"partner_id" is null',
    );
    expect(predicate({ column: 'partner_id', op: '!=', value: 'NULL' }, 'postgres')).toBe(
      '"partner_id" is not null',
    );
  });

  it('has operators that need no operand', () => {
    expect(predicate({ column: 'ip', op: 'is null' }, 'sqlite')).toBe('"ip" is null');
  });
});

describe('deriveStatement', () => {
  const sql = 'select * from access_log;';

  it('returns the statement untouched when there is nothing to apply', () => {
    expect(deriveStatement(sql, EMPTY_VIEW, 'mysql')).toBe(sql);
  });

  it('wraps rather than rewrites, so a CTE or union still composes', () => {
    const view = { filters: [{ column: 'a_type', op: '=' as const, value: '1' }], sort: null };
    expect(deriveStatement(sql, view, 'mysql')).toBe(
      'select * from (\nselect * from access_log\n) as `overdb_view`\nwhere `a_type` = 1',
    );
  });

  it('applies filters and a sort together', () => {
    const out = deriveStatement(
      sql,
      {
        filters: [{ column: 'a_type', op: '=', value: '1' }],
        sort: { column: 'create_date', direction: 'desc' },
      },
      'postgres',
    );
    expect(out).toContain('where "a_type" = 1');
    expect(out).toContain('order by "create_date" desc');
  });

  it('ignores a filter whose value has been cleared', () => {
    const view = { filters: [{ column: 'a_type', op: '=' as const, value: '  ' }], sort: null };
    expect(deriveStatement(sql, view, 'mysql')).toBe(sql);
  });
});

describe('withFilter', () => {
  it('replaces the filter on a column rather than stacking one', () => {
    const first = withFilter([], { column: 'a_type', op: '=', value: '1' });
    const second = withFilter(first, { column: 'a_type', op: '=', value: '2' });
    expect(second).toEqual([{ column: 'a_type', op: '=', value: '2' }]);
  });

  it('drops the filter when its value is cleared', () => {
    const one = withFilter([], { column: 'a_type', op: '=', value: '1' });
    expect(withFilter(one, { column: 'a_type', op: '=', value: '' })).toEqual([]);
  });

  it('keeps a null test, which has no value to clear', () => {
    expect(withFilter([], { column: 'ip', op: 'is null' })).toEqual([
      { column: 'ip', op: 'is null' },
    ]);
  });
});
