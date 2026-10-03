import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ForeignKeyInfo, SchemaSnapshot, TableInfo } from './types';
import { buildRecipe, findLinks, sortTables, tableKey, type TableStat } from './baseline';
import { buildPlan } from './baselineBuild';

const col = (name: string, typeName = 'varchar(32)'): ColumnInfo => ({ name, ordinal: 0, typeName, nullable: true, defaultExpr: null });
const fk = (column: string, refTable: string, refColumn: string, refSchema: string | null = null): ForeignKeyInfo => ({
  name: `fk_${column}`, columns: [column], refSchema, refTable, refColumns: [refColumn],
});
function table(name: string, pk: string, cols: string[], fks: ForeignKeyInfo[] = []): TableInfo {
  return { name, kind: 'table', columns: cols.map((c) => col(c)), primaryKey: [pk], indexes: [], foreignKeys: fks };
}

const snapshot: SchemaSnapshot = {
  engine: 'mysql',
  serverVersion: '9.2.0',
  capturedAt: '',
  schemas: [
    {
      name: 'app',
      tables: [
        table('account', 'account_id', ['account_id', 'name']),
        table('user', 'user_id', ['user_id', 'email', 'password', 'account_id'], [fk('account_id', 'account', 'account_id')]),
        table('portal_user', 'portal_user_id', ['portal_user_id', 'email', 'password']),
        table('partner', 'partner_id', ['partner_id', 'account_id']),
        table('deal', 'deal_id', ['deal_id', 'partner_id', 'owner_ref'], [fk('owner_ref', 'owner', 'owner_id')]),
        table('owner', 'owner_id', ['owner_id', 'label']),
        table('country', 'id', ['id', 'code']),
        table('audit_log', 'id', ['id', 'account_id']),
        table('orders_bak', 'id', ['id']),
      ],
    },
    { name: 'mart', tables: [table('account', 'account_id', ['account_id', 'name']), table('stats', 'id', ['id', 'account_id'])] },
  ],
};

const stats: TableStat[] = [
  ['app', 'account', 200], ['app', 'user', 9000], ['app', 'portal_user', 9000], ['app', 'partner', 60000],
  ['app', 'deal', 900000], ['app', 'owner', 80000], ['app', 'country', 250], ['app', 'audit_log', 70000],
  ['app', 'orders_bak', 10], ['mart', 'account', 200], ['mart', 'stats', 500000],
].map(([schema, table, rows]) => ({ schema, table, rows, bytes: (rows as number) * 300 }) as TableStat);

const links = findLinks(snapshot);
const tenant = { schema: 'app', table: 'account', column: 'account_id' };
const starts = [
  { ref: { schema: 'app', table: 'account' }, column: 'account_id', values: ['acc-1'], label: 'Globex' },
  { ref: { schema: 'app', table: 'portal_user' }, column: 'portal_user_id', values: ['pu-9'], label: 'you@example.com' },
];
const plans = sortTables({ snapshot, stats, links, tenant, starts: [{ schema: 'app', table: 'portal_user' }], keepShare: 0.005 });
const recipe = buildRecipe({ engine: 'mysql', schemas: ['app', 'mart'], tenant, starts, linksOff: [], plans, overrides: {} });
const plan = buildPlan(recipe, plans, snapshot);
const rule = (k: string) => plan.tables.find((t) => tableKey(t.ref) === k);

describe('buildPlan', () => {
  it('starts the tenant and its namesakes from the tenant’s keys, and other starting points from theirs', () => {
    expect(rule('app.account')?.rows).toEqual({ kind: 'keys', column: 'account_id', values: ['acc-1'] });
    expect(rule('mart.account')?.rows).toEqual({ kind: 'keys', column: 'account_id', values: ['acc-1'] });
    expect(rule('app.portal_user')?.rows).toEqual({ kind: 'keys', column: 'portal_user_id', values: ['pu-9'] });
  });

  it('copies every other scoped table by following its parent, parents first', () => {
    expect(rule('app.deal')).toMatchObject({
      rows: { kind: 'follows', column: 'partner_id', parent: { schema: 'app', table: 'partner' }, refColumn: 'partner_id' },
      layer: 2,
    });
    const order = plan.tables.map((t) => tableKey(t.ref));
    expect(order.indexOf('app.partner')).toBeLessThan(order.indexOf('app.deal'));
    expect(order.indexOf('app.account')).toBeLessThan(order.indexOf('app.partner'));
  });

  it('copies small tables whole, creates logs empty, and leaves backups out', () => {
    expect(rule('app.country')?.rows).toEqual({ kind: 'all' });
    expect(rule('app.audit_log')?.rows).toEqual({ kind: 'none' });
    expect(rule('app.orders_bak')).toBeUndefined();
  });

  it('completes real foreign keys into tables that take rows by rule', () => {
    // deal.owner_ref → owner is a real key; owner is large and tied to
    // nothing, so only the owners the copied deals point at are fetched.
    expect(rule('app.owner')?.action).toBe('review');
    expect(plan.fills).toContainEqual({
      child: { schema: 'app', table: 'deal' }, column: 'owner_ref', parent: { schema: 'app', table: 'owner' }, refColumn: 'owner_id',
    });
    // user.account_id → account is scoped already, and filled the same way.
    expect(plan.fills.some((f) => f.parent.table === 'audit_log')).toBe(false);
  });

  it('warns when a table is set to keep scoped rows but nothing ties it to a starting point', () => {
    const forced = sortTables({
      snapshot, stats, links, tenant, starts: [], keepShare: 0.005, overrides: { 'app.country': 'scoped' },
    });
    const p = buildPlan({ ...recipe, overrides: { 'app.country': 'scoped' } }, forced, snapshot);
    expect(p.tables.find((t) => t.ref.table === 'country')?.rows).toEqual({ kind: 'none' });
    expect(p.warnings[0]).toMatch(/app\.country/);
  });

  it('lists the schemas it creates', () => {
    expect(plan.schemas).toEqual(['app', 'mart']);
  });
});

describe('narrowing a level', () => {
  it('keeps the chosen partners’ rows, and the tenant’s own rows that belong to no partner', () => {
    const narrowed = {
      ...recipe,
      starts: [...recipe.starts, { ref: { schema: 'app', table: 'partner' }, column: 'partner_id', values: ['p-1'], label: 'Globex', narrows: true }],
    };
    const withLead: SchemaSnapshot = {
      ...snapshot,
      schemas: snapshot.schemas.map((s) =>
        s.name !== 'app' ? s : { ...s, tables: [...s.tables, table('lead', 'id', ['id', 'account_id', 'partner_id'])] },
      ),
    };
    const ps = sortTables({
      snapshot: withLead, stats, links: findLinks(withLead), tenant, starts: [{ schema: 'app', table: 'portal_user' }],
      narrow: [{ schema: 'app', table: 'partner', column: 'partner_id' }], keepShare: 0.005,
    });
    const p = buildPlan(narrowed, ps, withLead);
    expect(p.tables.find((t) => t.ref.table === 'partner')?.rows).toEqual({ kind: 'keys', column: 'partner_id', values: ['p-1'] });
    expect(p.tables.find((t) => t.ref.table === 'lead')?.rows).toEqual({
      kind: 'follows', column: 'partner_id', parent: { schema: 'app', table: 'partner' }, refColumn: 'partner_id',
      orUnassigned: { column: 'account_id', parent: { schema: 'app', table: 'account' }, refColumn: 'account_id' },
    });
    // deal reaches the tenant only through partner: nothing to add.
    expect(p.tables.find((t) => t.ref.table === 'deal')?.rows).not.toHaveProperty('orUnassigned');
  });
});

describe('a login table', () => {
  it('keeps its login rows and every row the tenant keeps anyway', () => {
    const withUser = { ...recipe, starts: [...recipe.starts, { ref: { schema: 'app', table: 'user' }, column: 'user_id', values: ['u-1'], label: 'admin' }] };
    const ps = sortTables({
      snapshot, stats, links, tenant, starts: [{ schema: 'app', table: 'portal_user' }, { schema: 'app', table: 'user' }], keepShare: 0.005,
    });
    const p = buildPlan(withUser, ps, snapshot);
    expect(p.tables.find((t) => t.ref.table === 'user')?.rows).toEqual({
      kind: 'keys', column: 'user_id', values: ['u-1'],
      also: { column: 'account_id', parent: { schema: 'app', table: 'account' }, refColumn: 'account_id' },
    });
    // A login table with no tie to the tenant keeps just the login.
    expect(p.tables.find((t) => t.ref.table === 'portal_user')?.rows).toEqual({ kind: 'keys', column: 'portal_user_id', values: ['pu-9'] });
  });
});
