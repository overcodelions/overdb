// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatRows, insertTarget } from './exportRows';
import type { Cell, ColumnMeta } from './types';

const col = (name: string, kind: ColumnMeta['kind'], table?: string): ColumnMeta => ({
  name, typeName: kind, kind, nullable: null,
  sourceTable: table ? { schema: null, table, column: name } : null,
});

const columns = [col('id', 'int', 'orders'), col('note', 'text', 'orders'), col('amount', 'decimal', 'orders')];
const rows: Cell[][] = [
  ['1', 'hello', '19.99'],
  ['2', null, '0.10'],
  ['3', '', '1000'],
];

describe('csv / tsv', () => {
  it('quotes only when RFC 4180 requires it, and doubles inner quotes', () => {
    const out = formatRows([col('a', 'text')], [['plain']], 'csv');
    expect(out.split('\n')[1]).toBe('plain');
    expect(formatRows([col('a', 'text')], [['has,comma']], 'csv').split('\n')[1]).toBe('"has,comma"');
    expect(formatRows([col('a', 'text')], [['say "hi"']], 'csv').split('\n')[1]).toBe('"say ""hi"""');
    expect(formatRows([col('a', 'text')], [['two\nlines']], 'csv').split('\n')[1]).toBe('"two');
  });

  it('does not quote a comma-bearing field in TSV, where a comma is data', () => {
    expect(formatRows([col('a', 'text')], [['has,comma']], 'tsv').split('\n')[1]).toBe('has,comma');
  });

  it('collapses NULL and empty string by default, and can be told not to', () => {
    // The honest default (empty, per convention) loses a distinction the
    // grid works hard to show — so nullAs exists and the UI says so.
    const dflt = formatRows(columns, rows, 'csv').split('\n');
    expect(dflt[2]).toBe('2,,0.10');
    expect(dflt[3]).toBe('3,,1000');

    const explicit = formatRows(columns, rows, 'csv', { nullAs: 'NULL' }).split('\n');
    expect(explicit[2]).toBe('2,NULL,0.10');
    expect(explicit[3]).toBe('3,,1000');
  });

  it('can omit headers', () => {
    expect(formatRows(columns, rows, 'tsv', { headers: false }).split('\n')).toHaveLength(3);
  });
});

describe('json', () => {
  it('is the one format that preserves NULL exactly', () => {
    const parsed = JSON.parse(formatRows(columns, rows, 'json'));
    expect(parsed[1].note).toBeNull();
    expect(parsed[2].note).toBe('');
  });

  it('describes a binary cell rather than pretending it is text', () => {
    const parsed = JSON.parse(
      formatRows([col('b', 'bytes')], [[{ __bin: true, b64: '3q2+7w==', byteLength: 4, truncated: false }]], 'json'),
    );
    expect(parsed[0].b).toEqual({ base64: '3q2+7w==', byteLength: 4, truncated: false });
  });
});

describe('insert', () => {
  it('names the source table and quotes correctly by kind', () => {
    const out = formatRows(columns, [rows[0]], 'insert');
    expect(out).toBe("insert into orders (id, note, amount) values (1, 'hello', 19.99);");
  });

  it('uses the SOURCE column name, not the display alias', () => {
    // `pw.id AS panel_widget_id` must insert into `id`. Using the alias
    // produces a statement naming a column that exists on no table.
    const aliased: ColumnMeta[] = [
      { name: 'panel_widget_id', typeName: 'varchar', kind: 'text', nullable: null,
        sourceTable: { schema: null, table: 'panel_widget', column: 'id' } },
    ];
    expect(formatRows(aliased, [['x']], 'insert')).toBe(
      "insert into panel_widget (id) values ('x');",
    );
  });

  it('refuses when the columns span several tables', () => {
    // A joined row belongs to no single table. Emitting `insert into client`
    // with panel_widget's columns is syntactically fine and complete
    // nonsense — worse than nothing, because it looks runnable.
    const joined: ColumnMeta[] = [
      { name: 'client_name', typeName: 'varchar', kind: 'text', nullable: null,
        sourceTable: { schema: null, table: 'client', column: 'client_name' } },
      { name: 'widget_name', typeName: 'varchar', kind: 'text', nullable: null,
        sourceTable: { schema: null, table: 'panel_widget', column: 'name' } },
    ];
    const out = formatRows(joined, [['HP', 'Tracking']], 'insert');
    expect(out).not.toMatch(/^insert/m);
    expect(out).toContain('client, panel_widget');
  });

  it('refuses when a column is computed', () => {
    const computed: ColumnMeta[] = [
      { name: 'n', typeName: 'bigint', kind: 'bigint', nullable: null, sourceTable: null },
    ];
    expect(formatRows(computed, [['1']], 'insert')).toContain('computed');
  });
});

describe('insertTarget', () => {
  const c = (name: string, table: string | null, column = name): ColumnMeta => ({
    name, typeName: 'text', kind: 'text', nullable: null,
    sourceTable: table ? { schema: null, table, column } : null,
  });

  it('accepts a single-table selection', () => {
    expect(insertTarget([c('a', 'orders'), c('b', 'orders')])).toEqual({ ok: true, table: 'orders' });
  });

  it('rejects a join, naming the tables involved', () => {
    const r = insertTarget([c('a', 'orders'), c('b', 'customers')]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('customers');
  });

  it('rejects an expression column, naming it', () => {
    const r = insertTarget([c('a', 'orders'), c('total', null)]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('total');
  });

  it('rejects an empty selection', () => {
    expect(insertTarget([]).ok).toBe(false);
  });

  it('writes NULL unquoted and escapes embedded quotes', () => {
    expect(formatRows(columns, [['2', "it's", '1']], 'insert')).toContain("'it''s'");
    expect(formatRows(columns, [rows[1]], 'insert')).toContain('NULL');
  });

  it('quotes a numeric column whose value is not actually a number', () => {
    // A decimal column holding 'NaN' or 'Infinity' must not become a bare
    // token that fails to parse on the way back in.
    expect(formatRows([col('n', 'decimal', 't')], [['NaN']], 'insert')).toContain("'NaN'");
    expect(formatRows([col('n', 'decimal', 't')], [['12.5']], 'insert')).toContain('(12.5)');
  });

  it('emits binary as a hex literal', () => {
    const out = formatRows([col('b', 'bytes', 't')], [[{ __bin: true, b64: '3q2+7w==', byteLength: 4, truncated: false }]], 'insert');
    expect(out).toContain("X'deadbeef'");
  });
});

describe('markdown', () => {
  it('escapes pipes so the table does not break', () => {
    expect(formatRows([col('a', 'text')], [['a|b']], 'markdown')).toContain('a\\|b');
  });
});

describe('markdown escaping', () => {
  it('escapes a backslash before the pipe, so a value cannot end a cell early', () => {
    // Escaping only the pipe turned `\|` in a value into `\\|`: an escaped
    // backslash followed by a live separator.
    const out = formatRows([col('a', 'text')], [['back\\slash|pipe']], 'markdown');
    expect(out).toContain('back\\\\slash\\|pipe');
  });
});
