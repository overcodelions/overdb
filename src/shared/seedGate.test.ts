import { describe, expect, it } from 'vitest';

import type { Connection } from './types';
import {
  SEED_MAX_ROWS,
  classifyListener,
  connectionChecks,
  isLoopback,
  seedGate,
  seedRefusal,
  sizeGates,
} from './seedGate';

const local: Connection = {
  id: 'c1',
  name: 'orders-docker',
  engine: 'postgres',
  env: 'local',
  host: 'localhost',
  port: 5432,
  writesEnabled: true,
};

const small = { tables: [{ schema: 'public', table: 'orders', rows: 240, capped: false }] };

describe('isLoopback', () => {
  it('knows the loopback spellings and sockets', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.1.1', '::1', '/tmp/.s.PGSQL.5432', undefined]) {
      expect(isLoopback(h), String(h)).toBe(true);
    }
  });

  it('does not treat a LAN or remote host as this machine', () => {
    for (const h of ['10.0.4.12', 'db.internal', '192.168.1.5', 'localhost.example.com']) {
      expect(isLoopback(h), h).toBe(false);
    }
  });
});

describe('seedGate', () => {
  it('passes a local, writable, direct, small database', () => {
    const gate = seedGate(local, small);
    expect(gate.ok).toBe(true);
    expect(gate.checks.map((c) => c.id)).toEqual(['env', 'writes', 'machine', 'size']);
  });

  it('is not ok while the rows are still being counted', () => {
    const gate = seedGate(local, null);
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((c) => c.id === 'size')?.ok).toBeNull();
  });

  it('refuses a local tag reached through an SSH tunnel', () => {
    const tunnelled = { ...local, port: 5433, tunnel: { target: 'bastion.internal', remoteHost: '10.0.4.12' } };
    const machine = seedGate(tunnelled, small).checks.find((c) => c.id === 'machine')!;
    expect(machine.ok).toBe(false);
    expect(machine.detail).toBe('localhost:5433 → bastion.internal → 10.0.4.12');
  });

  it('refuses a remote host however it is tagged', () => {
    expect(seedGate({ ...local, host: 'db.internal' }, small).ok).toBe(false);
  });

  it('refuses anything not tagged local, and anything without writes', () => {
    expect(seedGate({ ...local, env: 'dev' }, small).ok).toBe(false);
    expect(seedGate({ ...local, writesEnabled: false }, small).ok).toBe(false);
  });

  it('refuses a database with a production-sized table', () => {
    const big = { tables: [...small.tables, { schema: 'public', table: 'events', rows: SEED_MAX_ROWS, capped: true }] };
    const size = seedGate(local, big).checks.find((c) => c.id === 'size')!;
    expect(size.ok).toBe(false);
    expect(size.detail).toContain('events has at least 1,000,000 rows');
  });

  it('passes a SQLite file without a host', () => {
    const file: Connection = { id: 's', name: 'shop-local', engine: 'sqlite', env: 'local', file: '/tmp/shop.db', writesEnabled: true };
    expect(seedGate(file, small).ok).toBe(true);
  });

  it('refuses DynamoDB outright', () => {
    const dynamo: Connection = { ...local, engine: 'dynamodb' };
    expect(connectionChecks(dynamo)[0]).toMatchObject({ id: 'engine', ok: false });
  });
});

describe('seedRefusal', () => {
  it('says nothing for a seedable connection', () => {
    expect(seedRefusal(local)).toBeNull();
  });

  it('names the first check that failed', () => {
    expect(seedRefusal({ ...local, env: 'prod' })).toBe('Seeding refused: tagged prod, not local.');
    expect(seedRefusal(undefined)).toBe('No such connection.');
  });
});

describe('the port listener', () => {
  const huge = { tables: [{ schema: 'app', table: 'content_form_submission_data', rows: SEED_MAX_ROWS, capped: true }] };
  const mysql: Connection = { ...local, engine: 'mysql', port: 3306 };

  it('classifies servers, container runtimes and forwards', () => {
    for (const p of ['mariadbd', 'mysqld', 'postgres', 'com.docker.backend', 'OrbStack']) {
      expect(classifyListener(p), p).not.toBe('forward');
    }
    expect(classifyListener('mariadbd')).toBe('server');
    expect(classifyListener('com.docker.backend')).toBe('server');
    for (const p of ['ssh', 'kubectl', 'cloud-sql-proxy', 'cloud_sql_proxy', 'session-manager-plugin', 'socat']) {
      expect(classifyListener(p), p).toBe('forward');
    }
    expect(classifyListener('pgbouncer')).toBe('unknown');
  });

  it('lets a confirmed local server hold a production-sized dump', () => {
    const gate = seedGate(mysql, { ...huge, listener: { process: 'mariadbd', kind: 'server' } });
    expect(gate.ok).toBe(true);
    expect(gate.checks.map((c) => c.id)).toEqual(['env', 'writes', 'machine']);
    expect(gate.checks.find((c) => c.id === 'machine')?.detail).toBe('mariadbd is listening on localhost:3306');
  });

  it('refuses a port held by a forward, whatever the size', () => {
    const gate = seedGate(mysql, { ...small, listener: { process: 'kubectl', kind: 'forward' } });
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((c) => c.id === 'machine')).toMatchObject({
      ok: false,
      label: 'Port-forwarded, not a local server',
      detail: 'kubectl is listening on localhost:3306',
    });
  });

  it('falls back to size when the owner cannot be seen', () => {
    expect(seedGate(mysql, { ...huge, listener: null }).ok).toBe(false);
    expect(seedGate(mysql, { ...huge, listener: { process: 'pgbouncer', kind: 'unknown' } }).ok).toBe(false);
    expect(sizeGates(mysql, null)).toBe(true);
    expect(sizeGates(mysql, { process: 'mariadbd', kind: 'server' })).toBe(false);
  });

  it('never asks size of a SQLite file', () => {
    const file: Connection = { id: 's', name: 'f', engine: 'sqlite', env: 'local', file: '/tmp/big.db', writesEnabled: true };
    expect(seedGate(file, huge).ok).toBe(true);
  });
});
