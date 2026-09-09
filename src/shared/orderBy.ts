// Sorting a result means re-asking the server, not re-ordering what we
// already fetched.
//
// That distinction matters: the grid holds at most `rowLimit` rows, so
// sorting locally would sort the arbitrary first 1,000 rows and present the
// result as if it were the top 1,000 — which is wrong in a way the user
// cannot see. Wrapping the original statement and letting the database sort
// gives the actual answer.

import type { Engine } from './types';

export type SortDirection = 'asc' | 'desc';

/// Identifier quoting differs per engine, and a column name can legally
/// contain the quote character, so escaping is not optional.
export function quoteIdent(name: string, engine: Engine): string {
  if (engine === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  return '"' + name.replace(/"/g, '""') + '"';
}

/// Wrap a statement in a sorting outer query.
///
/// Wrapping rather than editing the user's SQL is deliberate: their text may
/// already carry its own ORDER BY, a LIMIT, a CTE or a UNION, and rewriting
/// any of those correctly is a parser's job. A derived table composes with
/// all of them, and leaves the query they wrote untouched on screen.
export function wrapWithOrderBy(
  sql: string,
  column: string,
  direction: SortDirection,
  engine: Engine,
): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  const col = quoteIdent(column, engine);
  const alias = quoteIdent('overdb_sorted', engine);
  return `select * from (\n${inner}\n) as ${alias} order by ${col} ${direction}`;
}

/// Only a plain read can be safely wrapped. A statement with no result set
/// has nothing to sort, and wrapping a write would change what it does.
export function isSortable(kind: string): boolean {
  return kind === 'read';
}
