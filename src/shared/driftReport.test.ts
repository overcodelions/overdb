import { describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaSnapshot, TableInfo } from './types';
import { diffSchemas } from './schemaDiff';
import { driftReport, type ReportInput } from './driftReport';

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, ordinal: 1, typeName: 'int', nullable: true, defaultExpr: null, ...patch };
}

function table(name: string, patch: Partial<TableInfo> = {}): TableInfo {
  return { name, kind: 'table', columns: [column('id')], primaryKey: ['id'], indexes: [], foreignKeys: [], ...patch };
}

function snap(tables: TableInfo[]): SchemaSnapshot {
  return { engine: 'mysql', serverVersion: '8', capturedAt: '', schemas: [{ name: 'app', tables }] };
}

type Patch = Partial<Omit<ReportInput, 'members'>> & { sql?: string };

function report(patch: Patch = {}, tablesHere?: TableInfo[]) {
  const base = snap([
    table('team', { columns: [column('id'), column('create_date', { typeName: 'bigint' })] }),
    table('audit'),
  ]);
  const here = snap(
    tablesHere ?? [table('team', { columns: [column('id'), column('create_date', { typeName: 'int' })] })],
  );
  const drift = diffSchemas(base, here, { baselineOnly: 'pending' });
  const { sql, ...rest } = patch;
  return driftReport({
    setName: 'prod-east/west',
    baseline: { name: 'prod-east', schema: 'app', readAt: '2026-09-28T10:00:00Z', kept: false },
    baselineSnapshot: base,
    members: [
      {
        side: { name: 'prod-west', schema: 'app', readAt: '2026-09-28T07:00:00Z', kept: true },
        drift,
        snapshot: here,
        sql: sql ?? 'alter table `team` modify `create_date` bigint;',
      },
    ],
    showQuiet: false,
    baselineOnly: 'pending',
    ignorePatterns: [],
    version: '0.1.3',
    generatedAt: new Date('2026-09-28T12:00:00Z'),
    ...rest,
  });
}

describe('driftReport', () => {
  it('names both servers, says which is the baseline, and how old each catalog is', () => {
    const { html, markdown } = report();
    expect(markdown).toContain('- ★ **prod-east** — baseline');
    expect(markdown).toContain('catalog as kept 2026-09-28 07:00 UTC — not live');
    expect(markdown).toContain('> prod-west could not be reached');
    expect(html).toContain('<th class="base">★ prod-east <small>baseline</small></th>');
  });

  it('shows a changed column side by side, lighting only what differs', () => {
    const { html, markdown } = report();
    expect(markdown).toContain('| `create_date` | `bigint` | `int` | type |');
    expect(html).toContain('<td class="base"><mark>bigint</mark></td>');
    expect(html).toContain('<td class="m0"><mark>int</mark></td>');
  });

  it('lists tables not deployed yet apart, and leads with the verdict', () => {
    const { markdown } = report();
    expect(markdown).toContain('## Not deployed yet');
    expect(markdown).toContain('- `audit` — not on prod-west');
    expect(markdown).toContain('**1 breaks · 1 not deployed yet**');
  });

  it('says nothing breaks when nothing does', () => {
    const tables = [
      table('team', { columns: [column('id'), column('create_date', { typeName: 'bigint', defaultExpr: '1' })] }),
    ];
    expect(report({}, tables).markdown).toContain('**Nothing breaks · 1 behaviour · 1 not deployed yet**');
  });

  it('escapes what it is given, and carries no script and no links', () => {
    const { html, markdown } = report({ setName: '<img src=x onerror=alert(1)> a|b' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<script|https?:\/\//i);
    expect(markdown).toContain('a\\|b');
  });

  it('leaves the SQL out when there is none, and names a file after the two', () => {
    const r = report({ sql: '' });
    expect(r.markdown).not.toContain('Proposed SQL');
    expect(r.fileName).toBe('drift-prod-west-vs-prod-east-2026-09-28');
  });
});

describe('driftReport, several members', () => {
  it('gives each member a column, "=" where it agrees with the baseline', () => {
    const cols = (type: string) => [column('id'), column('create_date', { typeName: type })];
    const base = snap([table('team', { columns: cols('bigint') })]);
    const west = snap([table('team', { columns: cols('int') })]);
    const sbox = snap([table('team', { columns: cols('bigint') })]);
    const side = (name: string) => ({ name, schema: 'app', readAt: '2026-09-28T10:00:00Z', kept: false });
    const r = driftReport({
      setName: 'prod vs sandbox',
      baseline: side('prod-east'),
      baselineSnapshot: base,
      members: [
        { side: side('prod-west'), drift: diffSchemas(base, west), snapshot: west, sql: '' },
        { side: side('sandbox'), drift: diffSchemas(base, sbox), snapshot: sbox, sql: '' },
      ],
      showQuiet: false,
      baselineOnly: 'pending',
      ignorePatterns: [],
      version: '0.1.3',
      generatedAt: new Date('2026-09-28T12:00:00Z'),
    });
    expect(r.markdown).toContain('# Schema drift against prod-east');
    expect(r.markdown).toContain('| Column / key | ★ prod-east | prod-west | sandbox | What differs |');
    expect(r.markdown).toContain('| `create_date` | `bigint` | `int` | = | type |');
    expect(r.markdown).toContain('**prod-west: 1 breaks**');
    expect(r.markdown).toContain('**sandbox matches prod-east.**');
    expect(r.html).toContain('<td class="m1 same">same</td>');
    expect(r.fileName).toBe('drift-prod-west-sandbox-vs-prod-east-2026-09-28');
  });
});
