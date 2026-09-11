// Sorting rows we already have, which is normally the wrong thing to do.
//
// src/shared/orderBy.ts argues the case: the grid holds at most the row cap,
// so sorting locally sorts an arbitrary slice and presents it as if it were
// the top of the table. Re-asking the server is the honest answer, and on
// Postgres, MySQL and SQLite it is available.
//
// DynamoDB cannot do it. There is no ORDER BY except a reversal of the sort
// key on a key lookup, and no subquery to wrap the statement in — so the
// choice there is not "local or server", it is "local or nothing". Local
// wins, on the condition that the UI says what was actually sorted: the rows
// that came back, not the table.

import type { Cell, CellKind } from './types';

export type SortDirection = 'asc' | 'desc';

function isBlank(cell: Cell): boolean {
  return cell === null || cell === undefined || cell === '';
}

function text(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'object' && '__bin' in cell) return `<${cell.byteLength} bytes>`;
  return String(cell);
}

/// Rows in a new array, ordered by one column.
///
/// Numbers are compared as numbers — DynamoDB sends every N attribute as a
/// string, so a lexicographic sort would put 100 before 2 and look broken —
/// and blanks sort last in both directions, because an attribute that is
/// simply absent from an item is not "the smallest value", it is no answer
/// at all and belongs out of the way.
export function sortRows(
  rows: Cell[][],
  column: number,
  direction: SortDirection,
  kind: CellKind | undefined,
): Cell[][] {
  const numeric =
    kind === 'int' || kind === 'bigint' || kind === 'float' || kind === 'decimal';
  const sign = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const x = a[column];
    const y = b[column];
    if (isBlank(x) && isBlank(y)) return 0;
    if (isBlank(x)) return 1;
    if (isBlank(y)) return -1;

    if (numeric) {
      const nx = Number(text(x));
      const ny = Number(text(y));
      if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * sign;
    }
    // `numeric: true` so item-7 sorts before item-11 — DynamoDB keys are
    // full of exactly that shape.
    return text(x).localeCompare(text(y), undefined, { numeric: true }) * sign;
  });
}
