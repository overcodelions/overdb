import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedCatalog } from '../shared/types';

let home = '';
vi.mock('electron', () => ({ app: { getPath: () => home } }));

const { CatalogStore } = await import('./catalogStore');

function catalog(connectionId: string, schema: string, patch: Partial<SavedCatalog> = {}): SavedCatalog {
  return {
    connectionId,
    schema,
    savedAt: '2026-09-28T00:00:00Z',
    engine: 'mysql',
    serverVersion: '8.0',
    info: { name: schema, tables: [] },
    ...patch,
  };
}

describe('CatalogStore', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-catalogs-'));
  });

  it('has nothing for a connection it has never kept', () => {
    expect(CatalogStore.list('prod')).toEqual([]);
  });

  it('keeps one catalog per schema, the latest winning', () => {
    CatalogStore.save(catalog('prod', 'acme', { savedAt: '2026-09-01T00:00:00Z' }));
    CatalogStore.save(catalog('prod', 'acme', { savedAt: '2026-09-28T00:00:00Z' }));
    CatalogStore.save(catalog('prod', 'billing'));
    const kept = CatalogStore.list('prod');
    expect(kept.map((c) => [c.schema, c.savedAt]).sort()).toEqual([
      ['acme', '2026-09-28T00:00:00Z'],
      ['billing', '2026-09-28T00:00:00Z'],
    ]);
  });

  it('keeps connections apart', () => {
    CatalogStore.save(catalog('prod', 'acme'));
    CatalogStore.save(catalog('staging', 'acme'));
    expect(CatalogStore.list('staging').map((c) => c.connectionId)).toEqual(['staging']);
  });

  it('cannot be pointed outside its folder by a connection id', () => {
    CatalogStore.save(catalog('../../escape', 'acme'));
    expect(fs.readdirSync(path.join(home, 'catalogs'))).toEqual(['______escape.json']);
  });

  it('drops the catalogs of connections that are gone', () => {
    CatalogStore.save(catalog('prod', 'acme'));
    CatalogStore.save(catalog('removed', 'acme'));
    CatalogStore.prune(['prod']);
    expect(CatalogStore.list('prod')).toHaveLength(1);
    expect(CatalogStore.list('removed')).toEqual([]);
  });
});
