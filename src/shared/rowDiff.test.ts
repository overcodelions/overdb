import { describe, expect, it } from 'vitest';
import { blankRun, type MemberRun } from './fanout';
import {
  candidateKeys,
  cellToken,
  keyProblem,
  pickKey,
  rowDiff,
  rowDiffSentence,
  sameRowSet,
  type KeyedTable,
} from './rowDiff';
import type { Cell, ColumnMeta } from './types';

const col = (name: string, table: string | null = 'orders', column = name): ColumnMeta => ({
  name,
  typeName: 'text',
  kind: 'text',
  nullable: true,
  sourceTable: table ? { schema: 'public', table, column } : null,
});

const run = (id: string, columns: ColumnMeta[], rows: Cell[][]): MemberRun => ({
  ...blankRun(id, 'postgres'),
  status: 'done',
  columns,
  rows,
  rowCount: rows.length,
});

const orders: KeyedTable = {
  schema: 'public',
  name: 'orders',
  primaryKey: ['id'],
  indexes: [{ name: 'orders_ref_key', columns: ['ref'], unique: true }],
};

const cols = [col('id'), col('ref'), col('status')];

describe('candidateKeys', () => {
  it('offers the primary key, then unique indexes, of a table the rows came from', () => {
    expect(candidateKeys(cols, [orders])).toEqual([
      { columns: ['id'], source: 'orders primary key' },
      { columns: ['ref'], source: 'orders unique index orders_ref_key' },
    ]);
  });

  it('names the key by the RESULT column, which an alias may have renamed', () => {
    const aliased = [col('order_id', 'orders', 'id'), col('status')];
    expect(candidateKeys(aliased, [orders])[0].columns).toEqual(['order_id']);
  });

  it('offers nothing when a key column did not come back', () => {
    expect(candidateKeys([col('status')], [orders])).toEqual([]);
  });

  // Never from a column called `id` on its own — only from the catalog.
  it('offers nothing for an expression, whatever it is called', () => {
    expect(candidateKeys([col('id', null)], [orders])).toEqual([]);
  });
});

describe('keyProblem and pickKey', () => {
  it('refuses a key that is not unique in this result', () => {
    // orders joined to line items: one order id per line.
    const joined = run('a', cols, [[1, 'r1', 'paid'], [1, 'r1', 'paid']]);
    expect(keyProblem(['id'], joined, 'prod')).toContain('not unique');
  });

  it('refuses a key with a null in it', () => {
    expect(keyProblem(['ref'], run('a', cols, [[1, null, 'paid']]), 'prod')).toContain('no value');
  });

  it('takes the first candidate that pairs both sides', () => {
    const a = run('a', cols, [[1, 'r1', 'x'], [1, 'r2', 'y']]);
    const b = run('b', cols, [[1, 'r1', 'x']]);
    expect(pickKey(candidateKeys(cols, [orders]), a, b)?.columns).toEqual(['ref']);
  });
});

describe('rowDiff, keyed', () => {
  const base = run('base', cols, [[1, 'r1', 'paid'], [2, 'r2', 'paid'], [3, 'r3', 'open']]);
  const here = run('here', cols, [[2, 'r2', 'refunded'], [1, 'r1', 'paid'], [4, 'r4', 'open']]);

  it('sorts rows into only-there, only-here, changed and the same', () => {
    const d = rowDiff(base, here, ['id']);
    expect(d.onlyBaseline).toEqual([[3, 'r3', 'open']]);
    expect(d.onlyHere).toEqual([[4, 'r4', 'open']]);
    expect(d.changed).toEqual([
      { key: [2], changed: [{ column: 'status', baseline: 'paid', here: 'refunded' }] },
    ]);
    expect(d.same).toBe(1);
    expect(rowDiffSentence(d, 'prod', 'staging')).toBe(
      '1 only in prod · 1 only in staging · 1 changed · 1 the same.',
    );
  });

  it('pairs columns by name, so a reordered SELECT still lines up', () => {
    const swapped = run('here', [col('status'), col('id'), col('ref')], [
      ['paid', 1, 'r1'],
      ['paid', 2, 'r2'],
      ['open', 3, 'r3'],
    ]);
    const d = rowDiff(base, swapped, ['id']);
    expect(d.changed).toEqual([]);
    expect(d.same).toBe(3);
  });

  it('compares only the columns both sides returned', () => {
    const narrow = run('here', [col('id'), col('status')], [[1, 'paid'], [2, 'paid'], [3, 'open']]);
    const d = rowDiff(base, narrow, ['id']);
    expect(d.columns).toEqual(['id', 'status']);
    expect(d.same).toBe(3);
  });

  it('says when the only difference is the order', () => {
    const reversed = run('here', cols, [...base.rows].reverse());
    const d = rowDiff(base, reversed, ['id']);
    expect(d.orderOnly).toBe(true);
    expect(rowDiffSentence(d, 'prod', 'staging')).toBe('The same rows, in a different order.');
  });

  it('is strict about a number against the same digits as a string', () => {
    const typed = run('here', cols, [[1, 'r1', 'paid'], [2, 'r2', 'paid'], [3, 'r3', 'open']]);
    const stringy = run('there', cols, [['1', 'r1', 'paid'], [2, 'r2', 'paid'], [3, 'r3', 'open']]);
    expect(cellToken(1)).not.toBe(cellToken('1'));
    expect(rowDiff(typed, stringy, ['ref']).changed).toHaveLength(1);
  });
});

describe('rowDiff, whole rows', () => {
  it('counts a duplicated row as a difference of one row', () => {
    const a = run('a', cols, [[1, 'r1', 'x'], [1, 'r1', 'x']]);
    const b = run('b', cols, [[1, 'r1', 'x']]);
    const d = rowDiff(a, b, null);
    expect(d.onlyBaseline).toEqual([[1, 'r1', 'x']]);
    expect(d.onlyHere).toEqual([]);
    expect(d.same).toBe(1);
  });

  it('treats the same rows in another order as the same rows', () => {
    const a = run('a', cols, [[1, 'r1', 'x'], [2, 'r2', 'y']]);
    const b = run('b', cols, [[2, 'r2', 'y'], [1, 'r1', 'x']]);
    expect(sameRowSet(a, b)).toBe(true);
    expect(rowDiff(a, b, null).orderOnly).toBe(true);
  });

  it('compares binary cells by what they carry', () => {
    const bin = { __bin: true as const, b64: 'AAE=', byteLength: 2, truncated: false };
    const a = run('a', [col('blob')], [[bin]]);
    const b = run('b', [col('blob')], [[{ ...bin }]]);
    expect(sameRowSet(a, b)).toBe(true);
  });

  it('falls back to whole rows when the key is not among the shared columns', () => {
    const a = run('a', cols, [[1, 'r1', 'x']]);
    const b = run('b', [col('ref'), col('status')], [['r1', 'x']]);
    expect(rowDiff(a, b, ['id']).key).toBeNull();
  });
});
