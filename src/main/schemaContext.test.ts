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

describe('tables in schemas we did not introspect', () => {
  const snap: SchemaSnapshot = {
    engine: 'mysql',
    serverVersion: '10.6.0-MariaDB',
    capturedAt: '',
    schemas: [
      {
        name: 'acme_cms',
        tables: [
          {
            name: 'cms_page',
            kind: 'table',
            columns: [{ name: 'id', typeName: 'varchar', nullable: false }],
            primaryKey: ['id'],
            indexes: [],
            foreignKeys: [],
          },
        ],
      },
    ],
  } as unknown as SchemaSnapshot;

  it('names a matching table that lives in another schema, qualified', () => {
    const ctx = buildSchemaContext(snap, 'find me all the panel widgets', {
      activeSchema: 'acme_cms',
      elsewhere: [
        { schema: 'acme', table: 'panel_widget' },
        { schema: 'acme', table: 'unrelated_thing' },
      ],
    });
    expect(ctx.text).toContain('acme.panel_widget');
    expect(ctx.text).not.toContain('acme.unrelated_thing');
  });

  it('does not repeat a table whose shape it already showed', () => {
    const ctx = buildSchemaContext(snap, 'cms page', {
      elsewhere: [{ schema: 'acme_cms', table: 'cms_page' }],
    });
    expect(ctx.text).not.toContain('-- acme_cms.cms_page');
  });

  it('says nothing at all when nothing matches', () => {
    const ctx = buildSchemaContext(snap, 'cms page', {
      elsewhere: [{ schema: 'acme', table: 'panel_widget' }],
    });
    expect(ctx.text).not.toContain('shape not loaded');
  });
});

describe('a schema that was only partly introspected', () => {
  /// DynamoDB puts every table in one pseudo-schema (the region) and
  /// describes only as many as the budget allows. The rest have a name and
  /// no columns — and used to be dropped from the prompt entirely, because
  /// the "did we introspect this?" test was per schema rather than per
  /// table. The model then answered "I don't see an events table" about a
  /// table sitting right there in the account.
  const snap: SchemaSnapshot = {
    engine: 'dynamodb',
    serverVersion: 'us-east-1',
    capturedAt: '',
    schemas: [
      {
        name: 'us-east-1',
        tables: [
          table('replicator-state', ['pk', 'sk']),
          { name: 'LOCAL.event-log-v2', kind: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
        ],
      },
    ],
  };

  const elsewhere = [
    { schema: 'us-east-1', table: 'replicator-state' },
    { schema: 'us-east-1', table: 'LOCAL.event-log-v2' },
    { schema: 'us-east-1', table: 'unrelated-thing' },
  ];

  it('names a described-budget table in the same schema', () => {
    const ctx = buildSchemaContext(snap, 'what is my latest events', { elsewhere });
    // Quoted whole, and NOT region-qualified: on DynamoDB the dotted form
    // means table.index, so `us-east-1.LOCAL.event-log-v2` is advice that
    // produces a statement the server rejects.
    expect(ctx.text).toContain('"LOCAL.event-log-v2"');
    expect(ctx.text).not.toContain('us-east-1.LOCAL.event-log-v2');
    expect(ctx.text).not.toContain('unrelated-thing');
  });

  it('counts every table it knows about, not just the described ones', () => {
    const ctx = buildSchemaContext(snap, 'what is my latest events', { elsewhere });
    expect(ctx.totalTables).toBe(3);
  });
});

describe('tokenize', () => {
  it('matches a plural question against a singular table name', () => {
    // "my latest events" against `event_log`. Without stemming this scores
    // zero and the table never reaches the prompt.
    const snap: SchemaSnapshot = {
      engine: 'mysql', serverVersion: '10.6.0-MariaDB', capturedAt: '',
      schemas: [{ name: 'app', tables: [table('event_log', ['id', 'body']), table('widget', ['id'])] }],
    };
    const ctx = buildSchemaContext(snap, 'what are my latest events');
    expect(ctx.included[0]).toBe('event_log');
  });
});

describe('pinned tables', () => {
  const snap: SchemaSnapshot = {
    engine: 'mysql', serverVersion: '10.6.0-MariaDB', capturedAt: '',
    schemas: [{
      name: 'acme',
      tables: [
        table('audit_trail', ['id', 'actor']),
        ...Array.from({ length: 40 }, (_, i) => table(`widget_${i}`, ['id', 'widget_name'])),
      ],
    }],
  };

  it('includes a pinned table the question never mentions', () => {
    // The whole point of a pin: the scorer gives `audit_trail` zero for this
    // question, and the user has already said it matters anyway.
    const auto = buildSchemaContext(snap, 'show me the widgets');
    expect(auto.included).not.toContain('audit_trail');

    const ctx = buildSchemaContext(snap, 'show me the widgets', { pinned: ['acme.audit_trail'] });
    expect(ctx.included).toContain('audit_trail');
  });

  it('puts pins ahead of whatever the scorer chose', () => {
    const ctx = buildSchemaContext(snap, 'show me the widgets', { pinned: ['acme.audit_trail'] });
    expect(ctx.included[0]).toBe('audit_trail');
  });

  it('accepts a bare table name as well as a qualified one', () => {
    const ctx = buildSchemaContext(snap, 'show me the widgets', { pinned: ['audit_trail'] });
    expect(ctx.included).toContain('audit_trail');
  });

  it('names a pinned table whose shape never loaded', () => {
    // DynamoDB past its describe budget. A pin that silently does nothing
    // because we could not describe the table is worse than no pin at all.
    const ctx = buildSchemaContext(snap, 'anything', {
      pinned: ['us-east-1.LOCAL.event-log-v2'],
      elsewhere: [{ schema: 'us-east-1', table: 'LOCAL.event-log-v2' }],
    });
    expect(ctx.text).toContain('us-east-1.LOCAL.event-log-v2');
  });

  it('does not fall back to an arbitrary first-twelve when a pin matched', () => {
    const ctx = buildSchemaContext(snap, 'zzzz', { pinned: ['acme.audit_trail'] });
    expect(ctx.included).toEqual(['audit_trail']);
  });
});
