import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDbeaverDataSources, scanDbeaver } from './dbeaver';

// Trimmed from a real DBeaver 24 data-sources.json.
const SAMPLE = JSON.stringify({
  folders: { Production: {} },
  connections: {
    'postgres-jdbc-1': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'orders',
      folder: 'Production',
      'save-password': true,
      configuration: {
        host: 'orders.db.example.com', port: '5433', database: 'orders',
        url: 'jdbc:postgresql://orders.db.example.com:5433/orders',
        type: 'dev', 'auth-model': 'native',
        handlers: {
          ssh_tunnel: { enabled: true, properties: { host: 'bastion' } },
          postgre_ssl: { enabled: true, properties: { sslMode: 'verify-full' } },
        },
      },
    },
    'mysql8-2': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'billing',
      configuration: { url: 'jdbc:mysql://billing.internal/billing', type: 'prod', user: 'reader' },
    },
    'redshift-3': {
      provider: 'postgresql',
      driver: 'redshift',
      name: 'warehouse',
      configuration: { host: 'wh.redshift.amazonaws.com', port: '5439', database: 'dev', type: 'test' },
    },
    'sqlite-4': {
      provider: 'sqlite',
      driver: 'sqlite_jdbc',
      name: 'scratch',
      configuration: { database: '/tmp/scratch.db', url: 'jdbc:sqlite:/tmp/scratch.db' },
    },
    'oracle-5': { provider: 'oracle', driver: 'oracle_thin', name: 'legacy', configuration: {} },
  },
});

describe('parseDbeaverDataSources', () => {
  const byName = Object.fromEntries(
    parseDbeaverDataSources(SAMPLE, 'General').map((c) => [c.name, c]),
  );

  it('reads host, port, database and folder', () => {
    expect(byName.orders).toMatchObject({
      sourceId: 'dbeaver:postgres-jdbc-1',
      origin: 'General',
      engine: 'postgres',
      host: 'orders.db.example.com',
      port: 5433,
      database: 'orders',
      group: 'Production',
      env: 'prod',
      ssl: 'verify-full',
    });
    expect(byName.orders.user).toBeUndefined();
    expect(byName.orders.note).toMatch(/SSH tunnel/);
  });

  it('falls back to the URL and trusts DBeaver\'s prod type', () => {
    expect(byName.billing).toMatchObject({
      engine: 'mysql', host: 'billing.internal', port: 3306,
      database: 'billing', user: 'reader', env: 'prod',
    });
  });

  it('imports Redshift as Postgres and says so', () => {
    expect(byName.warehouse).toMatchObject({ engine: 'postgres', variant: 'redshift', port: 5439, env: 'dev' });
    expect(byName.warehouse.note).toMatch(/Postgres wire/);
  });

  it('treats SQLite as a file, not a host', () => {
    expect(byName.scratch).toMatchObject({ engine: 'sqlite', database: '/tmp/scratch.db' });
    expect(byName.scratch.host).toBeUndefined();
    expect(byName.scratch.port).toBeUndefined();
  });

  it('lists what it cannot connect to, with the reason', () => {
    expect(byName.legacy.engine).toBeNull();
    expect(byName.legacy.note).toMatch(/oracle is not supported/);
  });

  it('returns nothing for a file that is not JSON', () => {
    expect(parseDbeaverDataSources('{ nope', 'General')).toEqual([]);
  });
});

describe('scanDbeaver', () => {
  it('reads every project and every data-sources file, skipping .metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-dbeaver-'));
    try {
      const write = (project: string, file: string, body: string) => {
        const dir = path.join(root, project, '.dbeaver');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), body);
      };
      const one = (id: string, name: string) =>
        JSON.stringify({ connections: { [id]: { provider: 'postgresql', name, configuration: { host: 'h' } } } });
      write('General', 'data-sources.json', one('a', 'alpha'));
      write('General', 'data-sources-2.json', one('b', 'bravo'));
      write('Other', 'data-sources.json', one('c', 'charlie'));
      write('.metadata', 'data-sources.json', one('d', 'delta'));

      expect(scanDbeaver([root]).map((c) => c.name)).toEqual(['alpha', 'bravo', 'charlie']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
