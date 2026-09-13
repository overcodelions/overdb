// Turning a result selection into text.
//
// The awkward bit throughout is NULL. overdb goes to some trouble to keep
// NULL and '' visually distinct in the grid, and most export formats have
// no way to preserve that: a CSV field is empty either way. Rather than
// pick silently, each format states what it does, and the CSV/TSV writers
// take `nullAs` so the caller can choose to be explicit.

import type { Cell, ColumnMeta } from './types';

export type ExportFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert';

export interface ExportOptions {
  /// Include a header row. Meaningless for json and insert.
  headers?: boolean;
  /// Text substituted for SQL NULL in tsv/csv. Empty string is the common
  /// convention and loses the NULL/'' distinction; 'NULL' or '\\N' keeps it.
  nullAs?: string;
  /// Table name for INSERT output. Falls back to the columns' source table.
  table?: string;
}

/// The renderer is sandboxed with no Node globals, so this module — which
/// runs there — must not touch Buffer.
function b64ToHex(b64: string): string {
  const bin = atob(b64);
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

function plain(value: Cell, nullAs: string): string {
  if (value === null) return nullAs;
  if (typeof value === 'object' && '__bin' in value) {
    return `0x${b64ToHex(value.b64)}`;
  }
  return String(value);
}

/// RFC 4180: quote when the field contains a delimiter, a quote, or a
/// newline, and escape quotes by doubling.
function csvField(text: string, delimiter: string): string {
  if (text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sqlLiteral(value: Cell, column: ColumnMeta): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object' && '__bin' in value) {
    return `X'${b64ToHex(value.b64)}'`;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const numeric =
    column.kind === 'int' || column.kind === 'bigint' ||
    column.kind === 'float' || column.kind === 'decimal';
  // Numbers are emitted unquoted, but only when they actually look like
  // numbers — a decimal column holding 'NaN' must not become bare NaN.
  if (numeric && typeof value !== 'object' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(String(value))) {
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function formatRows(
  columns: ColumnMeta[],
  rows: Cell[][],
  format: ExportFormat,
  options: ExportOptions = {},
): string {
  const { headers = true, nullAs = '' } = options;

  switch (format) {
    case 'tsv':
    case 'csv': {
      const delimiter = format === 'csv' ? ',' : '\t';
      const lines: string[] = [];
      if (headers) {
        lines.push(columns.map((c) => csvField(c.name, delimiter)).join(delimiter));
      }
      for (const row of rows) {
        lines.push(
          row.map((v) => csvField(plain(v, nullAs), delimiter)).join(delimiter),
        );
      }
      return lines.join('\n');
    }

    case 'json': {
      // The only format that preserves NULL exactly, which is worth saying
      // out loud in the UI when someone is exporting to compare results.
      const objects = rows.map((row) => {
        const o: Record<string, unknown> = {};
        columns.forEach((c, i) => {
          const v = row[i];
          o[c.name] = v !== null && typeof v === 'object' && '__bin' in v
            ? { base64: v.b64, byteLength: v.byteLength, truncated: v.truncated }
            : v;
        });
        return o;
      });
      return JSON.stringify(objects, null, 2);
    }

    case 'markdown': {
      const head = `| ${columns.map((c) => c.name).join(' | ')} |`;
      const rule = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map(
        // Backslashes first. Escaping only the pipe turns a value that
        // already ends in `\` into `\\|` — an escaped backslash followed
        // by a live separator — and the row splits into one cell too many.
        (row) =>
          `| ${row
            .map((v) => plain(v, nullAs || 'NULL').replace(/\\/g, '\\\\').replace(/\|/g, '\\|'))
            .join(' | ')} |`,
      );
      return [head, rule, ...body].join('\n');
    }

    case 'insert': {
      const target = insertTarget(columns);
      if (!target.ok) {
        // Emitting something syntactically valid but semantically nonsense
        // is worse than emitting nothing: it looks runnable. A joined result
        // is not a row of any one table, and aliases are not column names.
        return `-- Cannot build INSERT statements from this selection.\n-- ${target.reason}`;
      }
      // The SOURCE column names, not the display names. `pw.id AS
      // panel_widget_id` must insert into `id`; there is no
      // `panel_widget_id` column on any table.
      const names = columns.map((c) => c.sourceTable!.column).join(', ');
      return rows
        .map(
          (row) =>
            `insert into ${target.table} (${names}) values (${row
              .map((v, i) => sqlLiteral(v, columns[i]))
              .join(', ')});`,
        )
        .join('\n');
    }
  }
}

/// An INSERT is only well-defined when every selected column comes from the
/// SAME table. A join produces a row that belongs to no single table, and an
/// expression column belongs to nothing at all — in both cases there is no
/// honest statement to generate.
export function insertTarget(
  columns: ColumnMeta[],
): { ok: true; table: string } | { ok: false; reason: string } {
  if (columns.length === 0) return { ok: false, reason: 'No columns selected.' };

  const unsourced = columns.filter((c) => !c.sourceTable);
  if (unsourced.length > 0) {
    return {
      ok: false,
      reason: `${unsourced.map((c) => c.name).join(', ')} ${
        unsourced.length === 1 ? 'is' : 'are'
      } computed, so ${unsourced.length === 1 ? 'it belongs' : 'they belong'} to no table.`,
    };
  }

  const tables = [...new Set(columns.map((c) => c.sourceTable!.table))];
  if (tables.length > 1) {
    return {
      ok: false,
      reason: `The selected columns come from ${tables.length} tables (${tables.join(
        ', ',
      )}). Select columns from one table to build an INSERT.`,
    };
  }
  return { ok: true, table: tables[0] };
}

/// What each format does with NULL, for the UI to show rather than make
/// the user discover by pasting somewhere and finding out.
export function nullBehaviour(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'NULL is preserved exactly.';
    case 'insert':
      return 'NULL becomes the NULL keyword.';
    case 'markdown':
      return 'NULL is written as the text NULL.';
    default:
      return "NULL becomes an empty field — indistinguishable from ''.";
  }
}
