import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ForeignKeyInfo, SchemaSnapshot, TableInfo } from './types';
import {
  buildRecipe,
  findLinks,
  findSql,
  formatBytes,
  linkKey,
  loginTables,
  looksLikeBackup,
  looksLikeLog,
  nameColumns,
  nameTokens,
  parseRecipe,
  keyOf,
  referenceBase,
  sortTables,
  summarize,
  tableKey,
  tenantCandidates,
  tenantTables,
  tenancyLevels,
  onlySchemas,
  roleColumns,
  type TableStat,
} from './baseline';

// A small multi-schema catalog shaped like the systems this is for: a
// tenant (`account`) most tables carry a key to, real foreign keys on only
// a few of them, a second users table, a cross-schema reference, and the
// backups, logs and lookups a decade of production leaves behind.

const col = (name: string, typeName = 'int', ordinal = 0): ColumnInfo => ({
  name, ordinal, typeName, nullable: true, defaultExpr: null,
});

function table(name: string, pk: string | null, cols: Array<[string, string?]>, fks: ForeignKeyInfo[] = []): TableInfo {
  return {
    name,
    kind: 'table',
    columns: cols.map(([n, t], i) => col(n, t ?? 'int', i)),
    primaryKey: pk ? [pk] : [],
    indexes: [],
    foreignKeys: fks,
  };
}

const fk = (columns: string[], refTable: string, refColumns: string[], refSchema: string | null = null): ForeignKeyInfo => ({
  name: `fk_${columns.join('_')}`, columns, refSchema, refTable, refColumns,
});

const snapshot: SchemaSnapshot = {
  engine: 'mysql',
  serverVersion: '9.2.0',
  capturedAt: '',
  schemas: [
    {
      name: 'app',
      tables: [
        table('account', 'account_id', [['account_id', 'varchar(32)'], ['account_name', 'varchar(255)'], ['active', 'tinyint(1)']]),
        table('user', 'user_id', [['user_id', 'varchar(32)'], ['email', 'varchar(255)'], ['username', 'varchar(64)'], ['password', 'varchar(60)'], ['account_id', 'varchar(32)']], [
          fk(['account_id'], 'account', ['account_id']),
        ]),
        table('portal_user', 'portal_user_id', [['portal_user_id', 'varchar(32)'], ['email', 'varchar(255)'], ['password', 'varchar(60)'], ['roles_mask', 'int']]),
        table('notification', 'id', [['id', 'bigint'], ['email', 'varchar(255)'], ['account_id', 'varchar(32)']]),
        table('partner', 'partner_id', [['partner_id', 'varchar(32)'], ['account_id', 'varchar(32)'], ['name', 'varchar(100)']]),
        table('deal', 'deal_id', [
          ['deal_id', 'varchar(32)'], ['partner_id', 'varchar(32)'], ['created_by_user_id', 'varchar(32)'], ['amount', 'decimal(10,2)'],
        ]),
        table('country', 'id', [['id', 'int'], ['code', 'char(2)'], ['updated_by_user_id', 'varchar(32)']]),
        table('plan', 'id', [['id', 'int'], ['name', 'varchar(50)']]),
        table('audit_log', 'id', [['id', 'bigint'], ['account_id', 'varchar(32)'], ['message', 'text']]),
        table('feed_track', 'id', [['id', 'bigint'], ['partner_id', 'varchar(32)']]),
        table('partner_backup_25753', 'partner_id', [['partner_id', 'varchar(32)'], ['account_id', 'varchar(32)']]),
        table('field_definition_ojdupebak', 'id', [['id', 'int']]),
        table('email_template', 'id', [['id', 'int'], ['account_id', 'varchar(32)'], ['body', 'text']]),
        table('short_link', 'id', [['id', 'bigint'], ['url', 'text']]),
        table('unused_feature', 'id', [['id', 'int']]),
        table('event_counter', 'id', [['id', 'int'], ['account_id', 'int']]),
      ],
    },
    {
      name: 'billing',
      tables: [
        table('invoice', 'invoice_id', [['invoice_id', 'bigint'], ['account_id', 'varchar(32)'], ['plan_id', 'int']]),
        table('invoice_line', 'id', [['id', 'bigint'], ['invoice_id', 'bigint']], [fk(['invoice_id'], 'invoice', ['invoice_id'])]),
      ],
    },
    {
      // A reporting schema with its own copy of the tenant, and a table
      // that shares the tenant's key name but means something else.
      name: 'mart',
      tables: [
        table('account', 'account_id', [['account_id', 'varchar(32)'], ['account_name', 'varchar(255)']]),
        table('daily_stats', 'id', [['id', 'bigint'], ['account_id', 'varchar(32)'], ['clicks', 'int']]),
        table('oauth_account', 'account_id', [['account_id', 'varchar(32)'], ['secret', 'varchar(64)']]),
      ],
    },
  ],
};

const stats: TableStat[] = [
  ['app', 'account', 232, 1e6],
  ['app', 'user', 85_000, 6e7],
  ['app', 'portal_user', 19_000, 9e7],
  ['app', 'partner', 66_000, 4e7],
  ['app', 'deal', 1_200_000, 4e8],
  ['app', 'country', 250, 6e4],
  ['app', 'plan', 12, 1e4],
  ['app', 'audit_log', 72_000, 4e7],
  ['app', 'feed_track', 700_000, 3e8],
  ['app', 'partner_backup_25753', 5, 1e4],
  ['app', 'field_definition_ojdupebak', 514_000, 4e8],
  ['app', 'email_template', 8_000, 2e8],
  ['app', 'short_link', 859_000, 7e8],
  ['app', 'unused_feature', 0, 1.6e4],
  ['app', 'event_counter', 10, 1e4],
  ['billing', 'invoice', 30_000, 1e7],
  ['billing', 'invoice_line', 90_000, 2e7],
  ['mart', 'account', 232, 1e5],
  ['mart', 'daily_stats', 2_000_000, 9e8],
  ['mart', 'oauth_account', 40, 1e4],
].map(([schema, table, rows, bytes]) => ({ schema, table, rows, bytes }) as TableStat);

const links = findLinks(snapshot);
const linkFrom = (t: string, c: string) => links.find((l) => l.from.table === t && l.columns[0] === c);

describe('nameTokens', () => {
  it('splits snake and camel case alike', () => {
    expect(nameTokens('created_by_user_id')).toEqual(['created', 'by', 'user', 'id']);
    expect(nameTokens('createdByUserId')).toEqual(['created', 'by', 'user', 'id']);
  });
});

describe('findLinks', () => {
  it('keeps the foreign keys the server holds', () => {
    expect(linkFrom('user', 'account_id')).toMatchObject({ source: 'fk', to: { schema: 'app', table: 'account' } });
    expect(linkFrom('invoice_line', 'invoice_id')).toMatchObject({ source: 'fk', to: { schema: 'billing', table: 'invoice' } });
  });

  it('reads a column named like a table’s own key as a link to it', () => {
    expect(linkFrom('partner', 'account_id')).toMatchObject({
      source: 'name', to: { schema: 'app', table: 'account' }, refColumns: ['account_id'],
    });
  });

  it('crosses schemas when the same schema has no match', () => {
    expect(linkFrom('invoice', 'account_id')).toMatchObject({ to: { schema: 'app', table: 'account' } });
    expect(linkFrom('invoice', 'plan_id')).toMatchObject({ to: { schema: 'app', table: 'plan' }, refColumns: ['id'] });
  });

  it('finds the table in the tail of a longer name, and marks who-touched-it columns as audit', () => {
    expect(linkFrom('deal', 'created_by_user_id')).toMatchObject({ to: { table: 'user' }, audit: true });
    expect(linkFrom('deal', 'partner_id')).toMatchObject({ to: { table: 'partner' }, audit: false });
  });

  it('prefers the table named for the column over others sharing its key name', () => {
    const snap: SchemaSnapshot = {
      ...snapshot,
      schemas: [
        { name: 'core', tables: [
          table('oauth_client', 'client_id', [['client_id', 'varchar(32)']]),
          table('client', 'client_id', [['client_id', 'varchar(32)']]),
          table('z_client', 'client_id', [['client_id', 'varchar(32)']]),
        ] },
        { name: 'cms', tables: [table('page', 'id', [['id', 'int'], ['client_id', 'varchar(32)']])] },
        { name: 'mart', tables: [
          table('client', 'client_id', [['client_id', 'varchar(32)']]),
          table('stats', 'id', [['id', 'int'], ['client_id', 'varchar(32)']]),
        ] },
      ],
    };
    const found = findLinks(snap);
    const from = (s: string, t: string) => found.find((l) => l.from.schema === s && l.from.table === t);
    // Two tables named `client` in other schemas: a real choice, offered.
    expect(from('cms', 'page')).toMatchObject({ to: { schema: 'core', table: 'client' } });
    expect(from('cms', 'page')!.alternatives.map(tableKey)).toEqual(['mart.client']);
    // One in its own schema: settled.
    expect(from('mart', 'stats')).toMatchObject({ to: { schema: 'mart', table: 'client' }, alternatives: [] });
  });

  it('reads a key named for the end of its own table’s name as that table’s own', () => {
    const snap: SchemaSnapshot = {
      ...snapshot,
      schemas: [{ name: 'app', tables: [
        table('form', 'form_id', [['form_id', 'varchar(32)']]),
        table('content_form', 'form_id', [['form_id', 'varchar(32)'], ['title', 'varchar(99)']]),
        table('partner', 'partner_id', [['partner_id', 'varchar(32)']]),
        table('partner_defaults', 'partner_id', [['partner_id', 'varchar(32)']]),
      ] }],
    };
    const found = findLinks(snap);
    expect(found.some((l) => l.from.table === 'content_form')).toBe(false);
    // An extension table keyed by another table's key still links.
    expect(found.find((l) => l.from.table === 'partner_defaults')).toMatchObject({ to: { table: 'partner' } });
  });

  it('never guesses a backup as the table a column means', () => {
    // partner_backup_25753 shares partner's key, and feed_track points at
    // partner by name.
    expect(linkFrom('feed_track', 'partner_id')).toMatchObject({ to: { table: 'partner' }, alternatives: [] });
    expect(links.some((l) => l.source === 'name' && l.to.table === 'partner_backup_25753')).toBe(false);
  });

  it('does not guess between siblings that share a key when no table is named for it', () => {
    const snap: SchemaSnapshot = {
      ...snapshot,
      schemas: [{ name: 'dm', tables: [
        table('event_log', 'event_id', [['event_id', 'bigint']]),
        table('event_lead', 'event_id', [['event_id', 'bigint']]),
        table('search_terms', 'id', [['id', 'int'], ['event_id', 'bigint']]),
      ] }],
    };
    expect(findLinks(snap).filter((l) => l.from.table === 'search_terms')).toEqual([]);
  });

  it('refuses a link whose types cannot match', () => {
    // event_counter.account_id is an int; account's key is a varchar.
    expect(linkFrom('event_counter', 'account_id')).toBeUndefined();
  });

  it('never links a table to itself by its own key', () => {
    expect(links.some((l) => l.from.table === 'partner' && l.to.table === 'partner')).toBe(false);
  });

  it('gives each link a stable key', () => {
    expect(linkKey(linkFrom('partner', 'account_id')!)).toBe('app.partner(account_id)→app.account(account_id)');
  });
});

describe('tenantCandidates', () => {
  it('puts the table most others point at first', () => {
    const [top, next] = tenantCandidates(snapshot, links);
    expect(tableKey(top.ref)).toBe('app.account');
    expect(top.column).toBe('account_id');
    expect(top.tables).toBeGreaterThan(next.tables);
  });

  it('does not count audit links towards a tenant', () => {
    const user = tenantCandidates(snapshot, links).find((c) => c.ref.table === 'user');
    expect(user).toBeUndefined();
  });
});

describe('looksLikeBackup / looksLikeLog', () => {
  it.each(['orders_bak', 'field_definition_ojdupebak', 'content_temp3', 'partner_backup_25753', 'orders_20220322', 'tmp_import', 'content_old_20220322_2'])(
    '%s is a backup',
    (name) => expect(looksLikeBackup(name)).toBe(true),
  );
  it.each(['email_template', 'temperature', 'content_template', 'bakery', 'order'])('%s is not', (name) =>
    expect(looksLikeBackup(name)).toBe(false),
  );
  it('knows logs by their names', () => {
    expect(looksLikeLog('audit_log')).toBe(true);
    expect(looksLikeLog('feed_track')).toBe(true);
    expect(looksLikeLog('order_history')).toBe(true);
    expect(looksLikeLog('catalog')).toBe(false);
  });
});

describe('sortTables', () => {
  const plans = sortTables({
    snapshot,
    stats,
    links,
    tenant: { schema: 'app', table: 'account', column: 'account_id' },
    starts: [{ schema: 'app', table: 'portal_user' }],
    keepShare: 2 / 232,
  });
  const action = (t: string) => plans.find((p) => p.ref.table === t)?.action;

  it('scopes the tenant, the starting points, and everything that points at them', () => {
    expect(action('account')).toBe('scoped');
    expect(action('portal_user')).toBe('scoped');
    expect(action('user')).toBe('scoped');
    expect(action('partner')).toBe('scoped');
    expect(action('deal')).toBe('scoped');
    expect(action('invoice')).toBe('scoped');
    expect(action('invoice_line')).toBe('scoped');
    expect(action('email_template')).toBe('scoped');
  });

  it('scopes the tenant’s namesake in another schema, and what points at it', () => {
    expect(tenantTables(snapshot, { schema: 'app', table: 'account', column: 'account_id' }).map(tableKey)).toEqual([
      'app.account', 'mart.account',
    ]);
    expect(action('daily_stats')).toBe('scoped');
  });

  it('does not read a table’s own key as a link, even when it shares the tenant’s key name', () => {
    // oauth_account.account_id is the OAuth account's own id — the shape of
    // the real oauth_client.client_id — not a pointer at the tenant.
    expect(linkFrom('oauth_account', 'account_id')).toBeUndefined();
    expect(action('oauth_account')).toBe('whole');
  });

  it('copies small unlinked tables whole, even when an audit column points at a user', () => {
    expect(action('country')).toBe('whole');
    expect(action('plan')).toBe('whole');
  });

  it('empties logs and leaves backups out, before scope is considered', () => {
    expect(action('audit_log')).toBe('empty');
    expect(action('feed_track')).toBe('empty');
    expect(action('partner_backup_25753')).toBe('skip');
    expect(action('field_definition_ojdupebak')).toBe('skip');
  });

  it('keeps empty tables as schema only, and flags large unlinked ones for review', () => {
    expect(action('unused_feature')).toBe('schema');
    expect(action('short_link')).toBe('review');
  });

  it('says why', () => {
    expect(plans.find((p) => p.ref.table === 'partner')?.reason).toBe('has account_id');
    expect(plans.find((p) => p.ref.table === 'deal')).toMatchObject({
      reason: 'through partner',
      via: [
        { column: 'partner_id', schema: 'app', table: 'partner', refColumn: 'partner_id' },
        { column: 'account_id', schema: 'app', table: 'account', refColumn: 'account_id' },
      ],
    });
    expect(plans.find((p) => p.ref.table === 'account')).toMatchObject({ reason: 'what you start from', via: [] });
  });

  it('stops scoping through a link a person turned off', () => {
    const off = new Set([linkKey(linkFrom('invoice', 'account_id')!)]);
    const again = sortTables({
      snapshot, stats, links, linksOff: off,
      tenant: { schema: 'app', table: 'account', column: 'account_id' }, starts: [], keepShare: 0.01,
    });
    expect(again.find((p) => p.ref.table === 'invoice')?.action).toBe('review');
    expect(again.find((p) => p.ref.table === 'invoice_line')?.action).toBe('review');
  });

  it('keeps a person’s choice over every rule', () => {
    const again = sortTables({
      snapshot, stats, links, tenant: null, starts: [], keepShare: 0, overrides: { 'app.audit_log': 'whole' },
    });
    expect(again.find((p) => p.ref.table === 'audit_log')).toMatchObject({ action: 'whole', reason: 'chosen by you' });
  });

  it('estimates what the baseline keeps', () => {
    const { bytes, keepBytes, groups } = summarize(plans);
    expect(keepBytes).toBeLessThan(bytes / 20);
    expect(groups.find((g) => g.action === 'skip')?.tables).toBe(2);
  });
});

describe('finding starting points', () => {
  it('searches the tenant by its name-like columns', () => {
    const account = snapshot.schemas[0].tables[0];
    expect(nameColumns(account)).toEqual(['account_name']);
  });

  it('prefers a row’s own name over other name-like columns', () => {
    expect(nameColumns(table('partner', 'partner_id', [['partner_id', 'varchar(32)'], ['contact_name', 'varchar(99)'], ['name', 'varchar(99)']]))).toEqual(['name']);
  });

  it('finds every table a login could live in, not just the users table — and not every table with an email', () => {
    expect(loginTables(snapshot).map((t) => [t.table, t.columns])).toEqual([
      ['user', ['email', 'username']],
      ['portal_user', ['email']],
    ]);
  });

  it('builds a bounded search with every value bound', () => {
    expect(
      findSql('mysql', {
        schema: 'app', table: 'account', select: ['account_id', 'account_name'], match: ['account_name'],
        mode: 'contains', term: '50%_off', limit: 10,
      }),
    ).toEqual({
      sql: 'SELECT `account_id`, `account_name` FROM `app`.`account` WHERE LOWER(`account_name`) LIKE LOWER(?)'
        + ' ORDER BY CASE WHEN LOWER(`account_name`) LIKE LOWER(?) THEN 0 WHEN LOWER(`account_name`) LIKE LOWER(?) THEN 1 ELSE 2 END LIMIT 10',
      // Contains, then exactly that, then starting with it.
      params: ['%50\\%\\_off%', '50\\%\\_off', '50\\%\\_off%'],
    });
    expect(
      findSql('postgres', {
        schema: 'app', table: 'user', select: ['user_id'], match: ['email', 'login'], mode: 'exact', term: 'a@b.c', limit: 500,
      }),
    ).toEqual({
      sql: 'SELECT "user_id" FROM "app"."user" WHERE LOWER("email"::text) = LOWER($1) OR LOWER("login"::text) = LOWER($2) LIMIT 50',
      params: ['a@b.c', 'a@b.c'],
    });
  });
});

describe('recipe', () => {
  it('round-trips through JSON', () => {
    const plans = sortTables({ snapshot, stats, links, tenant: null, starts: [], keepShare: 0 });
    const recipe = buildRecipe({
      engine: 'mysql', schemas: ['billing', 'app'], tenant: null, starts: [], linksOff: [], plans, overrides: {},
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(recipe.schemas).toEqual(['app', 'billing']);
    expect(parseRecipe(JSON.stringify(recipe))).toEqual(recipe);
  });

  it('refuses one it cannot read', () => {
    expect(parseRecipe('{')).toEqual({ error: 'The recipe is not valid JSON.' });
    expect(parseRecipe('{"version":2}')).toHaveProperty('error');
    expect(parseRecipe('{"version":1,"schemas":[],"tables":{"a.b":"drop"}}')).toHaveProperty('error');
  });
});

describe('formatBytes', () => {
  it('reads like a person would say it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
  });
});

describe('tenancy levels', () => {
  // partner points at account and most of the catalog points at partner;
  // user points at account too, but it keeps logins, so it is people.
  const tenant = { schema: 'app', table: 'account', column: 'account_id' };

  it('finds the level below the tenant, and leaves login tables out', () => {
    const levels = tenancyLevels(snapshot, links, tenant);
    expect(levels.map((l) => tableKey(l.ref))).toEqual(['app.partner']);
    expect(levels[0]).toMatchObject({ column: 'partner_id', parent: { table: 'account' }, parentColumn: 'account_id' });
  });

  it('scopes what carries the narrowed level’s key to the chosen rows, whatever else it carries', () => {
    const both: SchemaSnapshot = {
      ...snapshot,
      schemas: snapshot.schemas.map((s) =>
        s.name !== 'app' ? s : { ...s, tables: [...s.tables, table('lead', 'id', [['id', 'int'], ['account_id', 'varchar(32)'], ['partner_id', 'varchar(32)']])] },
      ),
    };
    const l = findLinks(both);
    const plans = sortTables({
      snapshot: both, stats, links: l, tenant, starts: [],
      narrow: [{ schema: 'app', table: 'partner', column: 'partner_id' }], keepShare: 0.01,
    });
    const via = (t: string) => plans.find((p) => p.ref.table === t)?.via.map((v) => v.table);
    expect(via('lead')).toEqual(['partner']);
    expect(via('deal')).toEqual(['partner']);
    // Client-level data is still the tenant's.
    expect(via('email_template')).toEqual(['account']);
  });

  it('searches a level within the chosen parent', () => {
    expect(
      findSql('mysql', {
        schema: 'app', table: 'partner', select: ['partner_id', 'name'], match: ['name'], mode: 'contains', term: 'acme',
        limit: 10, within: { column: 'account_id', values: ['a1', 'a2'] },
      }),
    ).toEqual({
      sql: 'SELECT `partner_id`, `name` FROM `app`.`partner` WHERE (LOWER(`name`) LIKE LOWER(?)) AND `account_id` IN (?, ?)'
        + ' ORDER BY CASE WHEN LOWER(`name`) LIKE LOWER(?) THEN 0 WHEN LOWER(`name`) LIKE LOWER(?) THEN 1 ELSE 2 END LIMIT 10',
      params: ['%acme%', 'a1', 'a2', 'acme', 'acme%'],
    });
  });
});

describe('choosing schemas', () => {
  it('leaves the others out of the sort altogether', () => {
    const plans = sortTables({ snapshot: onlySchemas(snapshot, ['app']), stats, links, tenant: null, starts: [], keepShare: 0 });
    expect(plans.some((p) => p.ref.schema !== 'app')).toBe(false);
  });
});

describe('roleColumns', () => {
  it('finds role-like columns and links to a roles table', () => {
    const t = table('member', 'id', [['id', 'int'], ['email', 'varchar(99)'], ['roles_mask', 'int'], ['is_admin', 'tinyint(1)'], ['role_id', 'int']]);
    const roles = table('roles', 'id', [['id', 'int'], ['name', 'varchar(40)']]);
    const s2: SchemaSnapshot = { ...snapshot, schemas: [{ name: 'app', tables: [t, roles] }] };
    const r = roleColumns(t, { schema: 'app', table: 'member' }, findLinks(s2));
    expect(r.direct).toEqual(['roles_mask', 'is_admin']);
    expect(r.viaLink).toEqual([{ column: 'role_id', to: { schema: 'app', table: 'roles' }, refColumn: 'id' }]);
  });
});

describe('a data mart with no declared keys', () => {
  const col = (name: string) => ({ name, ordinal: 1, typeName: 'character varying(32)', nullable: true, defaultExpr: null });
  const t = (name: string, cols: string[]) => ({ name, kind: 'table' as const, columns: cols.map(col), primaryKey: [], indexes: [], foreignKeys: [] });
  const snap = {
    engine: 'postgres' as const,
    serverVersion: 'PostgreSQL 8.0.2 Redshift 1.0',
    capturedAt: '',
    schemas: [{ name: 'public', tables: [t('client', ['client_id', 'name']), t('partners', ['partner_id', 'client_id']), t('deal', ['deal_id', 'client_id', 'partner_id'])] }],
  };

  it('reads each table’s own `…_id` column as its key, and links to it', async () => {
    const { findLinks, keyOf, tenantCandidates } = await import('./baseline');
    expect(keyOf(snap.schemas[0].tables[1])).toBe('partner_id');
    const links = findLinks(snap).map((l) => `${l.from.table}.${l.columns[0]}→${l.to.table}`).sort();
    expect(links).toEqual(['deal.client_id→client', 'deal.partner_id→partners', 'partners.client_id→client']);
    expect(tenantCandidates(snap, findLinks(snap))[0]).toMatchObject({ ref: { table: 'client' }, column: 'client_id' });
  });
});

describe('a client mirrored into several tables', () => {
  const col = (name: string) => ({ name, ordinal: 1, typeName: 'character varying(32)', nullable: true, defaultExpr: null });
  const t = (name: string, cols: string[]) => ({ name, kind: 'table' as const, columns: cols.map(col), primaryKey: [], indexes: [], foreignKeys: [] });
  const snap = {
    engine: 'postgres' as const,
    serverVersion: 'PostgreSQL 8.0.2 Redshift 1.0',
    capturedAt: '',
    schemas: [
      { name: 'public', tables: [t('client', ['client_id', 'name']), t('acme_db_client', ['client_id', 'client_name', 'client_key']), t('deal', ['deal_id', 'client_id'])] },
      { name: 'acme_dm', tables: [t('client', ['client_id', 'client_name'])] },
    ],
  };

  it('keys a mirrored table by the end of its name, and finds every namesake of the tenant', async () => {
    const { keyOf, tenantNamesakes } = await import('./baseline');
    expect(keyOf(snap.schemas[0].tables[1])).toBe('client_id');
    expect(tenantNamesakes(snap, { schema: 'public', table: 'client', column: 'client_id' }).map((x) => `${x.schema}.${x.table}`)).toEqual([
      'public.acme_db_client',
      'acme_dm.client',
    ]);
  });
});

describe('an empty table you start from', () => {
  it('is still the starting point, so what points at it keeps the tenant’s rows', () => {
    // A sandbox mart: the tenant table is empty, its rows live elsewhere.
    const empty = stats.map((s) => (s.schema === 'app' && s.table === 'account' ? { ...s, rows: 0 } : s));
    const plans = sortTables({ snapshot, stats: empty, links, tenant: { schema: 'app', table: 'account', column: 'account_id' }, starts: [], keepShare: 0.01 });
    const plan = (t: string) => plans.find((p) => p.ref.schema === 'app' && p.ref.table === t);
    expect(plan('account')).toMatchObject({ action: 'scoped', reason: 'what you start from' });
    expect(plan('partner')?.action).toBe('scoped');
    // Any other empty table is still set aside.
    expect(plan('unused_feature')).toMatchObject({ action: 'schema', reason: 'empty today' });
  });
});

describe('ids kept for another system', () => {
  it('are not read as links to a table here', () => {
    expect(referenceBase('remote_client_id')).toBeNull();
    expect(referenceBase('crm_account_id')).toBeNull();
    expect(referenceBase('external_user_id')).toBeNull();
    expect(referenceBase('client_id')).toEqual(['client']);
    expect(referenceBase('created_by_user_id')).toEqual(['created', 'by', 'user']);
  });
});

describe('a key read from a table’s name', () => {
  const keyless = (name: string, cols: string[]): TableInfo => ({
    name, kind: 'table', primaryKey: [], indexes: [], foreignKeys: [],
    columns: cols.map((c, i) => ({ name: c, ordinal: i + 1, typeName: 'varchar(32)', nullable: true, defaultExpr: null })),
  });
  it('takes the whole name, or a shorter ending only as the first column', () => {
    expect(keyOf(keyless('client', ['name', 'client_id']))).toBe('client_id');
    expect(keyOf(keyless('acme_db_client', ['client_id', 'name']))).toBe('client_id');
    expect(keyOf(keyless('deal_comment', ['deal_id', 'comment_id']))).toBe(null);
  });
});
