import { describe, expect, it } from 'vitest';
import type { SchemaSnapshot, TableInfo } from './types';
import {
  catalogLines,
  emptyMap,
  freshness,
  learnFrom,
  mapSlice,
  mergeInto,
  parseMapAnswer,
  schemaFingerprint,
  schemasFor,
  tablesFor,
  type DbMap,
} from './dbMap';

const col = (name: string, typeName = 'varchar') => ({ name, ordinal: 0, typeName, nullable: true, defaultExpr: null });
const table = (name: string, cols: string[]): TableInfo =>
  ({ name, kind: 'table', columns: cols.map((c) => col(c)), primaryKey: [cols[0]], indexes: [], foreignKeys: [] }) as unknown as TableInfo;

const snapshot = {
  engine: 'mysql',
  serverVersion: '8.4',
  capturedAt: '',
  schemas: [
    { name: 'shop', tables: [table('customer', ['id', 'status', 'tier']), table('orders', ['id', 'customer_id', 'state', 'meta'])] },
    { name: 'learning', tables: [table('course_progress', ['id', 'user_id', 'course_id', 'step', 'payload'])] },
  ],
} as unknown as SchemaSnapshot;

const answer = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';

describe('a mapping pass’s answer', () => {
  it('keeps what names real tables and columns, and counts what it invented', () => {
    const res = parseMapAnswer(
      answer({
        tables: [
          { table: 'shop.orders', purpose: 'An order', values: [{ column: 'state', values: ['OPEN', 'PAID'], ref: 'Order.java:12' }, { column: 'nope', values: ['x'] }], json: [{ column: 'meta', shape: '{"gift":boolean}' }], rules: [{ text: 'needs a customer' }] },
          { table: 'shop.invented', purpose: 'x' },
        ],
        links: [
          { from: 'learning.course_progress.user_id', to: 'shop.customer.id', why: 'progress belongs to a customer', ref: 'Progress.kt:40' },
          { from: 'shop.orders.ghost', to: 'shop.customer.id', why: 'x' },
        ],
      }),
      snapshot,
      '/code/shop',
    );
    if ('error' in res) throw new Error(res.error);
    expect(Object.keys(res.tables)).toEqual(['shop.orders']);
    expect(res.tables['shop.orders'].values).toEqual([{ column: 'state', values: ['OPEN', 'PAID'], ref: 'Order.java:12' }]);
    expect(res.tables['shop.orders'].repo).toBe('/code/shop');
    expect(res.links).toHaveLength(1);
    expect(res.dropped).toBe(3);
  });

  it('says so when there is no JSON', () => {
    expect(parseMapAnswer('I could not find anything.', snapshot, '/x')).toEqual({ error: 'The answer had no JSON in it.' });
  });
});

const owner = { kind: 'envSet' as const, id: 'shop', name: 'shop' };

function sampleMap(): DbMap {
  return mergeInto(emptyMap(owner), {
    tables: {
      'shop.customer': { purpose: 'A shopper who buys things', values: [{ column: 'tier', values: ['GOLD', 'BASIC'] }], json: [], rules: [] },
      'shop.orders': { purpose: 'An order a customer placed', values: [], json: [], rules: [] },
      'learning.course_progress': { purpose: 'How far a learner got through a course', values: [], json: [{ column: 'payload', shape: '{"section":number}' }], rules: [] },
    },
    links: [{ from: 'learning.course_progress.user_id', to: 'shop.customer.id', why: 'progress belongs to a customer' }],
  });
}

describe('using the map', () => {
  it('finds the tables and schemas a ticket is about', () => {
    const m = sampleMap();
    const ticket = 'Learners lose their progress through a course after the release';
    expect(tablesFor(m, ticket)[0]).toBe('learning.course_progress');
    expect(schemasFor(m, ticket)[0]).toBe('learning');
  });

  it('gives a seed the tables it touches and their linked neighbours, with what is known', () => {
    const slice = mapSlice(sampleMap(), 'course progress is lost', []);
    expect(slice.tables).toEqual(['learning.course_progress', 'shop.customer']);
    expect(slice.text).toContain('payload JSON: {"section":number}');
    expect(slice.text).toContain('tier ∈ {GOLD, BASIC}');
    expect(slice.text).toContain('learning.course_progress.user_id → shop.customer.id');
    expect(mapSlice(sampleMap(), 'nothing relevant here', []).text).toBe('');
  });

  it('keeps what seeds learned when a repo is mapped again', () => {
    const learned = learnFrom(sampleMap(), [
      { source: 'code', text: 'An order in state PAID needs a payment row in shop.orders', ref: 'Pay.java:9' },
      { source: 'schema', text: 'orders has a customer_id' },
    ]);
    expect(learned.added).toBe(1);
    const again = mergeInto(learned.map, { tables: { 'shop.orders': { purpose: 'An order', values: [], json: [], rules: [{ text: 'fresh rule' }] } }, links: [] });
    expect(again.tables['shop.orders'].rules.map((r) => r.text)).toEqual(['fresh rule', 'An order in state PAID needs a payment row in shop.orders']);
  });
});

describe('how current a map is', () => {
  it('notices code that moved and schemas that changed', () => {
    const m: DbMap = { ...sampleMap(), repos: [{ path: '/code/shop', head: 'a1', mappedAt: '', schemas: ['shop'] }], schemas: { shop: 'fp1' } };
    expect(freshness(m, { repos: [{ path: '/code/shop', head: 'a1', behind: null }], schemas: { shop: 'fp1' } }).fresh).toBe(true);
    const moved = freshness(m, { repos: [{ path: '/code/shop', head: 'b2', behind: 4 }, { path: '/code/learning', head: 'c3', behind: null }], schemas: { shop: 'fp2' } });
    expect(moved.fresh).toBe(false);
    expect(moved.repos).toEqual([{ path: '/code/shop', behind: 4, mapped: true }, { path: '/code/learning', behind: null, mapped: false }]);
    expect(moved.schemas).toEqual(['shop']);
  });

  it('fingerprints tables and columns, whatever their order', () => {
    const a = schemaFingerprint(snapshot.schemas[0]);
    const b = schemaFingerprint({ ...snapshot.schemas[0], tables: [...snapshot.schemas[0].tables].reverse() });
    expect(a).toBe(b);
    expect(schemaFingerprint({ ...snapshot.schemas[0], tables: [table('customer', ['id', 'status'])] })).not.toBe(a);
  });

  it('lists the catalog for the prompt, one table a line', () => {
    expect(catalogLines(snapshot, ['learning'])).toBe('learning.course_progress(id varchar, user_id varchar, course_id varchar, step varchar, payload varchar)');
  });
});
