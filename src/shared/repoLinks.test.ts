import { describe, expect, it } from 'vitest';
import type { Connection, EnvSet } from './types';
import { repoLinkOwner } from './overcliHandoff';
import { appSchemas, recipeHome, repoLinks, reposFor, reposInOrder, reposNote, schemasMentioned, suggestSchemas, type RepoLink } from './repoLinks';

const conn = (id: string, extra: Partial<Connection> = {}): Connection =>
  ({ id, name: id, engine: 'mysql', env: 'local', host: '127.0.0.1', port: 3306, ...extra }) as Connection;

const set: EnvSet = {
  id: 'shop',
  name: 'shop',
  memberIds: ['local', 'prod'],
  baselineId: 'local',
  repoPaths: ['/code/orders-api', '/code/billing-svc', '/code/tools'],
  repoSchemas: { '/code/orders-api': ['orders', 'orders_audit'], '/code/billing-svc': ['billing'] },
  recipeRepo: '/code/billing-svc',
};
const connections = [conn('local'), conn('prod', { env: 'prod' }), conn('branch-1', { branchOf: 'local' }), conn('loose', { repoPaths: ['/code/x'] })];

describe('repo links', () => {
  it('lists each repo with the schemas its code uses, and the recipe’s home', () => {
    const owner = repoLinkOwner('local', connections, [set])!;
    expect(repoLinks(owner, connections, [set])).toEqual([
      { path: '/code/orders-api', schemas: ['orders', 'orders_audit'], home: false },
      { path: '/code/billing-svc', schemas: ['billing'], home: true },
      { path: '/code/tools', schemas: null, home: false },
    ]);
  });

  it('a branch uses the repos of the connection it was made from', () => {
    expect(repoLinkOwner('branch-1', connections, [set])).toEqual({ kind: 'envSet', id: 'shop', name: 'shop' });
    expect(repoLinkOwner('loose', connections, [set])).toEqual({ kind: 'connection', id: 'loose', name: 'loose' });
  });

  it('reads the repos for the schemas in play, then the unmapped ones', () => {
    const links = repoLinks(repoLinkOwner('local', connections, [set])!, connections, [set]);
    expect(reposFor(links, ['billing']).map((l) => l.path)).toEqual(['/code/billing-svc', '/code/tools']);
    expect(reposFor(links, ['ORDERS']).map((l) => l.path)).toEqual(['/code/orders-api', '/code/tools']);
    expect(reposFor(links, null)).toHaveLength(3);
  });

  it('reads every repo rather than none when nothing matches', () => {
    const mapped: RepoLink[] = [{ path: '/a', schemas: ['x'], home: true }];
    expect(reposFor(mapped, ['y']).map((l) => l.path)).toEqual(['/a']);
  });

  it('saves the recipe in the chosen repo, else the first', () => {
    expect(recipeHome([{ path: '/a', schemas: null, home: false }, { path: '/b', schemas: null, home: true }])).toBe('/b');
    expect(recipeHome([])).toBeNull();
  });

  it('tells the model which repo owns which schema', () => {
    const note = reposNote(
      [
        { path: '/code/orders-api', schemas: ['orders'], home: false },
        { path: '/code/tools', schemas: null, home: false },
      ],
      '/code/orders-api',
    );
    expect(note).toContain('/code/orders-api (the working directory): the code for schema orders');
    expect(note).toContain('/code/tools: schemas not mapped');
    expect(reposNote([{ path: '/only', schemas: null, home: true }], '/only')).toBe('');
  });
});

describe('suggesting schemas from a scan', () => {
  it('trusts config, wants several mentions in code, and counts the repo’s own name', () => {
    expect(
      suggestSchemas(
        {
          billing: { config: 1, code: 0 },
          orders: { config: 0, code: 2 },
          audit: { config: 0, code: 4 },
          app: { config: 0, code: 1 },
        },
        '/code/orders-svc',
      ),
    ).toEqual(['audit', 'orders', 'billing']);
  });

  it('leaves out schemas no app keeps data in', () => {
    expect(appSchemas(['mysql', 'sys', 'information_schema', 'performance_schema', 'orders', 'pg_catalog'])).toEqual(['orders']);
  });
});

describe('a seed reaching past its own schema', () => {
  it('reads every repo, the ones for its schemas first', () => {
    const links: RepoLink[] = [
      { path: '/code/core', schemas: ['acme'], home: true },
      { path: '/code/learning-svc', schemas: ['acme_learning'], home: false },
    ];
    expect(reposInOrder(links, ['acme_learning']).map((l) => l.path)).toEqual(['/code/learning-svc', '/code/core']);
    expect(reposInOrder(links, ['acme']).map((l) => l.path)).toEqual(['/code/core', '/code/learning-svc']);
  });

  it('finds schemas a ticket talks about by their own words, not the shared prefix', () => {
    const schemas = ['acme', 'acme_dm', 'acme_learning_management', 'acme_billing', 'acme_proc'];
    const ticket = 'Learners lose their progress in a module after the August release. Acme support says...';
    expect(schemasMentioned(ticket, schemas, ['acme'])).toEqual(['acme_learning_management']);
    expect(schemasMentioned('Invoices are billed twice', schemas)).toEqual(['acme_billing']);
    expect(schemasMentioned('the dm export', schemas)).toEqual([]);
    expect(schemasMentioned('learning', schemas, ['acme_learning_management'])).toEqual([]);
  });
});
