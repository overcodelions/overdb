import { describe, expect, it } from 'vitest';
import type { ColumnInfo, Engine, SchemaSnapshot, TableInfo } from './types';
import { buildMigration } from './migrationSql';
import { diffSchemas } from './schemaDiff';

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
    serverVersion: '17',
    capturedAt: '2026-09-10T00:00:00Z',
    schemas: [{ name: 'public', tables }],
  };
}

function migrate(baseline: SchemaSnapshot, here: SchemaSnapshot, engine: Engine = 'postgres') {
  return buildMigration(diffSchemas(baseline, here), baseline, engine);
}

describe('buildMigration', () => {
  it('adds a column the baseline has', () => {
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('email', { typeName: 'text' })] })]),
      snap([table('t')]),
    );
    expect(m.sql).toContain('alter table "public"."t" add column "email" text;');
    expect(m.statementCount).toBe(1);
  });

  it('warns before adding a NOT NULL column with no default', () => {
    // The migration is right and still fails on a table with rows in it —
    // saying so is the difference between a proposal and a trap.
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('tenant', { nullable: false })] })]),
      snap([table('t')]),
    );
    expect(m.sql).toMatch(/NOT NULL with no default/);
    expect(m.sql).toContain('add column "tenant" integer not null;');
  });

  it('never writes a drop, and says why', () => {
    const m = migrate(
      snap([table('t')]),
      snap([table('t', { columns: [column('id', { nullable: false }), column('legacy')] })]),
    );
    expect(m.sql).not.toMatch(/^\s*alter table .* drop column/m);
    expect(m.sql).toMatch(/will not write that for you/);
    // The statement is still spelled out, commented, so it is a decision
    // rather than a research task.
    expect(m.sql).toMatch(/-- If you are sure: alter table "public"\."t" drop column "legacy";/);
    expect(m.statementCount).toBe(0);
  });

  it('creates a missing table before touching what goes in it', () => {
    const m = migrate(
      snap([
        table('users', {
          columns: [column('id', { nullable: false }), column('email', { typeName: 'text', nullable: false })],
          indexes: [{ name: 'users_email_idx', columns: ['email'], unique: true }],
        }),
      ]),
      snap([]),
    );
    expect(m.sql).toContain('create table "public"."users"');
    expect(m.sql).toContain('primary key ("id")');
    // The index is part of the CREATE's table, not a second statement
    // against a table that did not exist a moment ago.
    expect(m.sql).not.toContain('create unique index');
  });

  it('creates a missing index with the name the baseline uses', () => {
    // Same name as well as same shape, so the NEXT comparison says match.
    const m = migrate(
      snap([table('t', { indexes: [{ name: 'idx_t_email', columns: ['email'], unique: false }] })]),
      snap([table('t')]),
    );
    expect(m.sql).toContain('create index "idx_t_email" on "public"."t" ("email");');
  });

  it('writes MySQL in MySQL', () => {
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('n', { typeName: 'bigint' })] })], 'mysql'),
      snap([table('t')], 'mysql'),
      'mysql',
    );
    expect(m.sql).toContain('`public`.`t`');
    expect(m.sql).toContain('add column `n` bigint;');
  });

  it('does not qualify a SQLite table with a schema', () => {
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('n')] })], 'sqlite'),
      snap([table('t')], 'sqlite'),
      'sqlite',
    );
    expect(m.sql).toContain('alter table "t" add column "n" integer;');
  });

  it('names what it could not express instead of quietly skipping it', () => {
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('n', { typeName: 'bigint' })] })], 'sqlite'),
      snap([table('t', { columns: [column('id', { nullable: false }), column('n', { typeName: 'integer' })] })], 'sqlite'),
      'sqlite',
    );
    expect(m.statementCount).toBe(0);
    expect(m.unhandled[0].reason).toMatch(/cannot alter a column type/);
  });

  it('refuses to rewrite a primary key', () => {
    const m = migrate(snap([table('t')]), snap([table('t', { primaryKey: [] })]));
    expect(m.statementCount).toBe(0);
    expect(m.unhandled[0].reason).toMatch(/dropping the existing one first/);
  });

  it('flags a type change as needing a look', () => {
    const m = migrate(
      snap([table('t', { columns: [column('id', { nullable: false }), column('n', { typeName: 'bigint' })] })]),
      snap([table('t', { columns: [column('id', { nullable: false }), column('n', { typeName: 'integer' })] })]),
    );
    expect(m.sql).toContain('alter column "n" type bigint;');
    expect(m.sql).toMatch(/narrowing change fails/);
  });

  it('says so plainly when there is nothing to do', () => {
    const m = migrate(snap([table('t')]), snap([table('t')]));
    expect(m.sql).toMatch(/Nothing to do/);
    expect(m.statementCount).toBe(0);
  });

  it('always says nothing has run', () => {
    const m = migrate(snap([table('t'), table('u')]), snap([table('t')]));
    expect(m.sql.startsWith('-- Proposed by overdb. Nothing here has run.')).toBe(true);
  });
});
