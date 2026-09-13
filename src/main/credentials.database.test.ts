// A mysql connection saved with an empty database and a defaultSchema came
// up on no database at all: `defaultSchema` was only ever read as postgres's
// searchPath, so every unqualified statement failed with "No database
// selected" while the picker showed the schema you had chosen. The engine
// split is the whole point — the two words mean the same thing to mysql and
// different things to postgres, so the fallback must not cross over.

import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '../shared/types';
import { resolve } from './credentials';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('./secrets', () => ({ getSecret: () => undefined }));

/// No secret source, so nothing reaches for a keychain.
const conn = (over: Partial<Connection>): Connection =>
  ({
    id: 'c1',
    name: 'localhost',
    engine: 'mysql',
    host: 'localhost',
    port: 3306,
    user: 'root',
    env: 'local',
    secretSource: 'none',
    ...over,
  }) as Connection;

describe('which database a spec comes up on', () => {
  it('falls back to defaultSchema when mysql has no database', async () => {
    const spec = await resolve(conn({ database: '', defaultSchema: 'inventory' }));
    expect(spec.database).toBe('inventory');
  });

  it('leaves a mysql database that was actually set alone', async () => {
    const spec = await resolve(conn({ database: 'app', defaultSchema: 'inventory' }));
    expect(spec.database).toBe('app');
  });

  it('never turns a postgres schema into a database', async () => {
    // Connecting to a database named `public` is a different server, not a
    // different schema — postgres gets the schema through searchPath.
    const spec = await resolve(conn({ engine: 'postgres', database: '', defaultSchema: 'public' }));
    expect(spec.database).toBe('');
    expect(spec.searchPath).toEqual(['public']);
  });
});
