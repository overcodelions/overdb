import { describe, expect, it } from 'vitest';
import type { Connection, EnvSet } from '@shared/types';
import { logicalName, suggestEnvSet } from './envSetHint';

const conn = (id: string, patch: Partial<Connection>): Connection => ({
  id,
  name: id,
  engine: 'postgres',
  env: 'local',
  ...patch,
});

describe('logicalName', () => {
  it('takes the environment out of the database name', () => {
    expect(logicalName(conn('a', { database: 'orders_staging' }))).toBe('orders');
    expect(logicalName(conn('b', { database: 'orders-prod' }))).toBe('orders');
    expect(logicalName(conn('c', { database: 'orders' }))).toBe('orders');
  });

  it('uses a SQLite file name without its extension', () => {
    expect(logicalName(conn('a', { engine: 'sqlite', file: '/tmp/shop-local.sqlite' }))).toBe('shop');
  });

  it('falls back to the connection name', () => {
    expect(logicalName(conn('a', { name: 'Billing (prod)' }))).toBe('billing');
  });
});

describe('suggestEnvSet', () => {
  const local = conn('l', { database: 'orders', env: 'local' });
  const staging = conn('s', { database: 'orders_staging', env: 'staging' });
  const prod = conn('p', { database: 'orders', env: 'prod' });

  it('suggests the same database in different environments, with prod as the baseline', () => {
    const s = suggestEnvSet([local, staging, prod], [], []);
    expect(s).toMatchObject({ name: 'orders', memberIds: ['l', 's', 'p'], baselineId: 'p' });
  });

  it('says nothing about two connections in the same environment', () => {
    expect(suggestEnvSet([local, conn('l2', { database: 'orders', env: 'local' })], [], [])).toBeNull();
  });

  it('says nothing across engines', () => {
    expect(suggestEnvSet([local, conn('m', { engine: 'mysql', database: 'orders', env: 'prod' })], [], [])).toBeNull();
  });

  it('says nothing once a set already holds them', () => {
    const set: EnvSet = { id: 'e', name: 'orders', memberIds: ['l', 's'], baselineId: 's' };
    expect(suggestEnvSet([local, staging], [set], [])).toBeNull();
  });

  it('respects Not now, but asks again when the group grows', () => {
    const first = suggestEnvSet([local, staging], [], [])!;
    expect(suggestEnvSet([local, staging], [], [first.id])).toBeNull();
    expect(suggestEnvSet([local, staging, prod], [], [first.id])).not.toBeNull();
  });
});
