import { describe, expect, it } from 'vitest';
import { editDistance, parseSqlError, suggestIdentifier } from './sqlErrors';

describe('parseSqlError', () => {
  it('reads an unknown column from all three engines', () => {
    expect(parseSqlError("Unknown column 'id' in 'field list'")).toMatchObject({
      kind: 'unknown-column', identifier: 'id',
    });
    expect(parseSqlError('column "note" does not exist')).toMatchObject({
      kind: 'unknown-column', identifier: 'note',
    });
    expect(parseSqlError('no such column: note')).toMatchObject({
      kind: 'unknown-column', identifier: 'note',
    });
  });

  it('splits a qualified name so the table is available for context', () => {
    expect(parseSqlError("Unknown column 'orders.total' in 'field list'")).toMatchObject({
      kind: 'unknown-column', identifier: 'total', qualifier: 'orders',
    });
  });

  it('reads an unknown table', () => {
    expect(parseSqlError("Table 'acme.oders' doesn't exist")).toMatchObject({
      kind: 'unknown-table', identifier: 'oders', qualifier: 'acme',
    });
    expect(parseSqlError('relation "oders" does not exist')).toMatchObject({
      kind: 'unknown-table', identifier: 'oders',
    });
  });

  it('classifies syntax errors and falls back to other', () => {
    expect(parseSqlError('You have an error in your SQL syntax near ...').kind).toBe('syntax');
    expect(parseSqlError('Lost connection to server').kind).toBe('other');
  });
});

describe('editDistance', () => {
  it('measures the usual way', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });

  it('is case-insensitive, because SQL identifiers usually are', () => {
    expect(editDistance('ER_ID', 'er_id')).toBe(0);
  });

  it('bails out past the cap instead of doing the full matrix', () => {
    // Guard against a 400-table x 40-column scan becoming quadratic in
    // string length for pairs that could never match.
    expect(editDistance('a', 'a-very-long-identifier-name')).toBeGreaterThan(4);
  });
});

describe('suggestIdentifier', () => {
  const columns = [
    { name: 'er_id', context: 'email_record' },
    { name: 'email_addr', context: 'email_record' },
    { name: 'create_date', context: 'email_record' },
    { name: 'content_count', context: 'email_record' },
  ];

  it('promotes a prefixed key over raw edit distance', () => {
    // `id` -> `er_id` is distance 3, which pure Levenshtein would rank
    // poorly, but a prefixed primary key is the single most common real
    // miss when someone guesses a column name.
    expect(suggestIdentifier('id', columns)[0].name).toBe('er_id');
  });

  it('handles an ordinary typo', () => {
    expect(suggestIdentifier('creat_date', columns)[0].name).toBe('create_date');
  });

  it('keeps the table it came from, so the UI can say where', () => {
    expect(suggestIdentifier('er_id', columns)[0].context).toBe('email_record');
  });

  it('returns nothing when nothing is close', () => {
    expect(suggestIdentifier('zzzzzzzz', columns)).toEqual([]);
  });

  it('respects the limit', () => {
    expect(suggestIdentifier('e', columns, 2).length).toBeLessThanOrEqual(2);
  });
});
