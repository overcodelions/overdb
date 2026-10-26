// The MCP tools, driven by a real MCP client over the SDK's in-memory
// transport. The database is faked at the deps seam — what is under test is
// what an agent can see and what it can get sent.

import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MAX_CELL_CHARS, createOverdbMcpServer, queryRefusal, type McpDeps } from './tools';
import type { Connection } from '../shared/types';
import type { HealthSnapshot } from '../shared/health';

function conn(over: Partial<Connection>): Connection {
  return { id: 'c1', name: 'shop-local', engine: 'postgres', env: 'local', ...over } as Connection;
}

const SHOP_LOCAL = conn({ id: 'c1', name: 'shop-local', mcpExposed: true, database: 'shop' });
const SHOP_STAGING = conn({ id: 'c2', name: 'shop-staging', env: 'staging', mcpExposed: true });
const SHOP_PROD = conn({ id: 'c3', name: 'shop-prod', env: 'prod' });

let sent: string[];
let opened: string[];

function deps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    connections: () => [SHOP_LOCAL, SHOP_STAGING, SHOP_PROD],
    ensureOpen: async (c) => {
      opened.push(c.id);
    },
    listTables: async () => [
      { schema: 'public', table: 'orders', kind: 'table' },
      { schema: 'audit', table: 'events', kind: 'table' },
    ],
    introspect: async () => ({
      engine: 'postgres',
      serverVersion: '16',
      capturedAt: '2026-01-01T00:00:00Z',
      schemas: [
        {
          name: 'public',
          tables: [
            {
              name: 'orders',
              kind: 'table',
              columns: [{ name: 'id', ordinal: 1, typeName: 'int8', nullable: false, defaultExpr: null }],
              primaryKey: ['id'],
              indexes: [],
              foreignKeys: [],
            },
          ],
        },
      ],
    }),
    query: async (_c, sql) => {
      sent.push(sql);
      return {
        columns: [{ name: 'id' }, { name: 'note' }, { name: 'blob' }] as never,
        rows: [[1, 'x'.repeat(MAX_CELL_CHARS + 10), { __bin: true, b64: '', byteLength: 12, truncated: false }]],
        rowCount: 1,
        truncated: false,
      };
    },
    health: async () =>
      ({
        capturedAt: 'now',
        connections: { used: 3, max: 100 },
        sessions: [{ id: '42', query: 'select 1', state: 'active' }],
      }) as unknown as HealthSnapshot,
    slowQuerySupport: async () => ({ supported: false, reason: { code: 'unsupported', detail: 'SQLite keeps no statement statistics.', engine: 'sqlite' } }),
    slowQueries: async () => [],
    ...over,
  };
}

async function connect(d: McpDeps): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createOverdbMcpServer(d).connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const text = res.content[0]?.text ?? '';
  return { isError: Boolean(res.isError), text, json: res.isError ? null : JSON.parse(text) };
}

beforeEach(() => {
  sent = [];
  opened = [];
});

describe('overdb serve --mcp', () => {
  it('offers only read tools, under names overcli treats as reads', async () => {
    const client = await connect(deps());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['describe_database', 'describe_table', 'list_connections', 'list_slow_queries', 'list_tables', 'query', 'show_sessions']);
    // overcli's isReadOnlyMcpTool counts `run` as a write word.
    for (const n of names) expect(n.split('_')).not.toContain('run');
  });

  it('lists exposed connections and nothing else', async () => {
    const client = await connect(deps());
    const { json } = await call(client, 'list_connections');
    expect(json.map((c: { name: string }) => c.name)).toEqual(['shop-local', 'shop-staging']);
    expect(JSON.stringify(json)).not.toContain('shop-prod');
  });

  it('answers an unexposed connection exactly as a missing one, without opening it', async () => {
    const client = await connect(deps());
    const hidden = await call(client, 'list_tables', { connection: 'shop-prod' });
    const missing = await call(client, 'list_tables', { connection: 'nope' });
    expect(hidden.isError).toBe(true);
    expect(hidden.text.replace('shop-prod', 'X')).toBe(missing.text.replace('nope', 'X'));
    expect(opened).toEqual([]);
  });

  it('finds a connection by id or by name in any case', async () => {
    const client = await connect(deps());
    expect((await call(client, 'list_tables', { connection: 'c2' })).isError).toBe(false);
    expect((await call(client, 'list_tables', { connection: 'SHOP-Local', schema: 'audit' })).json).toEqual([
      { schema: 'audit', table: 'events', kind: 'table' },
    ]);
  });

  it('reads the store on every call, so exposing a connection needs no restart', async () => {
    let all = [SHOP_LOCAL, SHOP_PROD];
    const client = await connect(deps({ connections: () => all }));
    expect((await call(client, 'list_connections')).json).toHaveLength(1);
    all = [SHOP_LOCAL, { ...SHOP_PROD, mcpExposed: true }];
    expect((await call(client, 'list_connections')).json).toHaveLength(2);
  });

  it('runs a read, and shapes cells for a model', async () => {
    const client = await connect(deps());
    const { json } = await call(client, 'query', { connection: 'shop-local', sql: 'select * from orders' });
    expect(sent).toEqual(['select * from orders']);
    expect(json.columns).toEqual(['id', 'note', 'blob']);
    expect(json.rows[0][0]).toBe(1);
    expect(json.rows[0][1]).toMatch(/… \(2010 chars\)$/);
    expect(json.rows[0][2]).toBe('<12 bytes>');
  });

  it.each([
    'delete from orders',
    "update orders set note = 'x'",
    'drop table orders',
    'begin',
    'select 1; delete from orders',
  ])('sends nothing for %s', async (sql) => {
    const client = await connect(deps());
    const res = await call(client, 'query', { connection: 'shop-local', sql });
    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('caps maxRows', async () => {
    const client = await connect(deps());
    const res = (await client.callTool({
      name: 'query',
      arguments: { connection: 'shop-local', sql: 'select 1', maxRows: 50_000 },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('describes one table, qualified or not', async () => {
    const client = await connect(deps());
    const { json } = await call(client, 'describe_table', { connection: 'shop-local', table: 'public.orders' });
    expect(json).toMatchObject({ schema: 'public', name: 'orders', primaryKey: ['id'] });
    expect((await call(client, 'describe_table', { connection: 'shop-local', table: 'nope' })).isError).toBe(true);
  });

  it('shows sessions, and says why slow queries are unavailable', async () => {
    const client = await connect(deps());
    expect((await call(client, 'show_sessions', { connection: 'shop-local' })).json.sessions[0].id).toBe('42');
    const slow = await call(client, 'list_slow_queries', { connection: 'shop-local' });
    expect(slow.isError).toBe(true);
    expect(slow.text).toContain('SQLite keeps no statement statistics.');
  });

  it('turns a connect failure into a tool error the agent can read', async () => {
    const client = await connect(deps({ ensureOpen: async () => { throw new Error('VPN is down'); } }));
    const res = await call(client, 'list_tables', { connection: 'shop-local' });
    expect(res).toMatchObject({ isError: true, text: 'VPN is down' });
  });
});

describe('queryRefusal', () => {
  it('lets one read through', () => {
    expect(queryRefusal('with x as (select 1) select * from x', SHOP_LOCAL)).toBeNull();
    expect(queryRefusal('select 1;', SHOP_LOCAL)).toBeNull();
  });

  it('names the connection nothing was sent to', () => {
    expect(queryRefusal('truncate orders', SHOP_LOCAL)).toContain('Nothing was sent to shop-local');
  });
});

describe('the query log', () => {
  it('records each call by connection: the SQL and row count, never rows or values', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const client = await connect(deps({ record: (e) => entries.push(e as unknown as Record<string, unknown>) }));
    await call(client, 'query', { connection: 'shop-local', sql: 'select * from orders where id = $1', params: ['secret-customer-42'] });
    await call(client, 'query', { connection: 'shop-local', sql: 'delete from orders' });
    await call(client, 'list_tables', { connection: 'shop-prod' });
    await call(client, 'describe_database', { connection: 'shop-prod' });
    expect(entries.map((e) => [e.tool, e.connection, e.ok])).toEqual([
      ['query', 'shop-local', true],
      ['query', 'shop-local', false],
      ['list_tables', 'shop-prod', false],
      ['describe_database', 'shop-prod', false],
    ]);
    expect(entries[0]).toMatchObject({ sql: 'select * from orders where id = $1', params: 1, rowCount: 1, truncated: false });
    const text = JSON.stringify(entries);
    expect(text).not.toContain('secret-customer-42');
    expect(text).not.toContain('xxxx');
  });
});
