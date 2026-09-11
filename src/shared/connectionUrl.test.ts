import { describe, expect, it } from 'vitest';
import { parseConnectionUrl, variantFromHost } from './connectionUrl';

describe('parseConnectionUrl', () => {
  it('takes a Postgres URL apart', () => {
    expect(parseConnectionUrl('postgres://me:pw@db.example.com:5432/orders')).toMatchObject({
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'orders',
      user: 'me',
      password: 'pw',
    });
  });

  it('fills in the default port for the scheme', () => {
    expect(parseConnectionUrl('mysql://root@localhost/app')).toMatchObject({
      engine: 'mysql',
      port: 3306,
    });
    expect(parseConnectionUrl('postgresql://localhost/app')).toMatchObject({ port: 5432 });
  });

  // The bug this parser exists to avoid. An encoded password that comes
  // back still encoded produces "the server rejected the password", and
  // sends the user hunting anywhere but here.
  it('decodes percent-encoding in the user and password', () => {
    expect(parseConnectionUrl('postgres://a%40b:p%40ss%2Fword@h/db')).toMatchObject({
      user: 'a@b',
      password: 'p@ss/word',
    });
  });

  it('survives a stray percent that is not an escape', () => {
    expect(parseConnectionUrl('postgres://u:100%pure@h/db')?.password).toBe('100%pure');
  });

  it('carries sslmode across, in both spellings', () => {
    expect(parseConnectionUrl('postgres://h/db?sslmode=verify-full')?.ssl).toBe('verify-full');
    expect(parseConnectionUrl('postgres://h/db?sslmode=disable')?.ssl).toBe('disable');
    expect(parseConnectionUrl('mysql://h/db?ssl-mode=VERIFY_IDENTITY')?.ssl).toBe('verify-full');
    expect(parseConnectionUrl('mysql://h/db?ssl-mode=DISABLED')?.ssl).toBe('disable');
  });

  // Of the two ways to be wrong about `prefer`, encrypting something that
  // did not need it is the harmless one.
  it('maps prefer and allow up to require rather than down to disable', () => {
    expect(parseConnectionUrl('postgres://h/db?sslmode=prefer')?.ssl).toBe('require');
    expect(parseConnectionUrl('postgres://h/db?sslmode=allow')?.ssl).toBe('require');
  });

  it('finds a schema in either place ORMs put one', () => {
    expect(parseConnectionUrl('postgres://h/db?schema=analytics')?.defaultSchema).toBe('analytics');
    expect(
      parseConnectionUrl('postgres://h/db?options=-csearch_path%3Dreporting')?.defaultSchema,
    ).toBe('reporting');
  });

  it('reports the parameters it did not understand', () => {
    expect(parseConnectionUrl('postgres://h/db?connect_timeout=10&application_name=x')?.ignored)
      .toEqual(['connect_timeout', 'application_name']);
  });

  it('recognises a managed endpoint from the hostname', () => {
    expect(parseConnectionUrl('postgres://orders.cluster-cabc.eu-west-1.rds.amazonaws.com/db'))
      .toMatchObject({ variant: 'aurora-postgres' });
    expect(parseConnectionUrl('postgres://wh.abc.us-east-1.redshift.amazonaws.com:5439/dev'))
      .toMatchObject({ variant: 'redshift' });
  });

  it('parses a JDBC URL, which is not a URL', () => {
    expect(parseConnectionUrl('jdbc:mysql://db.internal:3307/app?user=root&password=s3cret'))
      .toMatchObject({ engine: 'mysql', host: 'db.internal', port: 3307, database: 'app', user: 'root', password: 's3cret' });
    expect(parseConnectionUrl('jdbc:aws-wrapper:postgresql://h:5432/app')).toMatchObject({
      engine: 'postgres',
    });
  });

  it('returns null for things that are not connection URLs', () => {
    expect(parseConnectionUrl('')).toBeNull();
    expect(parseConnectionUrl('just some text')).toBeNull();
    expect(parseConnectionUrl('https://example.com')).toBeNull();
    expect(parseConnectionUrl('redis://h:6379')).toBeNull();
  });

  it('does not invent a host for a socket-only URL', () => {
    expect(parseConnectionUrl('postgres:///app')?.host).toBeUndefined();
  });
});

describe('variantFromHost', () => {
  it('reads AWS and Cockroach endpoints', () => {
    expect(variantFromHost('x.cluster-c.us-east-1.rds.amazonaws.com', 'mysql')).toBe('aurora-mysql');
    expect(variantFromHost('x.abc.us-east-1.redshift.amazonaws.com', 'postgres')).toBe('redshift');
    expect(variantFromHost('free-tier.g8x.cockroachlabs.cloud', 'postgres')).toBe('cockroach');
  });

  it('says nothing about an ordinary host', () => {
    expect(variantFromHost('db.internal', 'postgres')).toBeUndefined();
    // A plain RDS instance is not Aurora, and claiming it is would put the
    // wrong dialect behind every query.
    expect(variantFromHost('shop.abc.us-east-1.rds.amazonaws.com', 'postgres')).toBeUndefined();
  });
});
