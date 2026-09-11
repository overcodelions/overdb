import { describe, expect, it } from 'vitest';
import { redshiftTypeName, sqlLiteralList } from './postgres';

describe('sqlLiteralList', () => {
  it('inlines schema names, because Redshift has no arrays to bind', () => {
    // `= any($1::text[])` is a syntax error on Redshift, so every catalog
    // query it has to answer builds its list inline instead.
    expect(sqlLiteralList(['public', 'acme_dm'])).toBe("'public', 'acme_dm'");
  });

  it('escapes a quote rather than closing the literal', () => {
    expect(sqlLiteralList(["o'hara"])).toBe("'o''hara'");
  });

  it('matches nothing when there is nothing to match', () => {
    // An empty `in ()` is a syntax error; an empty string simply matches no
    // schema, which is the honest answer.
    expect(sqlLiteralList([])).toBe("''");
  });
});

describe('redshiftTypeName', () => {
  it('puts the length back on, since svv_columns splits it off', () => {
    expect(redshiftTypeName({ type_name: 'character varying', char_len: '256' })).toBe(
      'character varying(256)',
    );
  });

  it('carries precision and scale for numerics', () => {
    expect(redshiftTypeName({ type_name: 'numeric', num_prec: '18', num_scale: '2' })).toBe(
      'numeric(18,2)',
    );
  });

  it('leaves a type that has no modifier alone', () => {
    // integer has a numeric_precision of 32 in svv_columns, and
    // `integer(32)` is not a type anyone wrote.
    expect(redshiftTypeName({ type_name: 'integer', num_prec: '32', num_scale: '0' })).toBe(
      'integer',
    );
    expect(redshiftTypeName({ type_name: 'timestamp without time zone' })).toBe(
      'timestamp without time zone',
    );
  });
});
