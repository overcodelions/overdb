import { describe, expect, it } from 'vitest';
import { sortRows } from './sortRows';

const rows = [
  ['b', '100'],
  ['a', '2'],
  ['c', null],
];

describe('sortRows', () => {
  it('sorts numbers as numbers, not as the strings DynamoDB sends', () => {
    expect(sortRows(rows, 1, 'asc', 'decimal').map((r) => r[1])).toEqual(['2', '100', null]);
  });

  it('sorts text', () => {
    expect(sortRows(rows, 0, 'desc', 'text').map((r) => r[0])).toEqual(['c', 'b', 'a']);
  });

  it('keeps missing attributes out of the way in both directions', () => {
    // An item that simply lacks the attribute is not the smallest value.
    expect(sortRows(rows, 1, 'asc', 'decimal')[2][1]).toBeNull();
    expect(sortRows(rows, 1, 'desc', 'decimal')[2][1]).toBeNull();
  });

  it('orders item-7 before item-11', () => {
    const keys = [['item-11'], ['item-7'], ['item-2']];
    expect(sortRows(keys, 0, 'asc', 'text').map((r) => r[0])).toEqual([
      'item-2', 'item-7', 'item-11',
    ]);
  });

  it('leaves the original array alone', () => {
    const original = [...rows];
    sortRows(rows, 0, 'desc', 'text');
    expect(rows).toEqual(original);
  });
});
