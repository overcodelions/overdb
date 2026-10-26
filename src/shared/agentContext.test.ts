import { describe, expect, it } from 'vitest';
import {
  changedSince,
  describeText,
  detectTenant,
  resolveAgentContext,
  serverInstructions,
  tenancySentence,
  tenantOrigin,
  tenantVia,
} from './agentContext';
import { schemaFingerprint, type DbMap } from './dbMap';
import type { SchemaSnapshot, TableInfo } from './types';

function table(name: string, columns: string[], fks: Array<[string, string, string]> = []): TableInfo {
  return {
    name,
    kind: 'table',
    columns: columns.map((c, i) => ({ name: c, ordinal: i, typeName: 'int8', nullable: false, defaultExpr: null })),
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: fks.map(([column, refTable, refColumn]) => ({ name: `${name}_${column}_fk`, columns: [column], refSchema: 'public', refTable, refColumns: [refColumn] })),
  } as TableInfo;
}

const multiTenant: SchemaSnapshot = {
  engine: 'postgres',
  serverVersion: '16',
  capturedAt: '2026-01-01T00:00:00Z',
  schemas: [
    {
      name: 'public',
      tables: [
        table('clients', ['id', 'name']),
        table('orders', ['id', 'client_id'], [['client_id', 'clients', 'id']]),
        table('invoices', ['id', 'client_id'], [['client_id', 'clients', 'id']]),
        table('products', ['id', 'client_id'], [['client_id', 'clients', 'id']]),
        table('shipments', ['id', 'client_id'], [['client_id', 'clients', 'id']]),
      ],
    },
  ],
};

const map: DbMap = {
  version: 1,
  owner: { kind: 'connection', id: 'c1', name: 'shop' },
  builtAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  repos: [],
  schemas: { public: 'old-fingerprint' },
  tables: {
    'public.orders': { purpose: 'An order a client placed.', values: [{ column: 'status', values: ['pending', 'shipped', 'done'], ref: 'app/models/order.rb:12' }], json: [], rules: [{ text: 'Soft-deleted rows have deleted_at set.', ref: 'app/models/order.rb:30' }] },
    'public.clients': { purpose: 'A tenant.', values: [], json: [], rules: [] },
  },
  links: [{ from: 'public.orders.client_id', to: 'public.clients.id', why: 'belongs_to :client' }],
};

const tenant = { schema: 'public', table: 'clients', column: 'id' };

describe('resolveAgentContext', () => {
  it('takes your setting over the recipe', () => {
    const recipe = { schema: 'public', table: 'accounts', column: 'id' };
    expect(resolveAgentContext({ setting: { tenant }, recipeTenant: recipe }).tenant).toMatchObject({ table: 'clients', source: 'set' });
    expect(resolveAgentContext({ recipeTenant: recipe }).tenant).toMatchObject({ table: 'accounts', source: 'recipe' });
  });

  it('only suggests a detected tenant, and only while nothing is decided', () => {
    expect(resolveAgentContext({ detected: tenant })).toMatchObject({ tenant: null, suggestion: { table: 'clients' } });
    expect(resolveAgentContext({ detected: tenant, recipeTenant: tenant }).suggestion).toBeNull();
    expect(resolveAgentContext({ detected: tenant, setting: { tenant: 'none' } }).suggestion).toBeNull();
  });

  it('hears "no tenants" from you or from a recipe made without one, and then detects nothing', () => {
    expect(resolveAgentContext({ setting: { tenant: 'none' }, detected: tenant })).toMatchObject({ tenant: null, noTenant: { source: 'set' } });
    expect(resolveAgentContext({ recipeTenant: null, detected: tenant })).toMatchObject({ tenant: null, noTenant: { source: 'recipe' } });
  });

  it('includes the map when there is one, unless turned off', () => {
    expect(resolveAgentContext({ map }).map).toMatchObject({ available: true, included: true });
    expect(resolveAgentContext({ map, setting: { map: false } }).map).toMatchObject({ available: true, included: false });
    expect(resolveAgentContext({}).map).toMatchObject({ available: false, included: false });
  });
});

describe('detectTenant', () => {
  it('names a clear hub', () => {
    expect(detectTenant(multiTenant)).toEqual({ schema: 'public', table: 'clients', column: 'id' });
  });

  it('never takes the users table for the tenant', () => {
    const people: SchemaSnapshot = {
      ...multiTenant,
      schemas: [{
        name: 'public',
        tables: [
          { ...table('users', ['id']), columns: ['id', 'email', 'password_digest'].map((c, i) => ({ name: c, ordinal: i, typeName: c === 'id' ? 'int8' : 'varchar', nullable: false, defaultExpr: null })) },
          table('posts', ['id', 'user_id'], [['user_id', 'users', 'id']]),
          table('comments', ['id', 'user_id'], [['user_id', 'users', 'id']]),
          table('likes', ['id', 'user_id'], [['user_id', 'users', 'id']]),
        ],
      }],
    };
    expect(detectTenant(people)).toBeNull();
  });

  it('names nothing when no table is clearly the hub', () => {
    const flat: SchemaSnapshot = { ...multiTenant, schemas: [{ name: 'public', tables: [table('users', ['id']), table('posts', ['id', 'user_id'], [['user_id', 'users', 'id']]), table('tags', ['id'])] }] };
    expect(detectTenant(flat)).toBeNull();
  });
});

describe('what agents are told', () => {
  it('states a known tenant as a rule, and tells agents nothing it only detected', () => {
    const via = (t: { schema: string; table: string; column: string }) => tenantVia(multiTenant, t);
    expect(tenancySentence('shop', resolveAgentContext({ recipeTenant: tenant, via }))).toBe(
      'shop is multi-tenant: every row belongs to one tenant in public.clients, through client_id. Scope every query to one tenant — filter on client_id, or join through a table that has it — unless the question is explicitly about all tenants.',
    );
    expect(tenancySentence('shop', resolveAgentContext({ detected: tenant, via }))).toBeNull();
    // Before the catalog is read it describes the link rather than naming a column, and never says to filter on the key itself.
    expect(tenancySentence('shop', resolveAgentContext({ recipeTenant: tenant }))).toContain('filter on the column that points at public.clients.id');
    expect(tenancySentence('shop', resolveAgentContext({ setting: { tenant: 'none' } }))).toBe('shop is not multi-tenant.');
    expect(tenancySentence('shop', resolveAgentContext({}))).toBeNull();
  });

  it('says where the tenant came from', () => {
    expect(tenantOrigin(resolveAgentContext({ recipeTenant: tenant }))).toBe('from your base recipe');
    expect(tenantOrigin(resolveAgentContext({ detected: tenant }))).toBe('not set');
  });

  it('points the agent at describe_database and carries each rule and note', () => {
    const text = serverInstructions([
      { name: 'shop', ctx: resolveAgentContext({ recipeTenant: tenant, setting: { notes: 'Amounts are in cents.' } }) },
      { name: 'logs', ctx: resolveAgentContext({}) },
    ]);
    expect(text).toContain('call describe_database');
    expect(text).toContain('shop is multi-tenant');
    expect(text).toContain('Notes on shop: Amounts are in cents.');
    expect(text).not.toContain('logs');
  });

  it('answers a question from the map, with the code refs', () => {
    const ctx = resolveAgentContext({ map, recipeTenant: tenant });
    const text = describeText('shop', ctx, map, 'how many orders shipped');
    expect(text).toContain('public.orders — An order a client placed.');
    expect(text).toContain('status ∈ {pending, shipped, done} (app/models/order.rb:12)');
    expect(text).toContain('public.orders.client_id → public.clients.id');
  });

  it('gives an overview without a question, and says when the map is out of date', () => {
    const changed = changedSince(map, multiTenant);
    expect(changed).toEqual(['public']);
    const text = describeText('shop', resolveAgentContext({ map, changed }), map);
    expect(text).toContain('since then public changed');
    expect(text).toContain('public.clients — A tenant.');
  });

  it('says why there is no map rather than saying nothing', () => {
    expect(describeText('shop', resolveAgentContext({}), null)).toContain('no map of shop');
    expect(describeText('shop', resolveAgentContext({ map, setting: { map: false } }), map)).toContain('turned off for agents');
    expect(changedSince({ ...map, schemas: { public: schemaFingerprint(multiTenant.schemas[0]) } }, multiTenant)).toEqual([]);
  });
});
