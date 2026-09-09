import { describe, expect, it } from 'vitest';
import { namespaceFor, parseTableRefs, tablesInQuery } from './sqlSchema';
import type { SchemaSnapshot } from '@shared/types';

const snapshot: SchemaSnapshot = {
  engine: 'mysql',
  serverVersion: '10.8.8-MariaDB',
  capturedAt: '',
  schemas: [
    {
      name: 'acme',
      tables: [
        {
          name: 'panel_widget', kind: 'table',
          columns: [
            { name: 'id', ordinal: 1, typeName: 'varchar(32)', nullable: false, defaultExpr: null },
            { name: 'client_id', ordinal: 2, typeName: 'varchar(32)', nullable: true, defaultExpr: null },
          ],
          primaryKey: ['id'], indexes: [],
          foreignKeys: [{ name: 'fk', columns: ['client_id'], refSchema: null, refTable: 'client', refColumns: ['client_id'] }],
        },
      ],
    },
  ],
};

describe('namespaceFor', () => {
  it('exposes tables both qualified and bare', () => {
    // Bare, because requiring `acme.panel_widget` would make the common
    // unqualified case worse than no completion at all. Qualified, because
    // `other_db.<tab>` is exactly what breaks when only bare names exist.
    const ns = namespaceFor(snapshot, 'acme') as Record<string, Record<string, unknown>>;
    expect(Object.keys(ns).sort()).toEqual(['acme', 'panel_widget']);
    expect(Object.keys(ns.acme)).toEqual(['panel_widget']);
  });

  it('flattens only the ACTIVE schema, leaving others qualified', () => {
    const two: SchemaSnapshot = {
      ...snapshot,
      schemas: [snapshot.schemas[0], { name: 'acme_cms', tables: [
        { name: 'page', kind: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
      ] }],
    };
    const ns = namespaceFor(two, 'acme_cms') as Record<string, unknown>;
    // `page` is flat (active schema); panel_widget is only under `acme`.
    expect(Object.keys(ns).sort()).toEqual(['acme', 'acme_cms', 'page']);
  });

  it('carries the column type as detail and boosts the primary key', () => {
    const ns = namespaceFor(snapshot, 'acme') as Record<string, Array<{ label: string; detail: string; boost: number }>>;
    const cols = ns.panel_widget;
    expect(cols.map((c) => c.label)).toEqual(['id', 'client_id']);
    expect(cols[0].detail).toBe('varchar(32)');
    expect(cols[0].boost).toBe(1);
    expect(cols[1].boost).toBe(0);
  });

  it('is empty rather than throwing when there is no catalog yet', () => {
    expect(namespaceFor(undefined)).toEqual({});
  });
});

describe('tablesInQuery', () => {
  it('finds tables after from, join, update and into', () => {
    expect(tablesInQuery('select * from panel_widget join client on 1=1')).toEqual([
      'panel_widget', 'client',
    ]);
    expect(tablesInQuery('insert into orders values (1)')).toEqual(['orders']);
  });

  it('strips quoting and schema qualification', () => {
    expect(tablesInQuery('select * from `acme`.`panel_widget`')).toEqual(['panel_widget']);
    expect(tablesInQuery('select * from public.orders')).toEqual(['orders']);
  });

  it('does not repeat a table joined twice', () => {
    expect(tablesInQuery('select * from a join a on 1=1')).toEqual(['a']);
  });
});

describe('parseTableRefs', () => {
  it('reads a table with no alias', () => {
    expect(parseTableRefs('select * from panel_widget')).toEqual([{ table: 'panel_widget' }]);
  });

  it('reads aliases, with and without AS', () => {
    expect(parseTableRefs('select * from panel_widget pw join client as c on 1=1')).toEqual([
      { table: 'panel_widget', alias: 'pw' },
      { table: 'client', alias: 'c' },
    ]);
  });

  it('does not mistake a keyword for an alias', () => {
    // `from orders where ...` reading "where" as the alias is what breaks
    // every qualified completion after it.
    expect(parseTableRefs('select * from orders where id = 1')).toEqual([{ table: 'orders' }]);
    expect(parseTableRefs('select * from orders order by id')).toEqual([{ table: 'orders' }]);
    expect(parseTableRefs('select * from a join b on a.id = b.id')).toEqual([
      { table: 'a' }, { table: 'b' },
    ]);
  });

  it('strips quoting and schema qualification but keeps the alias', () => {
    expect(parseTableRefs('select * from `acme`.`panel_widget` pw')).toEqual([
      { table: 'panel_widget', alias: 'pw' },
    ]);
  });

  it('handles update and insert targets', () => {
    expect(parseTableRefs('update orders set a = 1')).toEqual([{ table: 'orders' }]);
    expect(parseTableRefs('insert into orders (a) values (1)')).toEqual([{ table: 'orders' }]);
  });
});
