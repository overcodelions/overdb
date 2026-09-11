// Changing one cell, safely.
//
// The whole risk of an editable grid is in one question: does the UPDATE
// this gesture writes hit exactly the row you clicked? A cell is editable
// only when the answer is provably yes, and the check has three parts:
//
//   1. THE COLUMN IS A STORED COLUMN. `count(*)`, a literal and a computed
//      expression have nowhere to be written back to. The adapters already
//      answer this — `ColumnMeta.sourceTable` is null for anything the
//      server would not name a table and column for.
//   2. THE ROW IS ADDRESSABLE. The projection has to carry a key that
//      identifies one row — the primary key, or a unique index. `select
//      email, a_type from access_log` is not editable, because the UPDATE
//      it implies would rewrite every row sharing that email.
//   3. THE VALUE IS A PARAMETER, never string-interpolated. A cell holding
//      `'); drop table` is a value, and the only reason it stays one is that
//      it never touches the statement text.
//
// Anything that fails says WHICH part failed, because "not editable" with no
// reason is indistinguishable from a bug.

import { quoteIdent } from './orderBy';
import type { Cell, ColumnMeta, Engine } from './types';

/// What the catalog knows about a table, which is the half the result set
/// cannot tell us: which columns address exactly one row.
export interface KeyedTable {
  schema: string;
  name: string;
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
}

export interface EditTarget {
  schema: string | null;
  table: string;
  /// The column being written, as the server names it.
  column: string;
  /// Which grid columns address the row, and where to read their values.
  keys: Array<{ column: string; index: number }>;
  /// What made the row addressable, for the confirmation to say out loud.
  keySource: 'primary key' | string;
}

export type EditCheck = { ok: true; target: EditTarget } | { ok: false; reason: string };

/// Whether this cell can be written back, and how to address it.
export function editTarget(
  columns: ColumnMeta[],
  columnIndex: number,
  tables: KeyedTable[],
): EditCheck {
  const col = columns[columnIndex];
  if (!col) return { ok: false, reason: 'No such column.' };

  const src = col.sourceTable;
  if (!src) {
    return {
      ok: false,
      reason: `${col.name} is not a stored column — it is computed by the query, so there is nothing to write it back to.`,
    };
  }

  const info = tables.find(
    (t) => t.name === src.table && (!src.schema || t.schema === src.schema),
  );
  if (!info) {
    return {
      ok: false,
      reason: `The catalog has no ${src.table}, so overdb cannot tell how many rows an update would hit.`,
    };
  }

  // Primary key first; a unique index is the same guarantee by another name,
  // and is how a table with a natural key is usually written.
  const candidates: Array<{ columns: string[]; source: string }> = [
    ...(info.primaryKey.length ? [{ columns: info.primaryKey, source: 'primary key' }] : []),
    ...info.indexes.filter((i) => i.unique && i.columns.length).map((i) => ({
      columns: i.columns,
      source: i.name,
    })),
  ];
  if (!candidates.length) {
    return {
      ok: false,
      reason: `${info.name} has no primary key or unique index, so no update can be limited to one row.`,
    };
  }

  for (const candidate of candidates) {
    const keys = candidate.columns.map((name) => ({
      column: name,
      index: columns.findIndex(
        (c) => c.sourceTable?.table === src.table && c.sourceTable?.column === name,
      ),
    }));
    if (keys.every((k) => k.index >= 0)) {
      return {
        ok: true,
        target: {
          schema: src.schema,
          table: src.table,
          column: src.column,
          keys,
          keySource: candidate.source,
        },
      };
    }
  }

  const missing = candidates[0].columns.join(', ');
  return {
    ok: false,
    reason: `This result does not carry ${info.name}'s ${
      candidates[0].source === 'primary key' ? 'primary key' : `unique key ${candidates[0].source}`
    } (${missing}), so an update could not be limited to the row you clicked. Select it and try again.`,
  };
}

/// Postgres numbers its placeholders; MySQL and SQLite do not.
function placeholder(engine: Engine, n: number): string {
  return engine === 'postgres' ? `$${n}` : '?';
}

/// The statement, and the values that stay OUT of it.
///
/// A key value is passed as a parameter too, not just the new value: the
/// cell you are addressing by can hold anything a cell can hold.
export function buildUpdate(
  target: EditTarget,
  value: Cell,
  keyValues: Cell[],
  engine: Engine,
): { sql: string; params: Cell[] } {
  const name = target.schema
    ? `${quoteIdent(target.schema, engine)}.${quoteIdent(target.table, engine)}`
    : quoteIdent(target.table, engine);

  let n = 0;
  const set = `${quoteIdent(target.column, engine)} = ${placeholder(engine, ++n)}`;
  const where = target.keys
    .map((k, i) =>
      // A NULL key is not addressable with `=` — nothing equals NULL — so it
      // is written as the IS test it has to be, and takes no parameter.
      keyValues[i] === null
        ? `${quoteIdent(k.column, engine)} is null`
        : `${quoteIdent(k.column, engine)} = ${placeholder(engine, ++n)}`,
    )
    .join(' and ');

  return {
    sql: `update ${name} set ${set} where ${where}`,
    params: [value, ...keyValues.filter((v) => v !== null)],
  };
}

/// What the statement looks like with its values in it — for the
/// confirmation only. NEVER executed: the executed statement carries
/// placeholders, and this exists so the person approving it can see what
/// they are approving rather than a row of question marks.
export function previewUpdate(sql: string, params: Cell[], engine: Engine): string {
  let i = 0;
  return sql.replace(engine === 'postgres' ? /\$\d+/g : /\?/g, () => display(params[i++]));
}

function display(value: Cell): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && '__bin' in value) return `<${value.byteLength} bytes>`;
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`;
}
