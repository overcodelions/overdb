import { describe, expect, it } from 'vitest';
import { addressLine, connectSnippets } from './ticketConnect';

describe('connectSnippets', () => {
  const mysql = connectSnippets({ engine: 'mysql', host: '127.0.0.1', port: 61771, user: 'root', database: 'app' });
  const by = (id: string) => mysql.find((s) => s.id === id)!.text;

  it('spells the copy’s address the ways code expects it, without the password', () => {
    expect(by('env')).toBe(
      'DATABASE_URL=mysql://root:<your password>@127.0.0.1:61771/app\nDB_HOST=127.0.0.1\nDB_PORT=61771\nDB_USERNAME=root\nDB_DATABASE=app',
    );
    expect(by('jdbc')).toBe('spring.datasource.url=jdbc:mysql://127.0.0.1:61771/app\nspring.datasource.username=root');
    expect(by('cli')).toBe('mysql -h 127.0.0.1 -P 61771 -u root -p app');
  });

  it('leaves the database out when the connection has none, and escapes a user', () => {
    const s = connectSnippets({ engine: 'mysql', host: '127.0.0.1', port: 3310, user: 'app@x', database: null });
    expect(s[0].text.split('\n')[0]).toBe('DATABASE_URL=mysql://app%40x:<your password>@127.0.0.1:3310');
    expect(s[2].text).toBe('mysql -h 127.0.0.1 -P 3310 -u app@x -p');
  });

  it('speaks Postgres to a Postgres copy', () => {
    const s = connectSnippets({ engine: 'postgres', host: '127.0.0.1', port: 5499, user: 'app', database: 'shop' });
    expect(s.map((x) => x.label)).toEqual(['.env', 'JDBC / Spring', 'psql']);
    expect(s[1].text).toContain('jdbc:postgresql://127.0.0.1:5499/shop');
  });

  it('never contains a password', () => {
    for (const s of mysql) expect(s.text).not.toMatch(/5qlpa|password=/i);
  });

  it('says where it is in one line', () => {
    expect(addressLine({ engine: 'mysql', host: '127.0.0.1', port: 61771, user: 'root', database: 'app' })).toBe('127.0.0.1:61771 · app · user root');
  });
});
