// Filtering and sorting a result by re-asking the server.
//
// The rule this module exists to keep: the grid holds at most the row cap,
// so a filter applied to the rows in hand answers a different question than
// the one being asked. "a_type = 1" over the 200 rows fetched from a table
// of 451 is not "the rows where a_type is 1" — and nothing on screen would
// say so. Same argument as sorting (src/shared/orderBy.ts): re-ask, and the
// answer is the real one.
//
// The statement the user wrote is never edited. It goes inside a derived
// table, which composes with the CTEs, unions, existing ORDER BY and LIMIT
// they may already have written — all of which a rewriter would have to
// parse correctly, and would eventually get wrong.
//
// DynamoDB is not here: PartiQL has no subqueries to wrap in. Its filters
// are added to the statement itself, in src/shared/dynamo.ts.

import { quoteIdent, type SortDirection } from './orderBy';
import type { Engine } from './types';

export type FilterOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'contains'
  | 'starts'
  | 'is null'
  | 'is not null';

export interface GridFilter {
  column: string;
  op: FilterOp;
  /// Ignored by the two null operators, which is why it is optional.
  value?: string;
}

export interface GridView {
  filters: GridFilter[];
  sort: { column: string; direction: SortDirection } | null;
}

export const EMPTY_VIEW: GridView = { filters: [], sort: null };

/// Operators that need no operand. Kept as data because both the predicate
/// builder and the UI have to agree about it.
export function needsValue(op: FilterOp): boolean {
  return op !== 'is null' && op !== 'is not null';
}

/// A value the server will compare correctly.
///
/// Everything arrives from the grid as a string, because that is how the
/// drivers hand it over (type parsing is off — see the adapters). A bare
/// number stays bare so it compares numerically; everything else is quoted,
/// with the quote doubled the way SQL escapes it. `null` typed into the box
/// is the literal NULL, since a filter of `= 'null'` is never what anyone
/// means — and `= NULL` is never true, so the operator moves to IS.
function sqlLiteral(value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return `'${value.replace(/'/g, "''")}'`;
}

export function predicate(filter: GridFilter, engine: Engine): string {
  const col = quoteIdent(filter.column, engine);
  const value = filter.value ?? '';

  if (filter.op === 'is null') return `${col} is null`;
  if (filter.op === 'is not null') return `${col} is not null`;

  // Typing `null` into the box means the null test, not a string comparison
  // that can never match.
  if (/^null$/i.test(value.trim())) return `${col} is ${filter.op === '!=' ? 'not ' : ''}null`;

  if (filter.op === 'contains' || filter.op === 'starts') {
    // The wildcards belong to LIKE, so a value containing % or _ has to be
    // escaped or it silently matches more than it says.
    const escaped = value.replace(/([%_\\])/g, '\\$1');
    const pattern = filter.op === 'starts' ? `${escaped}%` : `%${escaped}%`;
    return `${col} like ${sqlLiteral(pattern)}`;
  }

  return `${col} ${filter.op} ${sqlLiteral(value)}`;
}

/// The statement to actually send, given what the grid is showing.
///
/// Returns the original untouched when there is nothing to apply, so an
/// unfiltered, unsorted tab re-runs exactly what the user wrote.
export function deriveStatement(sql: string, view: GridView, engine: Engine): string {
  const filters = view.filters.filter((f) => !needsValue(f.op) || (f.value ?? '').trim() !== '');
  if (!filters.length && !view.sort) return sql;

  const inner = sql.trim().replace(/;\s*$/, '');
  const alias = quoteIdent('overdb_view', engine);
  const lines = [`select * from (\n${inner}\n) as ${alias}`];
  if (filters.length) {
    lines.push(`where ${filters.map((f) => predicate(f, engine)).join('\n  and ')}`);
  }
  if (view.sort) {
    lines.push(`order by ${quoteIdent(view.sort.column, engine)} ${view.sort.direction}`);
  }
  return lines.join('\n');
}

/// Cycling one column's filter through the list: replace it, or drop it when
/// the value is cleared. One column carries one filter — two predicates on
/// the same column is a range, and a range needs a UI this one is not.
export function withFilter(filters: GridFilter[], next: GridFilter): GridFilter[] {
  const rest = filters.filter((f) => f.column !== next.column);
  if (needsValue(next.op) && (next.value ?? '').trim() === '') return rest;
  return [...rest, next];
}
