import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitBehind, gitChanged, gitHead, loadMap, mapPath, saveMap } from './mapper';
import { emptyMap } from '../shared/dbMap';
import { mapPrompt } from './mapPrompts';

let root = '';
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdb-mapper-'));
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });

describe('where a map lives', () => {
  const owner = { kind: 'envSet' as const, id: 'shop/1', name: 'shop' };
  it('is overdb’s own folder unless the setting says the repo', () => {
    expect(mapPath(owner, { location: 'overdb', userData: '/data', repo: '/code/shop' })).toBe(path.join('/data', 'maps', 'envSet-shop_1.json'));
    expect(mapPath(owner, { location: 'repo', userData: '/data', repo: '/code/shop' })).toBe(path.join('/code/shop', '.overdb', 'map', 'envSet-shop_1.json'));
    expect(mapPath(owner, { location: 'repo', userData: '/data', repo: null })).toBe(path.join('/data', 'maps', 'envSet-shop_1.json'));
  });

  it('saves and loads', async () => {
    const file = path.join(root, 'maps', 'm.json');
    await saveMap(file, emptyMap(owner));
    expect((await loadMap(file))?.owner).toEqual(owner);
    expect(await loadMap(path.join(root, 'none.json'))).toBeNull();
  });
});

describe('what git says', () => {
  it('reads the head, how far it moved, and which files changed', async () => {
    await fs.mkdir(root, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await fs.writeFile(path.join(root, 'a.sql'), 'select 1');
    git('add', '.');
    git('commit', '-qm', 'one');
    const first = await gitHead(root);
    await fs.writeFile(path.join(root, 'b.sql'), 'select 2');
    git('add', '.');
    git('commit', '-qm', 'two');
    const second = await gitHead(root);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitBehind(root, first!, second!)).toBe(1);
    expect(await gitChanged(root, first!, second!)).toEqual(['b.sql']);
    expect(await gitHead(path.join(root, 'maps'))).toBe(second);
    expect(await gitHead(os.tmpdir())).toBeNull();
  });
});

describe('the mapping prompt', () => {
  it('names the repo, its schemas and catalog, and on a refresh only the changed files', () => {
    const full = mapPrompt({ repo: '/code/shop', schemas: ['shop'], catalog: 'shop.orders(id int)', changed: null });
    expect(full).toContain('/code/shop');
    expect(full).toContain('shop.orders(id int)');
    expect(full).toContain('Map the whole of it');
    const refresh = mapPrompt({ repo: '/code/shop', schemas: ['shop'], catalog: '', changed: ['src/Order.java'] });
    expect(refresh).toContain('REFRESH');
    expect(refresh).toContain('- src/Order.java');
  });

  it('maps a big catalog in parts, each describing its own tables', () => {
    const part = mapPrompt({ repo: '/code/shop', schemas: ['shop'], catalog: 'shop.a(id int)\nshop.b(id int)', changed: null, focus: { tables: ['shop.b'], part: 2, of: 2 } });
    expect(part).toContain('part 2 of 2');
    expect(part).toContain('Describe ONLY these tables');
    expect(part).toContain('shop.b');
  });
});
