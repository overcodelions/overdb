// The last catalog read from each connection, kept on disk.
//
// For environments you cannot reach at the same time — two VPNs that will
// not both be up — drift still has to compare them. The comparison only
// ever needed catalogs, never a live session, so the last one read from
// each side is enough: read prod on its VPN, switch, and compare it with
// staging on the other.
//
// Catalogs only: table, column, index and key definitions. No rows, and
// nothing from the connection spec. One file per connection under
// `catalogs/`, keyed by schema, so a big catalog is not rewritten into
// overdb.json on every settings change.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SavedCatalog } from '../shared/types';

function dir(): string {
  return path.join(app.getPath('userData'), 'catalogs');
}

function fileFor(connectionId: string): string {
  return path.join(dir(), `${connectionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function read(connectionId: string): Record<string, SavedCatalog> {
  try {
    return JSON.parse(fs.readFileSync(fileFor(connectionId), 'utf-8'));
  } catch {
    return {};
  }
}

export const CatalogStore = {
  list(connectionId: string): SavedCatalog[] {
    return Object.values(read(connectionId)).filter((c) => c.connectionId === connectionId);
  },

  save(catalog: SavedCatalog): void {
    const all = read(catalog.connectionId);
    all[catalog.schema] = catalog;
    fs.mkdirSync(dir(), { recursive: true });
    // Same tmp + rename as overdb.json: a crash mid-write must not leave a
    // half catalog that reads as a table-by-table drop.
    const p = fileFor(catalog.connectionId);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(all), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(`${p}.tmp`, p);
  },

  /// Drop the catalogs of connections that no longer exist.
  prune(keep: string[]): void {
    const wanted = new Set(keep.map((id) => path.basename(fileFor(id))));
    let names: string[];
    try {
      names = fs.readdirSync(dir());
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith('.json') && !wanted.has(name)) fs.rmSync(path.join(dir(), name), { force: true });
    }
  },
};
