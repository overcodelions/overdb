import { describe, expect, it } from 'vitest';
import type { IndexInfo, SchemaSnapshot, TableInfo } from './types';
import { indexConsequence, indexMatrix } from './indexMatrix';

function table(name: string, indexes: IndexInfo[]): TableInfo {
  return {
    name,
    kind: 'table',
    columns: [{ name: 'id', ordinal: 1, typeName: 'int', nullable: false, defaultExpr: null }],
    primaryKey: ['id'],
    indexes,
    foreignKeys: [],
  };
}

function snap(tables: TableInfo[]): SchemaSnapshot {
  return {
    engine: 'mysql',
    serverVersion: '8.0',
    capturedAt: '2026-09-10T00:00:00Z',
    schemas: [{ name: 'acme', tables }],
  };
}

const TABLES = [{ schema: 'acme', table: 'z123_user_subscription' }];
const ix = (columns: string[], unique = false, name = columns.join('_')): IndexInfo => ({
  name,
  columns,
  unique,
});

function members(base: SchemaSnapshot | undefined, other: SchemaSnapshot | undefined) {
  return [
    { connectionId: 'base', snapshot: base },
    { connectionId: 'other', snapshot: other },
  ];
}

const cell = (m: ReturnType<typeof indexMatrix>, row: number, member: string) =>
  m.rows[row].cells.find((c) => c.memberId === member);

describe('indexMatrix', () => {
  it('counts an index both members have rather than drawing it', () => {
    // Twenty identical rows are what stops the one that is not identical
    // from being seen.
    const both = snap([table('z123_user_subscription', [ix(['client_id'])])]);
    const m = indexMatrix(members(both, both), 'base', TABLES);
    expect(m.rows).toHaveLength(0);
    expect(m.matching).toBe(1);
  });

  it('draws a row for one the member is missing', () => {
    const m = indexMatrix(
      members(
        snap([table('z123_user_subscription', [ix(['user_id', 'create_date'])])]),
        snap([table('z123_user_subscription', [])]),
      ),
      'base',
      TABLES,
    );
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].label).toBe('(user_id, create_date)');
    expect(cell(m, 0, 'other')).toMatchObject({ text: 'absent', tone: 'absent' });
    expect(cell(m, 0, 'base')).toMatchObject({ tone: 'baseline' });
  });

  it('matches on columns, not on the name the migration happened to use', () => {
    // Two servers built by different migrations name the same index
    // differently; matching on names reports every index twice.
    const m = indexMatrix(
      members(
        snap([table('z123_user_subscription', [ix(['email'], false, 'idx_a')])]),
        snap([table('z123_user_subscription', [ix(['email'], false, 't_email_idx')])]),
      ),
      'base',
      TABLES,
    );
    expect(m.rows).toHaveLength(0);
    expect(m.matching).toBe(1);
  });

  it('calls out an index that exists but is no longer unique', () => {
    // A correctness difference, not a performance one: the server accepts
    // duplicates the baseline rejects.
    const m = indexMatrix(
      members(
        snap([table('z123_user_subscription', [ix(['subscription_ref'], true)])]),
        snap([table('z123_user_subscription', [ix(['subscription_ref'], false)])]),
      ),
      'base',
      TABLES,
    );
    expect(cell(m, 0, 'other')).toMatchObject({ text: 'not unique', tone: 'drift' });
  });

  it('reports an index only the member has once, not on every other member', () => {
    const m = indexMatrix(
      members(
        snap([table('z123_user_subscription', [])]),
        snap([table('z123_user_subscription', [ix(['client_id'])])]),
      ),
      'base',
      TABLES,
    );
    expect(cell(m, 0, 'other')).toMatchObject({ text: 'extra', tone: 'drift' });
    expect(cell(m, 0, 'base')).toMatchObject({ text: 'absent' });
  });

  it('says "not read" for a catalog it never loaded, never "same"', () => {
    // The one answer worse than none.
    const m = indexMatrix(
      members(snap([table('z123_user_subscription', [ix(['client_id'])])]), undefined),
      'base',
      TABLES,
    );
    expect(cell(m, 0, 'other')).toMatchObject({ text: 'not read', tone: 'unknown' });
    expect(m.unread).toEqual(['other']);
  });

  it('leaves out an index whose columns the catalog would not give up', () => {
    // MySQL reports no column name for a functional index. Two of them
    // would key identically and read as matching each other.
    const withNull = snap([
      table('z123_user_subscription', [ix([null as unknown as string], false, 'fn')]),
    ]);
    const m = indexMatrix(members(withNull, withNull), 'base', TABLES);
    expect(m.rows).toHaveLength(0);
    expect(m.matching).toBe(0);
  });

  it('finds the table whatever case the server named it in', () => {
    const m = indexMatrix(
      members(
        snap([table('Z123_User_Subscription', [ix(['client_id'])])]),
        snap([table('z123_user_subscription', [])]),
      ),
      'base',
      TABLES,
    );
    expect(m.rows).toHaveLength(1);
  });

  it('says which table each row is on, for a join', () => {
    const m = indexMatrix(
      members(
        snap([table('partner', [ix(['client_id'])]), table('panel_widget', [ix(['panel_id'])])]),
        snap([table('partner', []), table('panel_widget', [])]),
      ),
      'base',
      [
        { schema: 'acme', table: 'partner' },
        { schema: 'acme', table: 'panel_widget' },
      ],
    );
    expect(m.rows.map((r) => r.table)).toEqual(['acme.partner', 'acme.panel_widget']);
  });

  it('puts the baseline first however the members were passed', () => {
    const m = indexMatrix(
      [
        { connectionId: 'other', snapshot: snap([table('z123_user_subscription', [])]) },
        { connectionId: 'base', snapshot: snap([table('z123_user_subscription', [ix(['a'])])]) },
      ],
      'base',
      TABLES,
    );
    expect(m.rows[0].cells[0].memberId).toBe('base');
  });

  it('has nothing to say when the statement touched no table', () => {
    const m = indexMatrix(members(snap([]), snap([])), 'base', []);
    expect(m).toMatchObject({ rows: [], matching: 0, tables: [] });
  });
});

describe('indexConsequence', () => {
  it('leads with the correctness difference, not the performance one', () => {
    // A server accepting duplicates the baseline rejects is the finding
    // you would want woken up for; a missing index is not.
    const m = indexMatrix(
      members(
        snap([
          table('z123_user_subscription', [ix(['subscription_ref'], true), ix(['user_id'])]),
        ]),
        snap([table('z123_user_subscription', [ix(['subscription_ref'], false)])]),
      ),
      'base',
      TABLES,
    );
    const text = indexConsequence(m) ?? '';
    expect(text.indexOf('duplicates')).toBeLessThan(text.indexOf('different plan'));
  });

  it('says nothing when nothing differs', () => {
    const both = snap([table('z123_user_subscription', [ix(['client_id'])])]);
    expect(indexConsequence(indexMatrix(members(both, both), 'base', TABLES))).toBeNull();
  });

  it('names a missing index as a plan difference', () => {
    const m = indexMatrix(
      members(
        snap([table('z123_user_subscription', [ix(['user_id'])])]),
        snap([table('z123_user_subscription', [])]),
      ),
      'base',
      TABLES,
    );
    expect(indexConsequence(m)).toMatch(/different plan/);
  });
});
