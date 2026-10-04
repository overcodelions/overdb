import { describe, expect, it } from 'vitest';
import { linksFromMap } from './mapLinks';
import { emptyMap, type DbMap } from './dbMap';
import type { Link } from './baseline';
import type { SchemaSnapshot } from './types';

const col = (name: string) => ({ name, typeName: 'int', nullable: true }) as never;
const table = (name: string, columns: string[]) =>
  ({ name, kind: 'table', columns: columns.map(col), primaryKey: ['id'], foreignKeys: [], indexes: [] }) as never;

const snapshot = {
  engine: 'mysql',
  schemas: [
    { name: 'app', tables: [table('form', ['id']), table('submission', ['id', 'form_id', 'site_ref', 'created_by']), table('site', ['id']), table('old_form', ['id'])] },
    { name: 'cms', tables: [table('site', ['id'])] },
  ],
} as unknown as SchemaSnapshot;

const guess = (column: string, to: string, alternatives: string[] = []): Link => ({
  from: { schema: 'app', table: 'submission' },
  columns: [column],
  to: { schema: to.split('.')[0], table: to.split('.')[1] },
  refColumns: ['id'],
  source: 'name',
  audit: false,
  alternatives: alternatives.map((a) => ({ schema: a.split('.')[0], table: a.split('.')[1] })),
});

const mapWith = (links: DbMap['links']): DbMap => ({ ...emptyMap({ kind: 'connection', id: 'c', name: 'c' }), links });

describe('settling a base’s links from the map', () => {
  it('confirms a guess the code agrees with, in either order', () => {
    const r = linksFromMap(mapWith([{ from: 'app.form.id', to: 'app.submission.form_id', why: 'FormDao joins them', ref: 'src/FormDao.java:12' }]), snapshot, [guess('form_id', 'app.form', ['app.old_form'])]);
    expect(r.confirmed).toBe(1);
    expect(r.links[0].alternatives).toEqual([]);
    expect(r.links[0].cited?.ref).toBe('src/FormDao.java:12');
  });

  it('points a guess at the table the code uses', () => {
    const r = linksFromMap(mapWith([{ from: 'app.submission.site_ref', to: 'cms.site.id', why: 'site lookup' }]), snapshot, [guess('site_ref', 'app.site', ['cms.site'])]);
    expect(r.corrected).toBe(1);
    expect(r.links[0].to).toEqual({ schema: 'cms', table: 'site' });
    expect(r.links[0].source).toBe('code');
  });

  it('adds a link the names never suggested, but not through an audit column', () => {
    const r = linksFromMap(
      mapWith([
        { from: 'app.submission.site_ref', to: 'app.site.id', why: 'x' },
        { from: 'app.submission.created_by', to: 'app.form.id', why: 'y' },
      ]),
      snapshot,
      [],
    );
    expect(r.added).toBe(1);
    expect(r.links[0]).toMatchObject({ columns: ['site_ref'], to: { schema: 'app', table: 'site' }, source: 'code' });
  });

  it('takes no link between two columns neither of which is a key', () => {
    // Redshift: no declared keys, so each table's key is read off its name.
    const t = (name: string, columns: string[]) => ({ name, kind: 'table', columns: columns.map(col), primaryKey: [], foreignKeys: [], indexes: [] });
    const mart = {
      engine: 'postgres',
      schemas: [{ name: 'public', tables: [t('client', ['client_id']), t('partner', ['partner_id', 'client_id']), t('deal', ['deal_id', 'partner_id', 'client_id'])] }],
    } as unknown as SchemaSnapshot;
    const named = (column: string, to: string): Link => ({
      from: { schema: 'public', table: 'deal' }, columns: [column], to: { schema: 'public', table: to }, refColumns: [column], source: 'name', audit: false, alternatives: [],
    });
    const r = linksFromMap(
      mapWith([
        { from: 'public.deal.client_id', to: 'public.partner.client_id', why: 'joined on partner_id and client_id' },
        { from: 'public.deal.partner_id', to: 'public.partner.partner_id', why: 'joined on partner_id and client_id' },
      ]),
      mart,
      [named('client_id', 'client'), named('partner_id', 'partner')],
    );
    expect(r.links.find((l) => l.columns[0] === 'client_id')?.to.table).toBe('client');
    expect(r.links.find((l) => l.columns[0] === 'partner_id')?.cited).toBeDefined();
    expect(r.corrected).toBe(0);
  });

  it('leaves foreign keys and unknown columns alone', () => {
    const fk = { ...guess('form_id', 'app.form'), source: 'fk' as const };
    const r = linksFromMap(mapWith([{ from: 'app.submission.form_id', to: 'app.old_form.id', why: 'x' }, { from: 'app.nope.x', to: 'app.form.id', why: 'y' }]), snapshot, [fk]);
    expect(r.links).toEqual([fk]);
    expect(r.confirmed + r.corrected + r.added).toBe(0);
  });
});

describe('links a recipe keeps', () => {
  it('replaces the name guess for a column the code settled, and keeps everything else', async () => {
    const { withExtraLinks } = await import('./baseline');
    const wrong = guess('site_ref', 'app.site', ['cms.site']);
    const other = guess('form_id', 'app.form');
    const fixed: Link = { ...wrong, to: { schema: 'cms', table: 'site' }, source: 'code', alternatives: [], cited: { why: 'w' } };
    expect(withExtraLinks([wrong, other], [fixed])).toEqual([other, fixed]);
  });
});
