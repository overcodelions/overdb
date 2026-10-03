import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneDir, compareVersions, makeDistinct } from './instances';

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
