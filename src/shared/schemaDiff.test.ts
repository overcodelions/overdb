import { describe, expect, it } from 'vitest';
import type { ColumnInfo, Engine, SchemaSnapshot, TableInfo } from './types';
import { diffSchemas, driftSummary, normalizeDefault, type DriftKind } from './schemaDiff';

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, ordinal: 1, typeName: 'integer', nullable: true, defaultExpr: null, ...patch };
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

function snap(tables: TableInfo[], engine: Engine = 'postgres'): SchemaSnapshot {
  return {
    engine,
    serverVersion: '17.0',
    capturedAt: '2026-09-10T00:00:00Z',
    schemas: [{ name: 'public', tables }],
  };
}

const kinds = (d: ReturnType<typeof diffSchemas>): DriftKind[] => d.findings.map((f) => f.kind);

describe('diffSchemas', () => {
  it('says nothing when the two agree', () => {
    const drift = diffSchemas(snap([table('users')]), snap([table('users')]));
    expect(drift.verdict).toBe('match');
    expect(drift.findings).toHaveLength(0);
  });

  it('calls a missing table breaking and names the direction', () => {
    const drift = diffSchemas(snap([table('users'), table('orders')]), snap([table('users')]));
    expect(kinds(drift)).toEqual(['table-missing']);
    expect(drift.findings[0].severity).toBe('breaking');
    expect(drift.findings[0].sentence).toMatch(/does not exist here/);
  });

  it('calls an extra table notable, not breaking', () => {
    // A table the baseline lacks breaks nothing that was written against
    // the baseline — it is worth seeing, not worth an alarm.
    const drift = diffSchemas(snap([table('users')]), snap([table('users'), table('audit')]));
    expect(drift.findings[0]).toMatchObject({ kind: 'table-extra', severity: 'notable' });
  });

  it('reads a differently-spelled type as quiet, across variants', () => {
    // Reported at the same volume as real drift, this class of finding is
    // what teaches people to stop reading the panel.
    const drift = diffSchemas(
      snap([table('t', { columns: [column('at', { typeName: 'character varying(255)' })] })]),
      snap([table('t', { columns: [column('at', { typeName: 'varchar(255)' })] })]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'column-type', severity: 'quiet' });
    expect(drift.verdict).toBe('quiet');
  });

  it('reads a genuinely different type as breaking', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('n', { typeName: 'bigint' })] })]),
      snap([table('t', { columns: [column('n', { typeName: 'integer' })] })]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'column-type', severity: 'breaking' });
  });

  it('does not excuse a spelling difference between two servers of one variant', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('at', { typeName: 'datetime' })] })], 'mysql'),
      snap([table('t', { columns: [column('at', { typeName: 'timestamp' })] })], 'mysql'),
      { baselineVariant: 'mariadb', hereVariant: 'mariadb' },
    );
    expect(drift.findings.find((f) => f.kind === 'column-type')?.severity).toBe('breaking');
  });

  it('breaks on a column that rejects nulls the baseline accepts', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('note', { nullable: true })] })]),
      snap([table('t', { columns: [column('note', { nullable: false })] })]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'column-nullability', severity: 'breaking' });
    expect(drift.findings[0].sentence).toMatch(/fails here/);
  });

  it('is only notable the other way round', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('note', { nullable: false })] })]),
      snap([table('t', { columns: [column('note', { nullable: true })] })]),
    );
    expect(drift.findings[0].severity).toBe('notable');
  });

  it('flags an extra NOT NULL column with no default as breaking', () => {
    const drift = diffSchemas(
      snap([table('t')]),
      snap([
        table('t', {
          columns: [column('id', { nullable: false }), column('tenant', { nullable: false })],
        }),
      ]),
    );
    const extra = drift.findings.find((f) => f.kind === 'column-extra');
    expect(extra?.severity).toBe('breaking');
    expect(extra?.sentence).toMatch(/cannot satisfy it/);
  });

  it('matches indexes by their columns, not their names', () => {
    // Two servers built by different migrations name the same index
    // differently; matching on names reports every index twice.
    const drift = diffSchemas(
      snap([table('t', { indexes: [{ name: 'idx_a', columns: ['email'], unique: false }] })]),
      snap([table('t', { indexes: [{ name: 't_email_idx', columns: ['email'], unique: false }] })]),
    );
    expect(drift.findings).toHaveLength(0);
  });

  it('separates a missing unique index from a missing plain one', () => {
    const missingUnique = diffSchemas(
      snap([table('t', { indexes: [{ name: 'u', columns: ['email'], unique: true }] })]),
      snap([table('t')]),
    );
    expect(missingUnique.findings[0].severity).toBe('breaking');

    const missingPlain = diffSchemas(
      snap([table('t', { indexes: [{ name: 'i', columns: ['email'], unique: false }] })]),
      snap([table('t')]),
    );
    expect(missingPlain.findings[0].severity).toBe('notable');
    expect(missingPlain.findings[0].sentence).toMatch(/different plan/);
  });

  it('survives an index whose column name the catalog would not give us', () => {
    // MySQL reports COLUMN_NAME as NULL for every functional index. This
    // crashed the whole drift panel — one unusual index took every other
    // finding with it.
    const withNull = (name: string) =>
      table('t', {
        indexes: [{ name, columns: [null as unknown as string], unique: false }],
      });
    const drift = diffSchemas(snap([withNull('idx_lower_email')]), snap([withNull('idx_x')]));
    expect(drift.findings).toHaveLength(0);
    expect(drift.unreadable).toEqual([
      'public.t index idx_lower_email',
      'public.t index idx_x',
    ]);
  });

  it('does not report two unreadable indexes as matching each other', () => {
    // Keyed as an empty string they would collide and read as one index
    // present on both sides — a claim overdb cannot make.
    const drift = diffSchemas(
      snap([
        table('t', {
          indexes: [
            { name: 'a', columns: [null as unknown as string], unique: false },
            { name: 'b', columns: [null as unknown as string], unique: true },
          ],
        }),
      ]),
      snap([table('t')]),
    );
    expect(drift.findings).toHaveLength(0);
    expect(drift.unreadable).toHaveLength(2);
  });

  it('compares a functional index by the expression the adapter read', () => {
    const drift = diffSchemas(
      snap([table('t', { indexes: [{ name: 'i', columns: ['(lower(`email`))'], unique: false }] })]),
      snap([table('t')]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'index-missing' });
    expect(drift.unreadable).toEqual([]);
  });

  it('treats an extra index as quiet', () => {
    const drift = diffSchemas(
      snap([table('t')]),
      snap([table('t', { indexes: [{ name: 'i', columns: ['email'], unique: false }] })]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'index-extra', severity: 'quiet' });
  });

  it('reports a primary key that is gone', () => {
    const drift = diffSchemas(
      snap([table('t')]),
      snap([table('t', { primaryKey: [] })]),
    );
    expect(drift.findings[0].kind).toBe('primary-key');
    expect(drift.findings[0].sentence).toMatch(/inline editing is off/);
  });

  it('follows a foreign key that was repointed', () => {
    const fk = (refTable: string) => ({
      name: 'fk', columns: ['owner_id'], refSchema: 'public', refTable, refColumns: ['id'],
    });
    const drift = diffSchemas(
      snap([table('t', { foreignKeys: [fk('users')] }), table('users'), table('accounts')]),
      snap([table('t', { foreignKeys: [fk('accounts')] }), table('users'), table('accounts')]),
    );
    expect(drift.findings[0]).toMatchObject({ kind: 'foreign-key-target', severity: 'breaking' });
  });

  it('never claims breaking across two engines', () => {
    // The two catalogs disagree about vocabulary before they disagree
    // about anything real, so a cross-engine verdict is advice at most.
    const drift = diffSchemas(
      snap([table('users'), table('orders')], 'postgres'),
      snap([table('users')], 'mysql'),
    );
    expect(drift.crossEngine).toBe(true);
    expect(drift.counts.breaking).toBe(0);
    expect(drift.findings[0].severity).toBe('notable');
  });

  it('names a table it could not read instead of reporting every column missing', () => {
    // The schema tree holds tables from unopened schemas by name only.
    const drift = diffSchemas(
      snap([table('users', { columns: [column('id'), column('email')] })]),
      snap([table('users', { columns: [] })]),
    );
    expect(drift.findings).toHaveLength(0);
    expect(drift.unread).toEqual(['public.users']);
  });

  it('lists a whole missing schema rather than diffing its tables', () => {
    const baseline: SchemaSnapshot = {
      ...snap([table('users')]),
      schemas: [
        { name: 'public', tables: [table('users')] },
        { name: 'billing', tables: [table('invoices'), table('plans')] },
      ],
    };
    const drift = diffSchemas(baseline, snap([table('users')]));
    expect(drift.onlyInBaseline).toEqual(['billing']);
    expect(drift.findings).toHaveLength(0);
    expect(drift.comparedSchemas).toEqual(['public']);
  });

  it('ranks breaking findings first', () => {
    const drift = diffSchemas(
      snap([
        table('a', { indexes: [{ name: 'i', columns: ['x'], unique: false }] }),
        table('b'),
      ]),
      snap([table('a')]),
    );
    expect(drift.findings[0].severity).toBe('breaking');
    expect(drift.findings.at(-1)?.severity).toBe('notable');
  });

  it('ignores column order on Postgres and reports it quietly on MySQL', () => {
    const base = snap([
      table('t', { columns: [column('id', { ordinal: 1 }), column('name', { ordinal: 2 })] }),
    ]);
    const reordered = snap([
      table('t', { columns: [column('id', { ordinal: 2 }), column('name', { ordinal: 1 })] }),
    ]);
    expect(diffSchemas(base, reordered).findings).toHaveLength(0);
    const mysql = diffSchemas(base, reordered, { orderMatters: true });
    expect(mysql.findings.every((f) => f.severity === 'quiet')).toBe(true);
    expect(mysql.verdict).toBe('quiet');
  });
});

describe('normalizeDefault', () => {
  it('strips the type Postgres appends to a literal', () => {
    expect(normalizeDefault("'active'::text")).toBe("'active'");
  });

  it('reads the two spellings of now as one', () => {
    expect(normalizeDefault('now()')).toBe(normalizeDefault('CURRENT_TIMESTAMP'));
  });

  it('treats no default and a null default as the same nothing', () => {
    expect(normalizeDefault(null)).toBeNull();
    expect(normalizeDefault('NULL')).toBeNull();
  });

  it('keeps a genuinely different value', () => {
    expect(normalizeDefault("'a'")).not.toBe(normalizeDefault("'b'"));
  });
});

describe('driftSummary', () => {
  it('says a quiet difference is still a match', () => {
    const drift = diffSchemas(
      snap([table('t', { columns: [column('at', { typeName: 'character varying(255)' })] })]),
      snap([table('t', { columns: [column('at', { typeName: 'varchar(255)' })] })]),
    );
    expect(driftSummary(drift, 'staging')).toMatch(/matches the baseline/);
  });

  it('counts what matters when it does not match', () => {
    const drift = diffSchemas(snap([table('a'), table('b')]), snap([table('a')]));
    expect(driftSummary(drift, 'prod')).toBe('prod: 1 breaking.');
  });
});

describe('diffSchemas scoped to named tables', () => {
  const two = (indexes: TableInfo['indexes']) =>
    snap([table('partner', { indexes }), table('panel_widget')]);

  it('compares only the tables it was given', () => {
    // The fan-out asks a much narrower question than the drift panel: not
    // "have these diverged" but "do the tables this statement just read
    // have the same indexes".
    const drift = diffSchemas(
      two([{ name: 'i', columns: ['client_id'], unique: false }]),
      snap([table('partner'), table('panel_widget', { primaryKey: [] })]),
      { tables: [{ schema: 'public', table: 'partner' }] },
    );
    expect(drift.findings.map((f) => f.table)).toEqual(['partner']);
    expect(drift.findings[0].kind).toBe('index-missing');
  });

  it('matches a table name whatever case the server gave it back in', () => {
    const drift = diffSchemas(
      two([{ name: 'i', columns: ['client_id'], unique: false }]),
      snap([table('partner'), table('panel_widget')]),
      { tables: [{ schema: null, table: 'PARTNER' }] },
    );
    expect(drift.findings).toHaveLength(1);
  });

  it('compares everything when it is given no list', () => {
    const drift = diffSchemas(
      two([{ name: 'i', columns: ['client_id'], unique: false }]),
      snap([table('partner'), table('panel_widget', { primaryKey: [] })]),
    );
    expect(new Set(drift.findings.map((f) => f.table))).toEqual(
      new Set(['partner', 'panel_widget']),
    );
  });
});
