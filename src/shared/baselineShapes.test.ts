// The shapes multi-tenant databases come in, beyond the one overdb was
// first built against. Each fixture is a small, realistic catalog of one
// shape, and each test walks it the way a person would: find the tenant,
// sort the tables, and plan the build.

import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ForeignKeyInfo, SchemaInfo, SchemaSnapshot, TableInfo } from './types';
import {
  buildRecipe,
  findLinks,
  loginTables,
  polymorphicColumns,
  polymorphicLinks,
  polyTarget,
  referenceBase,
  schemaPerTenant,
  sortTables,
  tableKey,
  tenantCandidates,
  type Link,
  type TableStat,
} from './baseline';
import { buildPlan } from './baselineBuild';

type Col = [string, string?];

function table(name: string, pk: string[], cols: Col[], fks: ForeignKeyInfo[] = []): TableInfo {
  return {
    name,
    kind: 'table',
    columns: cols.map(([n, t], i): ColumnInfo => ({ name: n, ordinal: i, typeName: t ?? 'bigint', nullable: true, defaultExpr: null })),
    primaryKey: pk,
    indexes: [],
    foreignKeys: fks,
  };
}

const fk = (columns: string[], refTable: string, refColumns: string[]): ForeignKeyInfo => ({
  name: `fk_${columns.join('_')}`, columns, refSchema: null, refTable, refColumns,
});

const snap = (schemas: SchemaInfo[], engine: 'postgres' | 'mysql' = 'postgres'): SchemaSnapshot => ({
  engine, serverVersion: '16.2', capturedAt: '', schemas,
});

/// Rows per table: large enough that nothing is "small, copy it whole"
/// unless the test says so.
const statsFor = (s: SchemaSnapshot, small: string[] = []): TableStat[] =>
  s.schemas.flatMap((sc) =>
    sc.tables.map((t) => ({ schema: sc.name, table: t.name, rows: small.includes(t.name) ? 50 : 200_000, bytes: null })),
  );

describe('composite tenant keys (Citus style: every table keyed by tenant_id and id)', () => {
  const s = snap([
    {
      name: 'public',
      tables: [
        table('tenants', ['id'], [['id', 'uuid'], ['name', 'text']]),
        table('projects', ['tenant_id', 'id'], [['tenant_id', 'uuid'], ['id'], ['name', 'text']], [fk(['tenant_id'], 'tenants', ['id'])]),
        // No single-column key on tenant_id here — only the composite one.
        table('tasks', ['tenant_id', 'id'], [['tenant_id', 'uuid'], ['id'], ['project_id'], ['title', 'text']], [
          fk(['tenant_id', 'project_id'], 'projects', ['tenant_id', 'id']),
        ]),
        table('comments', ['tenant_id', 'id'], [['tenant_id', 'uuid'], ['id'], ['task_id'], ['body', 'text']], [
          fk(['tenant_id', 'task_id'], 'tasks', ['tenant_id', 'id']),
        ]),
        table('users', ['tenant_id', 'id'], [['tenant_id', 'uuid'], ['id'], ['email', 'text'], ['password_digest', 'text']]),
        table('countries', ['id'], [['id', 'int'], ['code', 'text']]),
      ],
    },
  ]);
  const links = findLinks(s);

  it('reads tenant_id inside a composite key as the tenant’s key, and finds the tenant', () => {
    const top = tenantCandidates(s, links)[0];
    expect(tableKey(top.ref)).toBe('public.tenants');
    expect(top.column).toBe('id');
    expect(top.tables).toBe(4);
  });

  it('scopes every tenant table directly by tenant_id', () => {
    const plans = sortTables({
      snapshot: s, stats: statsFor(s, ['countries']), links,
      tenant: { schema: 'public', table: 'tenants', column: 'id' }, starts: [], keepShare: 0.01,
    });
    for (const t of ['projects', 'tasks', 'comments', 'users']) {
      expect(plans.find((p) => p.ref.table === t)).toMatchObject({ action: 'scoped', via: [{ column: 'tenant_id', table: 'tenants' }] });
    }
    expect(plans.find((p) => p.ref.table === 'countries')?.action).toBe('whole');
  });

  it('plans a copy that selects by tenant_id, never by an id that repeats across tenants', () => {
    const tenant = { schema: 'public', table: 'tenants', column: 'id' };
    const starts = [{ ref: { schema: 'public', table: 'tenants' }, column: 'id', values: ['t-1'], label: 'Acme' }];
    const plans = sortTables({ snapshot: s, stats: statsFor(s), links, tenant, starts: [], keepShare: 0.01 });
    const plan = buildPlan(buildRecipe({ engine: 'postgres', schemas: ['public'], tenant, starts, linksOff: [], plans, overrides: {} }), plans, s);
    expect(plan.tables.find((t) => t.ref.table === 'comments')?.rows).toMatchObject({ kind: 'follows', column: 'tenant_id', refColumn: 'id' });
  });

  it('still finds the login table', () => {
    expect(loginTables(s).map((t) => t.table)).toEqual(['users']);
  });
});

describe('polymorphic links (Rails and Laravel: commentable_type + commentable_id)', () => {
  const s = snap(
    [
      {
        name: 'app',
        tables: [
          table('organizations', ['id'], [['id'], ['name', 'varchar(99)']]),
          table('projects', ['id'], [['id'], ['organization_id'], ['name', 'varchar(99)']]),
          table('posts', ['id'], [['id'], ['project_id'], ['title', 'varchar(99)']]),
          table('admin_notes', ['id'], [['id'], ['body', 'text']]),
          table('comments', ['id'], [['id'], ['commentable_type', 'varchar(255)'], ['commentable_id'], ['body', 'text']]),
          table('plans', ['id'], [['id'], ['name', 'varchar(99)']]),
        ],
      },
    ],
    'mysql',
  );

  it('finds the pair', () => {
    expect(polymorphicColumns(s)).toEqual([
      { from: { schema: 'app', table: 'comments' }, typeColumn: 'commentable_type', idColumn: 'commentable_id', kind: 'named' },
    ]);
  });

  it('turns class names into tables, namespaces and all', () => {
    const from = { schema: 'app', table: 'comments' };
    expect(polyTarget(s, from, 'Post')).toMatchObject({ table: 'posts', pk: 'id' });
    expect(polyTarget(s, from, 'App\\Models\\Project')).toMatchObject({ table: 'projects' });
    expect(polyTarget(s, from, 'Admin::Note')).toMatchObject({ table: 'admin_notes' });
    expect(polyTarget(s, from, 'Ghost')).toBeNull();
  });

  it('reads a *_type column of enum values as an enum, not a polymorphic pair', () => {
    const pair = polymorphicColumns(s)[0];
    // users exists as no table here, but USER would be read as one if it did.
    expect(polymorphicLinks(s, pair, ['USER', 'ADMIN', 'ORGANIZATIONS'])).toEqual([]);
    // Mostly names nothing: not a pair.
    expect(polymorphicLinks(s, pair, ['Post', 'Pending', 'Archived', 'Draft'])).toEqual([]);
  });

  const poly = polymorphicLinks(s, polymorphicColumns(s)[0], ['Post', 'Project', 'Admin::Note', 'Ghost']);
  const links: Link[] = [...findLinks(s), ...poly];
  const tenant = { schema: 'app', table: 'organizations', column: 'id' };

  it('makes one conditional link per type that names a table', () => {
    expect(poly.map((l) => [l.to.table, l.when?.value])).toEqual([['posts', 'Post'], ['projects', 'Project'], ['admin_notes', 'Admin::Note']]);
    expect(poly.every((l) => l.source === 'poly' && l.columns[0] === 'commentable_id')).toBe(true);
  });

  it('scopes the polymorphic table through the types that lead to the tenant', () => {
    const plans = sortTables({ snapshot: s, stats: statsFor(s, ['plans']), links, tenant, starts: [], keepShare: 0.01 });
    const comments = plans.find((p) => p.ref.table === 'comments')!;
    expect(comments.action).toBe('scoped');
    expect(comments.via[0]).toMatchObject({ column: 'commentable_id', when: { column: 'commentable_type', value: 'Project' } });
  });

  it('copies comments on every kept table, each by its own type', () => {
    const starts = [{ ref: tenant, column: 'id', values: ['1'], label: 'Acme' }];
    const plans = sortTables({ snapshot: s, stats: statsFor(s, ['plans']), links, tenant, starts: [], keepShare: 0.01 });
    const recipe = buildRecipe({ engine: 'mysql', schemas: ['app'], tenant, starts, linksOff: [], plans, overrides: {}, extraLinks: poly });
    const rule = buildPlan(recipe, plans, s).tables.find((t) => t.ref.table === 'comments')?.rows;
    expect(rule).toMatchObject({
      kind: 'follows', column: 'commentable_id', parent: { table: 'projects' }, when: { value: 'Project' },
      more: [{ parent: { table: 'posts' }, when: { value: 'Post' } }],
    });
    // admin_notes is tied to no tenant, so comments on it are not kept.
    expect(JSON.stringify(rule)).not.toContain('admin_notes');
  });

  it('completes polymorphic links type by type, like foreign keys', () => {
    const starts = [{ ref: tenant, column: 'id', values: ['1'], label: 'Acme' }];
    const plans = sortTables({ snapshot: s, stats: statsFor(s, ['plans']), links, tenant, starts: [], keepShare: 0.01 });
    const recipe = buildRecipe({ engine: 'mysql', schemas: ['app'], tenant, starts, linksOff: [], plans, overrides: {}, extraLinks: poly });
    const fills = buildPlan(recipe, plans, s).fills.filter((f) => f.when);
    // admin_notes is planned too; no comment on one is copied, so at build
    // time there is nothing missing to fetch.
    expect(fills.map((f) => [f.parent.table, f.when?.value])).toEqual([['posts', 'Post'], ['projects', 'Project'], ['admin_notes', 'Admin::Note']]);
  });

  it('keeps the links in the recipe, so a build does not read the data again', () => {
    const recipe = buildRecipe({ engine: 'mysql', schemas: ['app'], tenant, starts: [], linksOff: [], plans: [], overrides: {}, extraLinks: poly });
    expect(recipe.extraLinks).toHaveLength(3);
  });
});

describe('polymorphic links (Django: content_type_id + object_id)', () => {
  const s = snap([
    {
      name: 'public',
      tables: [
        table('django_content_type', ['id'], [['id', 'int'], ['app_label', 'varchar(100)'], ['model', 'varchar(100)']]),
        table('blog_post', ['id'], [['id'], ['title', 'varchar(99)']]),
        table('django_comments', ['id'], [['id'], ['content_type_id', 'int'], ['object_pk', 'text'], ['comment', 'text']]),
        table('tagging_taggeditem', ['id'], [['id'], ['tag_id'], ['content_type_id', 'int'], ['object_id']]),
      ],
    },
  ]);

  it('finds both spellings of the pair', () => {
    expect(polymorphicColumns(s).map((p) => [p.from.table, p.idColumn, p.kind])).toEqual([
      ['django_comments', 'object_pk', 'contenttype'],
      ['tagging_taggeditem', 'object_id', 'contenttype'],
    ]);
  });

  it('maps a content type to its table by app label and model', () => {
    const types = new Map([['7', { appLabel: 'blog', model: 'post' }]]);
    const poly = polymorphicLinks(s, polymorphicColumns(s)[0], ['7', '99'], types);
    expect(poly).toHaveLength(1);
    expect(poly[0]).toMatchObject({ to: { table: 'blog_post' }, when: { column: 'content_type_id', value: '7' } });
  });
});

describe('one schema per tenant', () => {
  const tenantSchema = (name: string): SchemaInfo => ({
    name,
    tables: ['users', 'projects', 'tasks', 'comments', 'files', 'settings'].map((t) => table(t, ['id'], [['id']])),
  });
  const s = snap([
    tenantSchema('acme'),
    tenantSchema('globex'),
    { ...tenantSchema('initech'), tables: [...tenantSchema('initech').tables, table('legacy_import', ['id'], [['id']])] },
    { name: 'public', tables: [table('tenants', ['id'], [['id'], ['schema_name', 'text']]), table('plans', ['id'], [['id']])] },
  ]);

  it('recognises schemas with the same tables as one per tenant', () => {
    expect(schemaPerTenant(s)).toEqual({ schemas: ['acme', 'globex', 'initech'], tables: 6 });
  });

  it('says nothing when schemas merely share a few names', () => {
    const services = snap([
      { name: 'billing', tables: ['invoices', 'lines', 'payments', 'refunds', 'settings'].map((t) => table(t, ['id'], [['id']])) },
      { name: 'crm', tables: ['contacts', 'deals', 'notes', 'tasks', 'settings'].map((t) => table(t, ['id'], [['id']])) },
      { name: 'auth', tables: ['users', 'sessions', 'roles', 'grants', 'settings'].map((t) => table(t, ['id'], [['id']])) },
    ]);
    expect(schemaPerTenant(services)).toBeNull();
  });
});

describe('other spellings of a key', () => {
  it('reads the key marker at either end', () => {
    expect(referenceBase('tenant_uuid')).toEqual(['tenant']);
    expect(referenceBase('client_ref')).toEqual(['client']);
    expect(referenceBase('fk_account')).toEqual(['account']);
    expect(referenceBase('id_cliente')).toEqual(['cliente']);
    expect(referenceBase('ClientId')).toEqual(['client']);
    expect(referenceBase('href')).toBeNull();
    expect(referenceBase('identity')).toBeNull();
  });

  const s = snap([
    {
      name: 'public',
      tables: [
        table('tenants', ['id'], [['id', 'uuid']]),
        table('clients', ['id'], [['id']]),
        table('accounts', ['id'], [['id']]),
        table('people', ['id'], [['id']]),
        table('Customers', ['Id'], [['Id', 'int']]),
        table('jobs', ['id'], [['id'], ['tenant_uuid', 'uuid'], ['client_ref'], ['fk_account'], ['person_id']]),
        table('Orders', ['Id'], [['Id', 'int'], ['CustomerId', 'int']]),
      ],
    },
  ]);
  const links = findLinks(s);
  const to = (t: string, c: string) => links.find((l) => l.from.table === t && l.columns[0] === c)?.to.table;

  it('links every spelling to its table', () => {
    expect(to('jobs', 'tenant_uuid')).toBe('tenants');
    expect(to('jobs', 'client_ref')).toBe('clients');
    expect(to('jobs', 'fk_account')).toBe('accounts');
    expect(to('jobs', 'person_id')).toBe('people');
    expect(to('Orders', 'CustomerId')).toBe('Customers');
  });
});
