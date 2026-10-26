import { describe, expect, it } from 'vitest';
import { agentReach, fromHosted, hostedAgentContext, hostedContext, parseHostedContext, parseHostedFile, secretEnvName, toHosted } from './hostedConnection';
import { resolveAgentContext } from './agentContext';
import type { Connection } from './types';

function conn(over: Partial<Connection>): Connection {
  return {
    id: 'c1',
    name: 'shop-staging',
    engine: 'postgres',
    env: 'staging',
    host: 'shop-staging.example.internal',
    port: 5432,
    database: 'shop',
    user: 'dana',
    ssl: 'verify-full',
    ...over,
  } as Connection;
}

describe('toHosted', () => {
  it('carries where the database is and nothing that unlocks it', () => {
    const laptop = conn({
      secretSource: 'stored',
      secretRef: 'ref-123',
      secretEnvVar: 'MY_LAPTOP_VAR',
      secretCommand: 'op://Private/shop/password',
      secretArgv: ['security', 'find-generic-password', '-w'],
      sslRootCert: '/Users/dana/certs/ca.pem',
      sslCert: '/Users/dana/certs/client.pem',
      sslKey: '/Users/dana/certs/client.key',
      awsProfile: 'dana-admin',
      writesEnabled: true,
      mcpExposed: true,
      repoPaths: ['/Users/dana/code/shop'],
      defaultSchema: 'public',
    } as Partial<Connection>);
    const res = toHosted(laptop);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      id: 'c1',
      name: 'shop-staging',
      env: 'staging',
      engine: 'postgres',
      host: 'shop-staging.example.internal',
      port: 5432,
      database: 'shop',
      user: 'dana',
      ssl: 'verify-full',
      defaultSchema: 'public',
      credential: { source: 'secret', env: 'OVERDB_SHOP_STAGING_PASSWORD' },
    });
    const text = JSON.stringify(res.value);
    for (const leak of ['ref-123', 'MY_LAPTOP_VAR', 'op://', 'security', '/Users/dana', 'dana-admin']) {
      expect(text).not.toContain(leak);
    }
  });

  it('keeps IAM auth as IAM auth, to be signed by the server’s role', () => {
    const res = toHosted(conn({ secretSource: 'aws-iam', user: 'overgo_ro' }));
    expect(res.ok && res.value.credential).toEqual({ source: 'aws-iam' });
  });

  it('signs in as the user it is given, not as you', () => {
    const res = toHosted(conn({ secretSource: 'stored', secretRef: 'r' }), { user: 'overgo_ro' });
    expect(res.ok && res.value.user).toBe('overgo_ro');
  });

  it('gives DynamoDB to the server’s role, without the laptop profile', () => {
    const res = toHosted(conn({ engine: 'dynamodb', host: undefined, region: 'eu-west-1', awsProfile: 'dana' } as Partial<Connection>));
    expect(res.ok && res.value).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1', credential: { source: 'none' } });
    expect(JSON.stringify(res)).not.toContain('dana');
  });

  it.each([
    ['a SQLite file', conn({ engine: 'sqlite', host: undefined, file: '/tmp/x.db' } as Partial<Connection>), 'sqlite'],
    ['a server on this machine', conn({ host: 'localhost' }), 'is this machine'],
    ['a branch', conn({ branchOf: 'c0' } as Partial<Connection>), 'branch'],
    ['a tunnelled connection', conn({ tunnel: { target: 'bastion' } } as Partial<Connection>), 'SSH tunnel'],
  ])('refuses %s', (_label, c, says) => {
    const res = toHosted(c);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(says);
  });
});

describe('secretEnvName', () => {
  it('makes a variable name from any connection name', () => {
    expect(secretEnvName('shop-staging')).toBe('OVERDB_SHOP_STAGING_PASSWORD');
    expect(secretEnvName('  Orders DB (EU) ')).toBe('OVERDB_ORDERS_DB_EU_PASSWORD');
    expect(secretEnvName('---')).toBe('OVERDB_CONNECTION_PASSWORD');
  });
});

describe('parseHostedFile', () => {
  it('reads what toHosted writes, exposed, with the secret as an env reference', () => {
    const pushed = toHosted(conn({ secretSource: 'stored', secretRef: 'r' }));
    if (!pushed.ok) throw new Error(pushed.error);
    const { connections, problems } = parseHostedFile({ version: 1, connections: [pushed.value] });
    expect(problems).toEqual([]);
    expect(connections[0]).toMatchObject({
      name: 'shop-staging',
      mcpExposed: true,
      secretSource: 'env',
      secretEnvVar: 'OVERDB_SHOP_STAGING_PASSWORD',
    });
  });

  it('skips a bad entry, says why, and keeps the rest', () => {
    const good = { id: 'a', name: 'orders', env: 'prod', engine: 'mysql', host: 'db', credential: { source: 'aws-iam' } };
    const { connections, problems } = parseHostedFile({
      version: 1,
      connections: [
        good,
        { ...good, id: 'b', name: 'files', engine: 'sqlite' },
        { ...good, id: 'c', name: 'nohost', host: undefined },
        { ...good, id: 'd', name: 'badsecret', credential: { source: 'secret', env: 'lower case' } },
        { ...good, id: 'e', name: 'dyn', engine: 'dynamodb', region: 'us-east-1', credential: { source: 'aws-iam' } },
        { ...good, id: 'f', name: 'ORDERS' },
        { ...good, id: 'g', name: 'cmd', credential: { source: 'command', argv: ['rm', '-rf', '/'] } },
      ],
    });
    expect(connections.map((c) => c.name)).toEqual(['orders']);
    expect(problems).toHaveLength(6);
    expect(problems.join('\n')).toMatch(/files: engine must be/);
    expect(problems.join('\n')).toMatch(/nohost needs a host/);
    expect(problems.join('\n')).toMatch(/appears twice/);
  });

  it('refuses a file it does not understand rather than guessing', () => {
    expect(parseHostedFile({ version: 2, connections: [] }).problems[0]).toMatch(/version 2/);
    expect(parseHostedFile(null).problems[0]).toMatch(/connections/);
  });

  it('round-trips through fromHosted without inventing a credential', () => {
    const c = fromHosted({ id: 'x', name: 'x', env: 'dev', engine: 'postgres', host: 'h', credential: { source: 'none' } });
    expect(c.secretSource).toBe('none');
    expect(c.secretRef).toBeUndefined();
  });
});

describe('agentReach', () => {
  it('says nothing for a connection only you can read', () => {
    expect(agentReach({})).toBeNull();
  });

  it('names each way agents can read it', () => {
    expect(agentReach({ mcpExposed: true })).toContain('agents on this machine');
    expect(agentReach({ orgPublishedAt: '2026-10-24T12:00:00.000Z' })).toContain('org’s server for hosted agents on 2026-10-24');
    expect(agentReach({ mcpExposed: true, orgPublishedAt: '2026-10-24T12:00:00.000Z' })).toMatch(/this machine.*; and sent to your org/);
  });
});

describe('toHosted and the agent mark', () => {
  it('never sends when it was last published', () => {
    const res = toHosted(conn({ orgPublishedAt: '2026-10-24T12:00:00.000Z' } as Partial<Connection>));
    expect(JSON.stringify(res)).not.toContain('2026-10-24');
  });
});

describe('what agents are told, carried to a server', () => {
  const map = {
    version: 1,
    owner: { kind: 'connection' as const, id: 'c1', name: 'shop' },
    builtAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    repos: [{ path: '/Users/dana/code/shop', head: 'abc', mappedAt: '2026-09-01', schemas: ['public'] }],
    schemas: { public: 'fp' },
    tables: { 'public.orders': { purpose: 'An order.', repo: '/Users/dana/code/shop', values: [{ column: 'status', values: ['pending', 'shipped'] }], json: [], rules: [] } },
    links: [{ from: 'public.orders.client_id', to: 'public.clients.id', why: 'belongs_to' }],
  };
  const tenant = { schema: 'public', table: 'clients', column: 'id' };

  it('carries a decided tenant with its filter column, the notes and the map — and no laptop path', () => {
    const ctx = resolveAgentContext({ recipeTenant: tenant, setting: { notes: 'Cents.' }, map, via: () => ['client_id'] });
    const hc = hostedContext(ctx, map)!;
    expect(hc.tenant).toEqual({ ...tenant, via: ['client_id'] });
    expect(hc.notes).toBe('Cents.');
    expect(hc.map!.tables['public.orders'].repo).toBe('shop');
    expect(JSON.stringify(hc)).not.toContain('/Users/dana');
  });

  it('never carries a mere suggestion, or a map that was left out', () => {
    expect(hostedContext(resolveAgentContext({ detected: tenant }), null)).toBeUndefined();
    expect(hostedContext(resolveAgentContext({ map, setting: { map: false } }), map)).toBeUndefined();
  });

  it('reads back what it wrote, and drops what does not check out', () => {
    const hc = hostedContext(resolveAgentContext({ recipeTenant: tenant, map, via: () => ['client_id'] }), map)!;
    expect(parseHostedContext(JSON.parse(JSON.stringify(hc)))).toEqual(hc);
    const withCaveats = hostedContext(
      resolveAgentContext({ recipeTenant: tenant, setting: { caveats: { shared: ['public.countries'], excluded: ['2'] } }, via: () => ['client_id'] }),
      null,
    )!;
    expect(withCaveats.tenant?.caveats).toEqual({ shared: ['public.countries'], excluded: ['2'] });
    expect(parseHostedContext(JSON.parse(JSON.stringify(withCaveats)))).toEqual(withCaveats);
    expect(parseHostedContext({ tenant: { schema: 1 }, notes: 42, map: { builtAt: 'x', tables: { a: { purpose: 7 } } }, extra: 'y' })).toEqual({
      map: { builtAt: 'x', schemas: {}, tables: {}, links: [] },
    });
  });

  it('gives a hosted agent the same rule the app would', () => {
    const hc = hostedContext(resolveAgentContext({ recipeTenant: tenant, via: () => ['client_id'] }), null);
    const { ctx } = hostedAgentContext(hc);
    expect(ctx.tenant?.via).toEqual(['client_id']);
    const file = parseHostedFile({ version: 1, connections: [{ id: 'a', name: 'shop', env: 'staging', engine: 'postgres', host: 'db', credential: { source: 'none' }, context: hc }] });
    expect(file.contexts.a).toEqual(hc);
  });
});

describe('where the server reaches it', () => {
  it('publishes a database on this machine under the address the server uses', () => {
    const local = conn({ host: 'localhost', port: 3306, engine: 'mysql' });
    expect(toHosted(local).ok).toBe(false);
    const res = toHosted(local, { host: 'host.docker.internal' });
    expect(res.ok && res.value).toMatchObject({ host: 'host.docker.internal', port: 3306 });
  });

  it('still refuses an address that is this machine, and says what to use from Docker', () => {
    const res = toHosted(conn({}), { host: '127.0.0.1' });
    expect(!res.ok && res.error).toContain('host.docker.internal');
  });

  it('takes a tunnelled connection once the server has a direct address', () => {
    const tunnelled = conn({ tunnel: { target: 'bastion' } } as Partial<Connection>);
    expect(toHosted(tunnelled).ok).toBe(false);
    expect(toHosted(tunnelled, { host: 'shop.cluster-x.rds.amazonaws.com' }).ok).toBe(true);
  });
});
