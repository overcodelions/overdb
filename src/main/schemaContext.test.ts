import { describe, expect, it } from 'vitest';
import { buildSchemaContext } from './schemaContext';
import type { SchemaSnapshot, TableInfo } from '../shared/types';

const table = (name: string, cols: string[], fks: Array<[string, string]> = []): TableInfo => ({
  name,
  kind: 'table',
  columns: cols.map((c, i) => ({ name: c, ordinal: i, typeName: 'varchar(32)', nullable: true, defaultExpr: null })),
  primaryKey: [cols[0]],
  indexes: [],
  foreignKeys: fks.map(([col, ref]) => ({
    name: `fk_${col}`, columns: [col], refSchema: null, refTable: ref, refColumns: [`${ref}_id`],
  })),
});

/// A schema shaped like the real one: the table you ask about, the table it
/// joins to, and a crowd of unrelated tables that also happen to contain
/// common words.
function bigSnapshot(): SchemaSnapshot {
  const noise = Array.from({ length: 200 }, (_, i) =>
    table(`noise_${i}`, ['id', 'name', 'create_date', 'client_id']),
  );
  return {
    engine: 'mysql',
    serverVersion: '10.8.8-MariaDB',
    capturedAt: '',
    schemas: [
      {
        name: 'acme',
        tables: [
          table('panel_widget', ['id', 'name', 'client_id', 'panel_id'], [['client_id', 'client']]),
          table('client', ['client_id', 'client_name', 'display_name']),
          ...noise,
        ],
      },
    ],
  };
}

describe('buildSchemaContext', () => {
  it('includes a foreign-key neighbour even when the question never names it', () => {
    // The bug this pins: neighbours used to be appended after every scored
    // table, so the byte budget truncated exactly the join target the
    // question needed — the model then reported that `client` "isn't in the
    // schema I was given" while it sat one FK away in the database.
    const ctx = buildSchemaContext(bigSnapshot(), 'find me all panel widgets from the client hp');
    expect(ctx.included).toContain('panel_widget');
    expect(ctx.included).toContain('client');
  });

  it('still finds the neighbour when the question misspells it', () => {
    const ctx = buildSchemaContext(bigSnapshot(), 'find me all panel widgets from the lcient hp');
    expect(ctx.included).toContain('client');
  });

  it('puts the seed and its neighbour ahead of incidental matches', () => {
    const ctx = buildSchemaContext(bigSnapshot(), 'panel widget client');
    expect(ctx.included.indexOf('client')).toBeLessThan(ctx.included.indexOf('noise_150'));
  });

  it('reports how much of the schema it actually saw', () => {
    const ctx = buildSchemaContext(bigSnapshot(), 'panel widget');
    expect(ctx.totalTables).toBe(202);
    expect(ctx.included.length).toBeLessThan(ctx.totalTables);
  });

  it('emits nothing rather than throwing without a catalog', () => {
    expect(buildSchemaContext(undefined, 'anything')).toEqual({ text: '', included: [], totalTables: 0 });
  });

  it('never contains row data — only identifiers, types and constraints', () => {
    const ctx = buildSchemaContext(bigSnapshot(), 'panel widget');
    expect(ctx.text).toContain('panel_widget(');
    expect(ctx.text).toMatch(/FK\(client_id->client/);
  });
});
