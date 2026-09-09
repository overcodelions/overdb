import { describe, expect, it } from 'vitest';
import { parseJdbcUrl } from './jdbcUrl';

describe('parseJdbcUrl', () => {
  it('parses the plain forms', () => {
    expect(parseJdbcUrl('jdbc:mysql://localhost:3306/acme')).toMatchObject({
      engine: 'mysql', host: 'localhost', port: 3306, database: 'acme',
    });
    expect(parseJdbcUrl('jdbc:postgresql://db.example.com:5432/app')).toMatchObject({
      engine: 'postgres', host: 'db.example.com', port: 5432, database: 'app',
    });
  });

  it('sees through the aurora and aws-wrapper layers', () => {
    // Both appear in an ordinary JetBrains config and both are just MySQL
    // as far as a client is concerned.
    expect(parseJdbcUrl('jdbc:mysql:aurora://stg.rds.example.com:3306/acme')).toMatchObject({
      engine: 'mysql', host: 'stg.rds.example.com', database: 'acme',
    });
    expect(parseJdbcUrl('jdbc:aws-wrapper:mysql://prd.rds.example.com:3306/acme')).toMatchObject({
      engine: 'mysql', host: 'prd.rds.example.com', database: 'acme',
    });
  });

  it('maps Redshift onto Postgres and says so', () => {
    // Redshift speaks the Postgres wire protocol, so the pg driver really
    // does connect — but the user should know that is what happened.
    const r = parseJdbcUrl('jdbc:redshift://prd-redshift.example.com:5439/acmedm');
    expect(r).toMatchObject({ engine: 'postgres', driver: 'redshift', port: 5439 });
    expect(r?.viaCompatibleProtocol).toBe(true);
  });

  it('handles a missing database and a missing port', () => {
    expect(parseJdbcUrl('jdbc:mysql://localhost:3306/')).toMatchObject({ database: undefined });
    expect(parseJdbcUrl('jdbc:mysql://localhost/acme')).toMatchObject({ port: 3306 });
  });

  it('drops query parameters', () => {
    expect(parseJdbcUrl('jdbc:mysql://h:3306/db?useSSL=false&x=1')).toMatchObject({
      database: 'db',
    });
  });

  it('parses a sqlite file path', () => {
    expect(parseJdbcUrl('jdbc:sqlite:/tmp/app.db')).toMatchObject({
      engine: 'sqlite', database: '/tmp/app.db',
    });
  });

  it('reports an unsupported driver rather than guessing', () => {
    const r = parseJdbcUrl('jdbc:oracle:thin://host:1521/xe');
    expect(r?.engine).toBeNull();
    expect(r?.driver).toBe('oracle');
  });

  it('returns null for something that is not a JDBC URL', () => {
    expect(parseJdbcUrl('postgres://u@h/db')).toBeNull();
    expect(parseJdbcUrl('')).toBeNull();
  });
});
