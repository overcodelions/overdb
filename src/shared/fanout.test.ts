import { describe, expect, it } from 'vitest';
import {
  blankRun,
  columnMatrix,
  compare,
  fanoutRefusal,
  fanoutSummary,
  inFlight,
  touchedTables,
  rowsVerdict,
  slowdown,
  type MemberRun,
} from './fanout';
import type { Cell, ColumnMeta } from './types';
import type { Variant } from './engines';

const col = (name: string, typeName = 'int4'): ColumnMeta => ({
  name,
  typeName,
  kind: 'int',
  nullable: false,
  sourceTable: null,
});

const done = (
  id: string,
  columns: ColumnMeta[],
  rows: Cell[][],
  variant: Variant = 'postgres',
): MemberRun => ({
  ...blankRun(id, 'postgres', variant),
  status: 'done',
  columns,
  rows,
  rowCount: rows.length,
});

describe('compare', () => {
  const base = done('base', [col('id'), col('name', 'text')], [[1, 'a'], [2, 'b']]);

  it('calls the baseline the baseline', () => {
    expect(compare(base, base).kind).toBe('baseline');
    expect(compare(base, null).kind).toBe('baseline');
  });

  it('calls an identical answer identical', () => {
    const same = done('other', [col('id'), col('name', 'text')], [[1, 'a'], [2, 'b']]);
    const c = compare(same, base);
    expect(c.kind).toBe('match');
    expect(c.summary).toBe('identical');
  });

  it('names the column this member is missing, in that direction', () => {
    const missing = done('other', [col('id')], [[1], [2]]);
    const c = compare(missing, base);
    expect(c.kind).toBe('differs');
    expect(c.drift?.missingColumns).toEqual(['name']);
    expect(c.summary).toContain('missing column name');
  });

  it('names a column this member has and the baseline does not', () => {
    const extra = done(
      'other',
      [col('id'), col('name', 'text'), col('deleted_at', 'timestamptz')],
      [[1, 'a', null], [2, 'b', null]],
    );
    expect(compare(extra, base).drift?.extraColumns).toEqual(['deleted_at']);
  });

  it('reports a type that changed under the same name', () => {
    const retyped = done('other', [col('id', 'int8'), col('name', 'text')], [[1, 'a'], [2, 'b']]);
    const c = compare(retyped, base);
    expect(c.drift?.changedTypes).toEqual([{ column: 'id', baseline: 'int4', here: 'int8' }]);
    expect(c.summary).toContain('id is int8, not int4');
  });

  // The finding that is easiest to miss and most worth stating.
  it('says so when the counts match but the values do not', () => {
    const shuffled = done('other', [col('id'), col('name', 'text')], [[1, 'a'], [2, 'ZZZ']]);
    const c = compare(shuffled, base);
    expect(c.kind).toBe('differs');
    expect(c.drift?.rowDelta).toBe(0);
    expect(c.summary).toBe('same number of rows, different values');
  });

  it('leads with the schema difference, not the row count', () => {
    const both = done('other', [col('id')], [[1]]);
    expect(compare(both, base).summary.startsWith('missing column name')).toBe(true);
  });

  it('counts rows in a direction', () => {
    const fewer = done('other', [col('id'), col('name', 'text')], [[1, 'a']]);
    expect(compare(fewer, base).drift?.rowDelta).toBe(-1);
    expect(compare(fewer, base).summary).toContain('1 fewer rows');
  });

  // A capped grid says nothing about the table under it.
  it('refuses to compare rows when either side was truncated', () => {
    const capped = { ...done('other', [col('id'), col('name', 'text')], [[1, 'a'], [2, 'b']]), truncated: true };
    const c = compare(capped, base);
    expect(c.drift?.sameRows).toBeNull();
    expect(c.kind).toBe('match');
    expect(c.summary).toContain('not compared');
  });

  it('will not compare against a baseline that did not finish', () => {
    const broken = { ...base, status: 'error' as const, error: 'connect failed' };
    const ok = done('other', [col('id')], [[1]]);
    const c = compare(ok, broken);
    expect(c.kind).toBe('incomparable');
    expect(c.summary).toContain('the baseline did not finish');
  });

  it('says a failed member did not run rather than inventing a difference', () => {
    const failed = { ...blankRun('other', 'postgres'), status: 'error' as const, error: 'timeout' };
    expect(compare(failed, base)).toMatchObject({ kind: 'incomparable', summary: 'did not run' });
  });
});

describe('fanoutSummary', () => {
  const base = done('base', [col('id')], [[1]]);

  it('counts matches, differences and failures', () => {
    const runs = [
      base,
      done('same', [col('id')], [[1]]),
      done('diff', [col('id')], [[1], [2]]),
      { ...blankRun('bad', 'postgres'), status: 'error' as const, error: 'nope' },
    ];
    expect(fanoutSummary(runs, 'base')).toBe('1 match the baseline, 1 differ, 1 failed');
  });

  it('says there is nothing to compare against on a set of one', () => {
    expect(fanoutSummary([base], 'base')).toContain('nothing to compare');
  });
});

describe('fanoutRefusal', () => {
  it('allows a single read', () => {
    expect(fanoutRefusal(['read'])).toBeNull();
  });

  it('refuses a write across a set, and says why', () => {
    expect(fanoutRefusal(['write'])).toContain('read-only');
    expect(fanoutRefusal(['ddl'])).toContain('read-only');
  });

  it('refuses a transaction across a set', () => {
    expect(fanoutRefusal(['txn'])).toContain('one connection');
  });

  it('refuses a multi-statement script before it looks at the kinds', () => {
    expect(fanoutRefusal(['read', 'read'])).toContain('One statement at a time');
  });
});

describe('rowsVerdict', () => {
  const base = done('base', [col('id')], [[1]]);

  it('reports a run still in flight as progress, not as a verdict', () => {
    // The whole bug: with one member still streaming, this said "the rows
    // were not compared — only one member finished", which reads as a
    // conclusion about a run that had not happened yet. A fan-out is
    // slowest on exactly the member you most want the answer from, so this
    // window is most of the wait, not an edge case.
    const running = { ...blankRun('other', 'mysql'), status: 'running' as const };
    const v = rowsVerdict([base, running], 'select * from mail_mailing');
    expect(v.pending).toBe(true);
    expect(v.compared).toBe(false);
    expect(v.headline).toMatch(/Still running on 1 of 2/);
    expect(v.detail).toMatch(/answer yet/);
  });

  it('counts the rows that have arrived from the members still working', () => {
    const running = {
      ...blankRun('other', 'mysql'),
      status: 'running' as const,
      rows: [[1], [2], [3]],
    };
    expect(rowsVerdict([base, running], 'select 1').detail).toMatch(/3 rows have arrived/);
  });

  it('is not pending once every member has settled', () => {
    const failed = { ...blankRun('other', 'mysql'), status: 'error' as const, error: 'boom' };
    const v = rowsVerdict([base, failed], 'select 1');
    expect(v.pending).toBe(false);
    expect(v.headline).toBe('The rows were not compared.');
  });

  it('refuses to claim a comparison when both sides hit the cap', () => {
    const capped = (id: string) => ({ ...done(id, [col('id')], [[1]]), truncated: true });
    const v = rowsVerdict([capped('base'), capped('other')], 'select * from panel_widget');
    expect(v.compared).toBe(false);
    expect(v.headline).toBe('The rows were not compared.');
    expect(v.detail).toContain('row cap');
  });

  it('offers a statement that would compare', () => {
    const capped = (id: string) => ({ ...done(id, [col('id')], [[1]]), truncated: true });
    const v = rowsVerdict([capped('base'), capped('other')], 'select * from panel_widget;');
    expect(v.suggestion).toBe('select count(*) from (select * from panel_widget) t');
  });

  it('suggests nothing it cannot derive', () => {
    const capped = (id: string) => ({ ...done(id, [col('id')], [[1]]), truncated: true });
    expect(rowsVerdict([capped('a'), capped('b')], 'show tables').suggestion).toBeNull();
  });

  it('says so when only one member finished', () => {
    const v = rowsVerdict([base, { ...blankRun('x', 'postgres'), status: 'error' }], 'select 1');
    expect(v.compared).toBe(false);
    expect(v.detail).toContain('Only one member finished');
  });

  it('confirms a comparison when nothing was capped', () => {
    expect(rowsVerdict([base, done('other', [col('id')], [[1]])], 'select 1').compared).toBe(true);
  });
});

describe('columnMatrix', () => {
  const base = done('base', [col('id'), col('name', 'text'), col('created', 'datetime')], [], 'mariadb');

  it('puts the baseline first whatever order the runs arrive in', () => {
    const other = done('other', [col('id')], []);
    expect(columnMatrix([other, base], 'base').members[0].connectionId).toBe('base');
  });

  it('collapses the columns where nothing differs', () => {
    const same = done('other', [col('id'), col('name', 'text'), col('created', 'datetime')], [], 'mariadb');
    const m = columnMatrix([base, same], 'base');
    expect(m.rows).toEqual([]);
    expect(m.matching).toBe(3);
  });

  it('marks a cross-engine spelling as equivalent, not drift', () => {
    const aurora = done(
      'other',
      [col('id'), col('name', 'text'), col('created', 'timestamp')],
      [],
      'aurora-mysql',
    );
    const m = columnMatrix([base, aurora], 'base');
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].column).toBe('created');
    expect(m.rows[0].cells[1].tone).toBe('equivalent');
  });

  it('marks the same spelling difference as drift within one variant', () => {
    const twin = done(
      'other',
      [col('id'), col('name', 'text'), col('created', 'timestamp')],
      [],
      'mariadb',
    );
    expect(columnMatrix([base, twin], 'base').rows[0].cells[1].tone).toBe('drift');
  });

  it('marks a column the member did not return as absent', () => {
    const short = done('other', [col('id'), col('name', 'text')], [], 'mariadb');
    const m = columnMatrix([base, short], 'base');
    expect(m.rows[0].cells[1]).toMatchObject({ tone: 'absent', text: 'not returned' });
  });

  it('carries a column only a non-baseline member returned', () => {
    const extra = done(
      'other',
      [col('id'), col('name', 'text'), col('created', 'datetime'), col('deleted', 'datetime')],
      [],
      'mariadb',
    );
    const m = columnMatrix([base, extra], 'base');
    expect(m.rows.map((r) => r.column)).toEqual(['deleted']);
    expect(m.rows[0].cells[0].tone).toBe('absent');
    expect(m.rows[0].cells[1].tone).toBe('drift');
  });

  it('shows nothing for a member that did not finish', () => {
    const dead = { ...blankRun('other', 'mysql', 'mariadb'), status: 'error' as const };
    const m = columnMatrix([base, dead], 'base');
    expect(m.rows.every((r) => r.cells[1].tone === 'unknown')).toBe(true);
  });
});

describe('slowdown', () => {
  const at = (id: string, ms: number): MemberRun => ({ ...done(id, [col('id')], []), durationMs: ms });

  it('reports a member several times slower than the baseline', () => {
    expect(slowdown(at('other', 4784), at('base', 600))).toBeCloseTo(7.97, 1);
  });

  it('stays quiet about ordinary variation', () => {
    expect(slowdown(at('other', 700), at('base', 600))).toBeNull();
  });

  // A 10 ms baseline makes everything look catastrophic.
  it('stays quiet when the numbers are too small to mean anything', () => {
    expect(slowdown(at('other', 40), at('base', 5))).toBeNull();
  });

  it('has nothing to say about the baseline itself', () => {
    const b = at('base', 600);
    expect(slowdown(b, b)).toBeNull();
  });
});

describe('fanoutSummary counts the baseline too', () => {
  const dead = (id: string): MemberRun => ({
    ...blankRun(id, 'mysql', 'mariadb'),
    status: 'error',
    error: "Table 'acme.social_feed' doesn't exist",
  });

  // The screen said two members failed and the summary said one, because
  // the one it left out was the baseline.
  it('says the baseline failed, and how many others went with it', () => {
    expect(fanoutSummary([dead('base'), dead('other')], 'base')).toBe(
      '2 failed, the baseline among them — nothing to compare against.',
    );
  });

  it('calls out a baseline that failed alone', () => {
    const ok = done('other', [col('id')], [[1]]);
    expect(fanoutSummary([dead('base'), ok], 'base')).toBe(
      'The baseline failed — nothing to compare against.',
    );
  });

  it('still counts a failed member when the baseline is fine', () => {
    const base = done('base', [col('id')], [[1]]);
    expect(fanoutSummary([base, dead('other')], 'base')).toBe('1 failed');
  });
});

describe('inFlight', () => {
  it('counts everything that has not settled', () => {
    const at = (status: MemberRun['status']) => ({ ...blankRun(status, 'mysql'), status });
    const runs = [at('pending'), at('connecting'), at('running'), at('done'), at('error'), at('cancelled')];
    expect(inFlight(runs).map((r) => r.status)).toEqual(['pending', 'connecting', 'running']);
  });
});

describe('touchedTables', () => {
  const meta = (name: string, source: { schema: string | null; table: string } | null) => ({
    name,
    typeName: 'int',
    kind: 'int' as const,
    nullable: true,
    sourceTable: source ? { ...source, column: name } : null,
  });

  it('reads the tables off what the server attributed each column to', () => {
    // Never by parsing the statement: no parser can be as right as the
    // engine's own answer about where a column came from.
    expect(
      touchedTables([
        meta('id', { schema: 'acme', table: 'partner' }),
        meta('name', { schema: 'acme', table: 'partner' }),
        meta('panel_id', { schema: 'acme', table: 'panel_widget' }),
      ]),
    ).toEqual([
      { schema: 'acme', table: 'partner' },
      { schema: 'acme', table: 'panel_widget' },
    ]);
  });

  it('names nothing for a result nothing is attributable to', () => {
    // `select count(*)` reads a table and returns no column that belongs
    // to one. An empty list is the honest answer.
    expect(touchedTables([meta('count', null)])).toEqual([]);
  });

  it('folds case, because the server does not always agree with itself', () => {
    expect(
      touchedTables([
        meta('a', { schema: 'acme', table: 'Partner' }),
        meta('b', { schema: 'acme', table: 'partner' }),
      ]),
    ).toHaveLength(1);
  });
});
