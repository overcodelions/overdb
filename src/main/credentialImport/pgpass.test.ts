import { describe, expect, it } from 'vitest';
import { parsePgpass, splitPgpassLine } from './pgpass';
import { parseConnectionUrl, scanEnvironment } from './envUrl';

describe('splitPgpassLine', () => {
  it('splits on colons', () => {
    expect(splitPgpassLine('h:5432:db:user:pw')).toEqual(['h', '5432', 'db', 'user', 'pw']);
  });

  it('honours backslash escapes', () => {
    // A password containing a colon is not rare, and splitting naively
    // corrupts it into a truncated password that then fails to connect.
    expect(splitPgpassLine('h:5432:db:user:pa\\:ss')).toEqual(['h', '5432', 'db', 'user', 'pa:ss']);
    expect(splitPgpassLine('h:5432:db:user:back\\\\slash')).toEqual([
      'h', '5432', 'db', 'user', 'back\\slash',
    ]);
  });
});

describe('parsePgpass', () => {
  it('skips comments and blank lines', () => {
    const entries = parsePgpass('# a comment\n\nlocalhost:5432:app:me:secret\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ host: 'localhost', port: 5432, user: 'me', password: 'secret' });
  });

  it('records wildcards rather than treating them as literal values', () => {
    const [entry] = parsePgpass('*:*:*:me:secret');
    expect(entry.wildcard).toEqual({ host: true, port: true, database: true, user: false });
    expect(entry.port).toBeNull();
  });
});

describe('parseConnectionUrl', () => {
  it('parses a postgres URL with credentials', () => {
    expect(parseConnectionUrl('postgres://me:pw@db.example.com:5432/app')).toMatchObject({
      engine: 'postgres', host: 'db.example.com', port: 5432, database: 'app',
      user: 'me', hasPassword: true,
    });
  });

  it('parses mysql and defaults the port', () => {
    expect(parseConnectionUrl('mysql://root@localhost/acme')).toMatchObject({
      engine: 'mysql', port: 3306, user: 'root', hasPassword: false,
    });
  });

  it('reports an unknown scheme rather than guessing an engine', () => {
    expect(parseConnectionUrl('mongodb://h/db')?.engine).toBeNull();
  });
});

describe('scanEnvironment', () => {
  it('picks up the conventional variable names only', () => {
    const found = scanEnvironment({
      DATABASE_URL: 'postgres://me@h/app',
      ANALYTICS_DATABASE_URL: 'mysql://root@h/an',
      HOME: '/Users/x',
      SOME_OTHER: 'postgres://me@h/nope',
    } as NodeJS.ProcessEnv);
    expect(found.map((f) => f.variable)).toEqual(['ANALYTICS_DATABASE_URL', 'DATABASE_URL']);
  });
});
