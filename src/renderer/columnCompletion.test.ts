import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { columnCompletionSource } from './sqlSchema';
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
            { name: 'panel_id', ordinal: 2, typeName: 'varchar(32)', nullable: true, defaultExpr: null },
            { name: 'client_id', ordinal: 3, typeName: 'varchar(32)', nullable: true, defaultExpr: null },
          ],
          primaryKey: ['id'], indexes: [], foreignKeys: [],
        },
        {
          name: 'client', kind: 'table',
          columns: [
            { name: 'client_id', ordinal: 1, typeName: 'varchar(32)', nullable: false, defaultExpr: null },
            { name: 'client_name', ordinal: 2, typeName: 'varchar(80)', nullable: true, defaultExpr: null },
          ],
          primaryKey: ['client_id'], indexes: [], foreignKeys: [],
        },
      ],
    },
  ],
};

function complete(doc: string, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, doc.length, explicit);
  return columnCompletionSource(snapshot)(ctx) as CompletionResult | null;
}

const labels = (r: CompletionResult | null) => (r?.options ?? []).map((o) => o.label);

describe('columnCompletionSource', () => {
  it('offers columns of the table in the FROM clause', () => {
    const r = complete('select * from panel_widget where panel_i');
    expect(labels(r)).toContain('panel_id');
    expect(labels(r)).toContain('client_id');
  });

  it('offers columns right after SELECT too', () => {
    expect(labels(complete('select pan from panel_widget'))).toContain('panel_id');
  });

  it('resolves an alias to its own table only', () => {
    const r = complete('select * from panel_widget pw join client c on c.');
    expect(labels(r)).toEqual(['client_id', 'client_name']);
  });

  it('resolves a bare table name as a qualifier', () => {
    expect(labels(complete('select * from panel_widget where panel_widget.'))).toContain('panel_id');
  });

  it("offers both tables' columns in a join", () => {
    const r = complete('select * from panel_widget pw join client c on 1=1 where cli');
    expect(labels(r)).toContain('client_name');
    expect(labels(r)).toContain('client_id');
  });

  it('puts the primary key first', () => {
    const r = complete('select * from panel_widget where i');
    const pk = r?.options.find((o) => o.label === 'id');
    const other = r?.options.find((o) => o.label === 'panel_id');
    expect((pk?.boost ?? 0)).toBeGreaterThan(other?.boost ?? 0);
  });

  it('returns nothing when the statement names no table', () => {
    expect(complete('select 1 as hel')).toBeNull();
  });

  it('scopes to the statement under the cursor', () => {
    // The third statement's columns must not be offered while editing the
    // first — a buffer of unrelated queries would otherwise pool together.
    const doc = 'select * from client where cli';
    expect(labels(complete(doc))).toContain('client_name');
    expect(labels(complete(doc))).not.toContain('panel_id');
  });
});
