import { describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaSnapshot, TableInfo } from './types';
import { diffSchemas, consequenceOf } from './schemaDiff';
import { tableGrid, tableRows, wordDiff } from './driftDdl';

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, ordinal: 1, typeName: 'int', nullable: true, defaultExpr: null, ...patch };
}

function table(name: string, patch: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    kind: 'table',
    columns: [column('id', { nullable: false })],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    ...patch,
  };
}

function snap(tables: TableInfo[]): SchemaSnapshot {
  return { engine: 'mysql', serverVersion: '8', capturedAt: '', schemas: [{ name: 'app', tables }] };
}

/// Rows as `name | baseline | here`, which is how a person reads them.
function draw(base: TableInfo, here: TableInfo, expand = false): string[] {
  const drift = diffSchemas(snap([base]), snap([here]));
  return tableRows(drift.findings, base, here, { expand }).map((r) =>
    r.fold ?? `${r.name} | ${r.baseline ?? '—'} | ${r.here ?? '—'}`,
  );
}

describe('tableRows', () => {
  const cols = (d: string | null, type = 'timestamp') => [
    column('id', { nullable: false }),
    column('a'),
    column('b'),
    column('locked_at', { typeName: type, nullable: false, defaultExpr: d }),
  ];

  it('puts a changed column on one row, the baseline beside this member', () => {
    expect(
      draw(
        table('lock', { columns: cols(null) }),
        table('lock', { columns: cols('CURRENT_TIMESTAMP', 'datetime') }),
      ),
    ).toEqual([
      '⋯ 3 matching columns',
      'locked_at | timestamp NOT NULL | datetime NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]);
  });

  it('draws the agreeing rows instead of a count when asked', () => {
    const lines = draw(
      table('lock', { columns: cols(null) }),
      table('lock', { columns: cols('1') }),
      true,
    );
    expect(lines[0]).toBe('id | int NOT NULL | int NOT NULL');
    expect(lines.some((l) => l.startsWith('⋯'))).toBe(false);
  });

  it('leaves the side without it empty', () => {
    const idx = [
      { name: 'by_a', columns: ['a'], unique: false },
      { name: 'by_b', columns: ['b'], unique: true },
    ];
    const lines = draw(table('t', { indexes: idx }), table('t', { indexes: [idx[0]] }));
    expect(lines).toContain('by_b | UNIQUE KEY (b) | —');
    expect(lines).toContain('⋯ 1 matching index or key');
  });

  it('names a referenced schema only when it is another one', () => {
    for (const [refSchema, text] of [
      ['app', 'REFERENCES team(id)'],
      ['other', 'REFERENCES other.team(id)'],
    ]) {
      const base = table('t', {
        foreignKeys: [{ name: 'fk', columns: ['team_id'], refSchema, refTable: 'team', refColumns: ['id'] }],
      });
      expect(draw(base, table('t')).join('\n')).toContain(text);
    }
  });

  it('draws a table only the baseline has on the baseline side alone', () => {
    const drift = diffSchemas(snap([table('users'), table('audit')]), snap([table('users')]));
    const rows = tableRows(drift.findings, table('audit'), undefined);
    expect(rows.every((r) => r.here === null && r.baseline !== null)).toBe(true);
    expect(rows[0].note).toBe('table missing');
  });
});

describe('wordDiff', () => {
  const lit = (ws: Array<{ text: string; changed: boolean }>) =>
    ws.filter((w) => w.changed).map((w) => w.text);

  it('lights only the words that differ, a run as one phrase', () => {
    const d = wordDiff('timestamp NOT NULL', 'datetime NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(lit(d.a)).toEqual(['timestamp']);
    expect(lit(d.b)).toEqual(['datetime', 'DEFAULT CURRENT_TIMESTAMP']);
  });

  it('lights nothing when the two agree', () => {
    expect(lit(wordDiff('int NOT NULL', 'int NOT NULL').a)).toEqual([]);
  });
});

describe('consequenceOf', () => {
  it('tells a slow index from a missing guarantee', () => {
    const plain = diffSchemas(
      snap([table('t', { indexes: [{ name: 'i', columns: ['id'], unique: false }] })]),
      snap([table('t')]),
    );
    const unique = diffSchemas(
      snap([table('t', { indexes: [{ name: 'i', columns: ['id'], unique: true }] })]),
      snap([table('t')]),
    );
    expect(consequenceOf(plain.findings[0])).toBe('performance');
    expect(consequenceOf(unique.findings[0])).toBe('integrity');
  });

  it('calls a differing default behaviour, and a missing column breaking', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('id'), column('a', { defaultExpr: '1' }), column('b')] })]),
      snap([table('t', { columns: [column('id'), column('a')] })]),
    );
    const by = Object.fromEntries(drift.findings.map((f) => [f.object, consequenceOf(f)]));
    expect(by).toEqual({ a: 'behaviour', b: 'breaks' });
  });
});

describe('tableGrid', () => {
  const cols = (type: string, withDefault = false) => [
    column('id', { nullable: false }),
    column('a'),
    column('created', { typeName: type, defaultExpr: withDefault ? 'now()' : null }),
  ];
  const base = table('t', { columns: cols('timestamp') });

  function grid(...heres: TableInfo[]): string[] {
    const members = heres.map((h) => ({
      findings: diffSchemas(snap([base]), snap([h])).findings,
      table: h,
    }));
    return tableGrid(base, members).map(
      (r) =>
        r.fold ??
        `${r.name} | ${r.baseline} | ${r.cells.map((c) => (c.same ? '=' : (c.value ?? '—'))).join(' | ')}`,
    );
  }

  it('puts every member beside the baseline, "same" where one agrees', () => {
    expect(grid(table('t', { columns: cols('datetime') }), base)).toEqual([
      '⋯ 2 matching columns',
      'created | timestamp | datetime | =',
    ]);
  });

  it('shows a row when any member differs, each with its own value', () => {
    expect(grid(table('t', { columns: cols('datetime') }), table('t', { columns: cols('timestamp', true) }))).toEqual([
      '⋯ 2 matching columns',
      'created | timestamp | datetime | timestamp DEFAULT now()',
    ]);
  });

  it('draws a table one member lacks whole, that member empty', () => {
    const lacking = { findings: diffSchemas(snap([base]), snap([])).findings, table: undefined };
    const same = { findings: [], table: base };
    const rows = tableGrid(base, [lacking, same]);
    expect(rows.some((r) => r.fold)).toBe(false);
    expect(rows[0]).toMatchObject({ key: 'table', note: 'table missing' });
    expect(rows.every((r) => r.cells[0].value === null && r.cells[1].same)).toBe(true);
  });
});
