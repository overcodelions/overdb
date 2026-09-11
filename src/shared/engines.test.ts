import { describe, expect, it } from 'vitest';
import { detectVariant, engineOf, variantFromDriver, variantTag } from './engines';

describe('detectVariant', () => {
  it('calls Redshift Redshift, not Postgres 8.0', () => {
    // The trap: Redshift's version() opens with "PostgreSQL 8.0.2", so any
    // check that looks for Postgres first matches every Redshift server.
    const v = detectVariant('postgres', {
      version: 'PostgreSQL 8.0.2 on i686-pc-linux-gnu, compiled by GCC gcc (GCC) 3.4.2, Redshift 1.0.63590',
    });
    expect(v).toBe('redshift');
  });

  it('recognises CockroachDB', () => {
    expect(detectVariant('postgres', { version: 'CockroachDB CCL v23.1.11' })).toBe('cockroach');
  });

  it('recognises Aurora PostgreSQL only via aurora_version()', () => {
    const stock = { version: 'PostgreSQL 15.4 on aarch64-unknown-linux-gnu' };
    expect(detectVariant('postgres', stock)).toBe('postgres');
    expect(detectVariant('postgres', { ...stock, auroraVersion: '15.4.0' })).toBe('aurora-postgres');
  });

  it('recognises MariaDB and Aurora MySQL', () => {
    expect(detectVariant('mysql', { version: '10.6.16-MariaDB' })).toBe('mariadb');
    expect(detectVariant('mysql', { version: '8.0.32' })).toBe('mysql');
    expect(detectVariant('mysql', { version: '8.0.32', auroraVersion: '3.04.0' })).toBe('aurora-mysql');
  });

  it('falls back to the plain engine when the server says nothing useful', () => {
    expect(detectVariant('postgres', {})).toBe('postgres');
    expect(detectVariant('mysql', { version: null })).toBe('mysql');
  });
});

describe('variant metadata', () => {
  it('maps every variant back to a driver', () => {
    expect(engineOf('redshift')).toBe('postgres');
    expect(engineOf('aurora-mysql')).toBe('mysql');
  });

  it('labels an unopened connection from its engine alone', () => {
    expect(variantTag(undefined, 'postgres')).toBe('Postgres');
    expect(variantTag('redshift', 'postgres')).toBe('Redshift');
  });

  it('spells the product rather than a private code', () => {
    // `rs`, `apg` and `crdb` only existed because the badge was a fixed
    // 38px pill. Nothing here should read as an abbreviation you have to
    // learn.
    for (const [variant, expected] of [
      ['aurora-postgres', 'Aurora'],
      ['cockroach', 'Cockroach'],
      ['dynamodb', 'DynamoDB'],
      ['mariadb', 'MariaDB'],
      ['sqlite', 'SQLite'],
    ] as const) {
      expect(variantTag(variant, 'postgres')).toBe(expected);
    }
  });

  it('reads the variant off a JDBC driver name, for imports', () => {
    expect(variantFromDriver('redshift')).toBe('redshift');
    expect(variantFromDriver('mariadb')).toBe('mariadb');
    expect(variantFromDriver('postgresql')).toBeUndefined();
  });
});
