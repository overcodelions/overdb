import { describe, expect, it } from 'vitest';
import { mysqlKind } from './mysql';
import { postgresKind } from './postgres';
import { sqliteKind } from './sqlite';

describe('sqliteKind', () => {
  it('follows SQLite type affinity rather than exact names', () => {
    // SQLite decltypes are free text, so classification must be by the
    // same substring rules the engine itself uses.
    expect(sqliteKind('INTEGER')).toBe('int');
    expect(sqliteKind('BIGINT')).toBe('bigint');
    expect(sqliteKind('VARCHAR(80)')).toBe('text');
    expect(sqliteKind('NVARCHAR')).toBe('text');
    expect(sqliteKind('BLOB')).toBe('bytes');
    expect(sqliteKind('DOUBLE PRECISION')).toBe('float');
    expect(sqliteKind('DECIMAL(10,2)')).toBe('decimal');
    expect(sqliteKind('BOOLEAN')).toBe('bool');
  });

  it('prefers the more specific timestamp reading over date', () => {
    // 'DATETIME' contains neither 'DATE' first nor last by accident —
    // ordering in the classifier matters, so pin it.
    expect(sqliteKind('DATETIME')).toBe('timestamp');
    expect(sqliteKind('TIMESTAMP')).toBe('timestamp');
    expect(sqliteKind('DATE')).toBe('date');
  });

  it('reports an unknown or absent decltype rather than guessing', () => {
    // An expression column has no declared type. Guessing 'text' here
    // would make the grid render numbers left-aligned and lie about it.
    expect(sqliteKind(null)).toBe('other');
    expect(sqliteKind('')).toBe('other');
    expect(sqliteKind('GEOMETRY')).toBe('other');
  });
});

describe('postgresKind', () => {
  it('maps the oids whose rendering actually differs', () => {
    expect(postgresKind(16)).toBe('bool');
    expect(postgresKind(20)).toBe('bigint');
    expect(postgresKind(1700)).toBe('decimal');
    expect(postgresKind(1184)).toBe('timestamptz');
    expect(postgresKind(1114)).toBe('timestamp');
    expect(postgresKind(3802)).toBe('json');
    expect(postgresKind(17)).toBe('bytes');
  });

  it('separates timestamptz from timestamp', () => {
    // These render differently: one carries an offset the user must see,
    // the other does not. Collapsing them is how clients silently
    // localize and lose the offset the server sent.
    expect(postgresKind(1114)).not.toBe(postgresKind(1184));
  });

  it('falls back to other for an unknown oid', () => {
    expect(postgresKind(999999)).toBe('other');
  });
});

describe('mysqlKind', () => {
  // Collation 63 is `binary`; anything else is a text collation.
  const BIN = 63;
  const UTF8 = 33;

  it('separates BLOB from TEXT by collation, not type code', () => {
    // This is the one that bites: MySQL gives TEXT and BLOB the SAME type
    // code (252). Classifying on the code alone renders every TEXT column
    // in the database as "<n bytes binary>".
    expect(mysqlKind(252, UTF8)).toBe('text');
    expect(mysqlKind(252, BIN)).toBe('bytes');
    expect(mysqlKind(253, UTF8)).toBe('text');
    expect(mysqlKind(253, BIN)).toBe('bytes');
  });

  it('maps the numeric widths', () => {
    expect(mysqlKind(1, UTF8)).toBe('int');      // TINY
    expect(mysqlKind(3, UTF8)).toBe('int');      // LONG
    expect(mysqlKind(8, UTF8)).toBe('bigint');   // LONGLONG
    expect(mysqlKind(5, UTF8)).toBe('float');    // DOUBLE
    expect(mysqlKind(246, UTF8)).toBe('decimal'); // NEWDECIMAL
  });

  it('maps temporal and json types', () => {
    expect(mysqlKind(10, UTF8)).toBe('date');
    expect(mysqlKind(11, UTF8)).toBe('time');
    expect(mysqlKind(12, UTF8)).toBe('timestamp'); // DATETIME
    expect(mysqlKind(7, UTF8)).toBe('timestamp');  // TIMESTAMP
    expect(mysqlKind(245, UTF8)).toBe('json');
  });

  it('does not claim a MySQL timestamp carries an offset', () => {
    // Unlike Postgres timestamptz, neither MySQL type sends an offset on
    // the wire. Reporting one would license the grid to render a zone it
    // does not actually know.
    expect(mysqlKind(7, UTF8)).not.toBe('timestamptz');
    expect(mysqlKind(12, UTF8)).not.toBe('timestamptz');
  });

  it('falls back to other for an unknown code', () => {
    expect(mysqlKind(200, UTF8)).toBe('other');
  });
});
