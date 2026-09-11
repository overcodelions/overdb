import { describe, expect, it } from 'vitest';
import { buildUpdate, editTarget, previewUpdate, type KeyedTable } from './rowEdit';
import type { ColumnMeta } from './types';

const col = (name: string, table: string | null, column = name): ColumnMeta => ({
  name,
  typeName: 'int',
  kind: 'int',
  nullable: true,
  sourceTable: table ? { schema: 'acme', table, column } : null,
});

const accessLog: KeyedTable = {
  schema: 'acme',
  name: 'access_log',
  primaryKey: ['al_id'],
  indexes: [{ name: 'uq_marker', columns: ['session_marker'], unique: true }],
};

describe('editTarget', () => {
  it('accepts a stored column whose row the projection can address', () => {
    const check = editTarget([col('al_id', 'access_log'), col('a_type', 'access_log')], 1, [
      accessLog,
    ]);
    expect(check).toEqual({
      ok: true,
      target: {
        schema: 'acme',
        table: 'access_log',
        column: 'a_type',
        keys: [{ column: 'al_id', index: 0 }],
        keySource: 'primary key',
      },
    });
  });

  it('refuses a computed column, which has nowhere to be written back to', () => {
    const check = editTarget([col('copies', null)], 0, [accessLog]);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('computed by the query');
  });

  it('refuses when the key is not in the projection', () => {
    // `select email, a_type from access_log` would update every row sharing
    // that email — the whole reason this check exists.
    const check = editTarget([col('email', 'access_log'), col('a_type', 'access_log')], 1, [
      { ...accessLog, indexes: [] },
    ]);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('al_id');
  });

  it('accepts a unique index when there is no primary key in the projection', () => {
    const check = editTarget(
      [col('session_marker', 'access_log'), col('a_type', 'access_log')],
      1,
      [{ ...accessLog, primaryKey: [] }],
    );
    expect(check.ok && check.target.keySource).toBe('uq_marker');
  });

  it('refuses a table with nothing unique about it', () => {
    const check = editTarget([col('a_type', 'audit')], 0, [
      { schema: 'acme', name: 'audit', primaryKey: [], indexes: [] },
    ]);
    expect(check.ok === false && check.reason).toContain('no primary key or unique index');
  });
});

describe('buildUpdate', () => {
  const target = {
    schema: 'acme',
    table: 'access_log',
    column: 'a_type',
    keys: [{ column: 'al_id', index: 0 }],
    keySource: 'primary key',
  };

  it('parameterises both the value and the key', () => {
    // The value never enters the statement text: that is what makes a cell
    // holding `'); drop table` a value rather than an instruction.
    expect(buildUpdate(target, '1', ['36'], 'mysql')).toEqual({
      sql: 'update `acme`.`access_log` set `a_type` = ? where `al_id` = ?',
      params: ['1', '36'],
    });
  });

  it('numbers placeholders on Postgres', () => {
    expect(buildUpdate(target, '1', ['36'], 'postgres').sql).toBe(
      'update "acme"."access_log" set "a_type" = $1 where "al_id" = $2',
    );
  });

  it('addresses a null key with IS, since nothing equals null', () => {
    const composite = {
      ...target,
      keys: [
        { column: 'al_id', index: 0 },
        { column: 'partner_id', index: 1 },
      ],
    };
    const { sql, params } = buildUpdate(composite, '1', ['36', null], 'mysql');
    expect(sql).toBe(
      'update `acme`.`access_log` set `a_type` = ? where `al_id` = ? and `partner_id` is null',
    );
    expect(params).toEqual(['1', '36']);
  });
});

describe('previewUpdate', () => {
  it('shows the values the placeholders stand for, for the confirmation only', () => {
    const { sql, params } = buildUpdate(
      {
        schema: null,
        table: 'access_log',
        column: 'a_type',
        keys: [{ column: 'al_id', index: 0 }],
        keySource: 'primary key',
      },
      '1',
      ['36'],
      'mysql',
    );
    expect(previewUpdate(sql, params, 'mysql')).toBe(
      'update `access_log` set `a_type` = 1 where `al_id` = 36',
    );
  });

  it('quotes text and null', () => {
    expect(previewUpdate('set x = ?', ['o\'brien'], 'mysql')).toBe("set x = 'o''brien'");
    expect(previewUpdate('set x = ?', [null], 'mysql')).toBe('set x = null');
  });
});
