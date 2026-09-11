import { describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaSnapshot, TableInfo } from './types';
import { buildGraph, edgePath, filterGraph, footFor, layoutGraph } from './erGraph';

function column(name: string, nullable = false): ColumnInfo {
  return { name, ordinal: 1, typeName: 'int', nullable, defaultExpr: null };
}

function table(name: string, patch: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    kind: 'table',
    columns: [column('id')],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    ...patch,
  };
}

function snapshot(tables: TableInfo[], schemaName = 'public'): SchemaSnapshot {
  return {
    engine: 'postgres',
    serverVersion: '17.0',
    capturedAt: '2026-09-10T00:00:00Z',
    schemas: [{ name: schemaName, tables }],
  };
}

describe('buildGraph', () => {
  it('draws an edge only where the server holds a constraint', () => {
    // A column called user_id with no foreign key is NOT a relationship —
    // guessing one would put an invented edge in the same ink as a real one.
    const graph = buildGraph(
      snapshot([
        table('users'),
        table('orders', {
          columns: [column('id'), column('user_id'), column('coupon_id')],
          foreignKeys: [
            { name: 'orders_user_fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: 'public.orders', to: 'public.users' });
  });

  it('reads a unique foreign key as one-to-one', () => {
    const graph = buildGraph(
      snapshot([
        table('users'),
        table('profiles', {
          columns: [column('id'), column('user_id')],
          indexes: [{ name: 'profiles_user_uk', columns: ['user_id'], unique: true }],
          foreignKeys: [
            { name: 'fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.edges[0].fromCardinality).toBe('one');
  });

  it('reads a nullable foreign key as optional on both ends', () => {
    const graph = buildGraph(
      snapshot([
        table('users'),
        table('orders', {
          columns: [column('id'), column('user_id', true)],
          foreignKeys: [
            { name: 'fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.edges[0]).toMatchObject({ fromCardinality: 'many', toCardinality: 'zero-or-one' });
  });

  it('names a target it could not find rather than dropping the edge', () => {
    // The commonest cause is a schema that has not been introspected, and a
    // silently missing edge is worse than a note saying so.
    const graph = buildGraph(
      snapshot([
        table('orders', {
          foreignKeys: [
            { name: 'fk', columns: ['tenant_id'], refSchema: 'billing', refTable: 'tenants', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.edges).toHaveLength(0);
    expect(graph.danglingTargets).toEqual(['billing.tenants']);
  });

  it('marks a self-reference rather than treating it as a layer', () => {
    const graph = buildGraph(
      snapshot([
        table('employees', {
          columns: [column('id'), column('manager_id', true)],
          foreignKeys: [
            { name: 'fk', columns: ['manager_id'], refSchema: 'public', refTable: 'employees', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.edges[0].selfReference).toBe(true);
    expect(graph.nodes[0].degree).toBe(1);
  });

  it('counts degree on both ends', () => {
    const graph = buildGraph(
      snapshot([
        table('users'),
        table('orders', {
          foreignKeys: [
            { name: 'fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    expect(graph.nodes.find((n) => n.table === 'users')?.degree).toBe(1);
    expect(graph.nodes.find((n) => n.table === 'orders')?.degree).toBe(1);
  });
});

describe('filterGraph', () => {
  const graph = buildGraph(
    snapshot([
      table('users'),
      table('coupons'),
      table('orders', {
        foreignKeys: [
          { name: 'a', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          { name: 'b', columns: ['coupon_id'], refSchema: 'public', refTable: 'coupons', refColumns: ['id'] },
        ],
      }),
      table('order_lines', {
        foreignKeys: [
          { name: 'c', columns: ['order_id'], refSchema: 'public', refTable: 'orders', refColumns: ['id'] },
        ],
      }),
      table('unrelated'),
    ]),
  );

  it('keeps one hop around a focus', () => {
    const near = filterGraph(graph, { focus: 'public.orders', depth: 1 });
    expect(near.nodes.map((n) => n.table).sort()).toEqual([
      'coupons', 'order_lines', 'orders', 'users',
    ]);
  });

  it('reaches further at depth two', () => {
    const near = filterGraph(graph, { focus: 'public.order_lines', depth: 2 });
    expect(near.nodes.map((n) => n.table).sort()).toEqual([
      'coupons', 'order_lines', 'orders', 'users',
    ]);
  });

  it('keeps the focus even when the search term excludes it', () => {
    const near = filterGraph(graph, { focus: 'public.orders', query: 'zzz', depth: 0 });
    expect(near.nodes.map((n) => n.table)).toEqual(['orders']);
  });

  it('drops edges whose other end was filtered out', () => {
    const only = filterGraph(graph, { query: 'order' });
    expect(only.nodes.map((n) => n.table).sort()).toEqual(['order_lines', 'orders']);
    // orders -> users and orders -> coupons both lost their other end.
    expect(only.edges.map((e) => e.name)).toEqual(['c']);
  });
});

describe('layoutGraph', () => {
  const sizes = (graph: ReturnType<typeof buildGraph>) =>
    Object.fromEntries(graph.nodes.map((n) => [n.id, { w: 200, h: 80 }]));

  it('puts a referenced table above the table referencing it', () => {
    const graph = buildGraph(
      snapshot([
        table('users'),
        table('orders', {
          foreignKeys: [
            { name: 'fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          ],
        }),
      ]),
    );
    const { boxes } = layoutGraph(graph, sizes(graph));
    expect(boxes['public.users'].y).toBeLessThan(boxes['public.orders'].y);
  });

  it('terminates on a cycle and says which edge closed it', () => {
    // Circular references are real — a mutual FK pair is legal — and a
    // layout that recursed forever on one would hang the window.
    const graph = buildGraph(
      snapshot([
        table('a', {
          foreignKeys: [{ name: 'ab', columns: ['b_id'], refSchema: 'public', refTable: 'b', refColumns: ['id'] }],
        }),
        table('b', {
          foreignKeys: [{ name: 'ba', columns: ['a_id'], refSchema: 'public', refTable: 'a', refColumns: ['id'] }],
        }),
      ]),
    );
    const layout = layoutGraph(graph, sizes(graph));
    expect(layout.backEdges).toHaveLength(1);
    expect(Object.keys(layout.boxes).sort()).toEqual(['public.a', 'public.b']);
  });

  it('is stable — the same schema lays out the same way twice', () => {
    const graph = buildGraph(
      snapshot([table('c'), table('a'), table('b')]),
    );
    expect(layoutGraph(graph, sizes(graph)).boxes).toEqual(layoutGraph(graph, sizes(graph)).boxes);
  });

  it('reports bounds that contain every box', () => {
    const graph = buildGraph(snapshot([table('a'), table('b'), table('c')]));
    const layout = layoutGraph(graph, sizes(graph));
    for (const box of Object.values(layout.boxes)) {
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it('lays out an empty graph without dividing by nothing', () => {
    const layout = layoutGraph({ nodes: [], edges: [], danglingTargets: [] }, {});
    expect(layout).toMatchObject({ width: 0, height: 0, boxes: {} });
  });
});

describe('edgePath', () => {
  it('leaves the top of a box that points upward', () => {
    const path = edgePath({ x: 0, y: 200, w: 100, h: 60 }, { x: 300, y: 0, w: 100, h: 60 });
    expect(path.startsWith('M50,200')).toBe(true);
    expect(path.endsWith('L350,60')).toBe(true);
  });

  it('is a straight line between vertically aligned boxes', () => {
    expect(edgePath({ x: 0, y: 200, w: 100, h: 60 }, { x: 0, y: 0, w: 100, h: 60 })).toBe(
      'M50,200 L50,60',
    );
  });
});

describe('footFor', () => {
  it('gives many a crow, optional a circle, and one a bar', () => {
    expect(footFor('many')).toBe('crow');
    expect(footFor('zero-or-one')).toBe('circle-bar');
    expect(footFor('one')).toBe('bar');
  });
});
