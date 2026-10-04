import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneDir, compareVersions, makeDistinct, pickMysqld, settingFlags } from './instances';

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('9.2.0', '8.4.4')).toBeGreaterThan(0);
    expect(compareVersions('8.0.10', '8.0.9')).toBeGreaterThan(0);
    expect(compareVersions('8.4.4', '8.4.4')).toBe(0);
  });
});

describe('cloning a data directory', () => {
  it('copies it whole, then makes the copy a distinct server', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'overdb-clone-'));
    const from = path.join(base, 'baseline', 'data');
    await fs.mkdir(path.join(from, 'app'), { recursive: true });
    await fs.writeFile(path.join(from, 'app', 'client.ibd'), 'rows');
    await fs.writeFile(path.join(from, 'auto.cnf'), '[auto]\nserver-uuid=abc');
    await fs.writeFile(path.join(from, 'mysqld.pid'), '123');

    const to = path.join(base, 'ticket', 'data');
    await cloneDir(from, to);
    await makeDistinct(to);

    expect(await fs.readFile(path.join(to, 'app', 'client.ibd'), 'utf-8')).toBe('rows');
    await expect(fs.access(path.join(to, 'auto.cnf'))).rejects.toThrow();
    await expect(fs.access(path.join(to, 'mysqld.pid'))).rejects.toThrow();
    // The original is untouched.
    expect(await fs.readFile(path.join(from, 'auto.cnf'), 'utf-8')).toContain('server-uuid');
    await fs.rm(base, { recursive: true, force: true });
  });
});

describe('choosing the server binary for a copy', () => {
  const found = [
    { path: '/m/mariadb@10.8', version: '10.8.8', flavor: 'mariadb' as const },
    { path: '/m/mysql@8.0', version: '8.0.39', flavor: 'mysql' as const },
    { path: '/m/mysql', version: '9.2.0', flavor: 'mysql' as const },
  ];
  it('takes the same kind and version', () => {
    expect(pickMysqld(found, '10.8.8-MariaDB')?.path).toBe('/m/mariadb@10.8');
    expect(pickMysqld(found, '8.0.32')?.path).toBe('/m/mysql@8.0');
  });
  it('falls back to the newest of the same kind, never the other kind', () => {
    expect(pickMysqld(found, '8.4.1')?.path).toBe('/m/mysql');
    expect(pickMysqld([found[0]], '8.0.32')).toBeNull();
    expect(pickMysqld([found[1]], '10.6.4-MariaDB')).toBeNull();
  });
  it('takes the newest of anything when the version is unknown', () => {
    expect(pickMysqld(found, '')?.path).toBe('/m/mariadb@10.8');
  });
});

describe('the settings a copy starts with', () => {
  it('passes the known ones as flags, and nothing else', () => {
    expect(
      settingFlags({
        sql_mode: 'NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES',
        innodb_strict_mode: 'OFF',
        innodb_default_row_format: 'dynamic',
        init_file: '/tmp/evil.sql',
        innodb_strict_mode_x: 'ON',
      }),
    ).toEqual(['--sql-mode=NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES', '--innodb-strict-mode=OFF', '--innodb-default-row-format=dynamic']);
  });
  it('drops a value with anything a setting never holds', () => {
    expect(settingFlags({ sql_mode: "ANSI' --init-file=/x" })).toEqual([]);
    expect(settingFlags(undefined)).toEqual([]);
  });
});
