import { describe, expect, it } from 'vitest';
import { cellLabel, planDiff, scanKind, type MemberPlan } from './planDiff';
import type { PlanRow } from './plan';
import type { Engine } from './engines';

const step = (title: string, access: string, key?: string, rows = 100): PlanRow => ({
  depth: 0,
  title,
  access,
  key,
  rows,
});

const plan = (id: string, rows: PlanRow[], engine: Engine = 'mysql'): MemberPlan => ({
  connectionId: id,
  engine,
  rows,
  error: null,
});

describe('scanKind', () => {
  it('reads both engines’ full scans as full', () => {
    expect(scanKind(step('partner', 'ALL'))).toBe('full');
    expect(scanKind(step('Seq Scan on partner', 'Seq Scan'))).toBe('full');
  });

  // An index scan still reads the whole index.
  it('calls an unbounded index scan a full scan', () => {
    expect(scanKind(step('partner', 'index'))).toBe('full');
  });

  it('reads a primary-key hit as a lookup on either engine', () => {
    expect(scanKind(step('partner', 'eq_ref', 'PRIMARY'))).toBe('lookup');
    expect(scanKind(step('partner', 'const'))).toBe('lookup');
  });

  it('reads a bounded index read as a range', () => {
    expect(scanKind(step('partner', 'ref', 'IDX_PARTNER_ID'))).toBe('range');
    expect(scanKind(step('partner', 'Bitmap Heap Scan', 'idx'))).toBe('range');
  });
});

describe('planDiff', () => {
  const base = plan('base', [step('partner', 'ref', 'uq_partner_vanity'), step('client', 'eq_ref', 'PRIMARY')]);

  it('collapses the tables both members reach the same way', () => {
    const same = plan('other', [step('partner', 'ref', 'uq_partner_vanity'), step('client', 'eq_ref', 'PRIMARY')]);
    const d = planDiff([base, same], 'base');
    expect(d.rows).toEqual([]);
    expect(d.matching).toBe(2);
    expect(d.headline).toBeNull();
  });

  // The finding the whole module exists for.
  it('flags a member that scans where the baseline seeks', () => {
    const slow = plan('other', [step('partner', 'ALL'), step('client', 'eq_ref', 'PRIMARY')]);
    const d = planDiff([base, slow], 'base');
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].table).toBe('partner');
    expect(d.rows[0].cells[1].tone).toBe('worse');
    expect(d.headline).toBe('other reads all of partner, where the baseline narrows it with an index.');
  });

  // Plans carry connection ids; the headline has to name the server.
  it('names the member the way the reader knows it, not by its id', () => {
    const slow = plan('3f9c1d2e', [step('partner', 'ALL'), step('client', 'eq_ref', 'PRIMARY')]);
    const names: Record<string, string> = { base: 'orders-db (staging)', '3f9c1d2e': 'orders-db (prod-us)' };
    const d = planDiff([base, slow], 'base', (id) => names[id] ?? id);
    expect(d.headline).toBe('orders-db (prod-us) reads all of partner, where the baseline narrows it with an index.');
  });

  // A comparison that can only ever blame the far end is one you stop trusting.
  it('says when the member is the one doing less work', () => {
    const slowBase = plan('base', [step('partner', 'ALL')]);
    const fast = plan('other', [step('partner', 'ref', 'IDX_PARTNER')]);
    const d = planDiff([slowBase, fast], 'base');
    expect(d.rows[0].cells[1].tone).toBe('better');
    expect(d.headline).toBeNull();
  });

  it('notes the same access through a different index', () => {
    const other = plan('other', [step('partner', 'ref', 'IDX_OTHER'), step('client', 'eq_ref', 'PRIMARY')]);
    expect(planDiff([base, other], 'base').rows[0].cells[1].tone).toBe('differs');
  });

  it('marks a table one member never reads', () => {
    const short = plan('other', [step('partner', 'ref', 'uq_partner_vanity')]);
    const d = planDiff([base, short], 'base');
    expect(d.rows[0].table).toBe('client');
    expect(d.rows[0].cells[1].tone).toBe('absent');
  });

  it('shows nothing for a member whose explain failed', () => {
    const dead: MemberPlan = { connectionId: 'other', engine: 'mysql', rows: [], error: 'no such table' };
    const d = planDiff([base, dead], 'base');
    expect(d.rows.every((r) => r.cells[1].tone === 'unknown')).toBe(true);
  });

  it('compares across engines on how the table was reached', () => {
    const pg = plan('other', [step('Seq Scan on partner', 'Seq Scan')], 'postgres');
    const d = planDiff([base, pg], 'base');
    expect(d.rows[0].table).toBe('partner');
    expect(d.rows[0].cells[1].tone).toBe('worse');
  });

  it('leaves out steps that read no table', () => {
    const withNoise = plan('other', [
      step('partner', 'ref', 'uq_partner_vanity'),
      step('client', 'eq_ref', 'PRIMARY'),
      step('<materialized_subquery>', 'eq_ref', '<auto_key0>'),
    ]);
    expect(planDiff([base, withNoise], 'base').rows).toEqual([]);
  });

  it('puts the baseline first however the plans arrive', () => {
    const other = plan('other', [step('partner', 'ALL')]);
    expect(planDiff([other, base], 'base').members[0].connectionId).toBe('base');
  });
});

describe('cellLabel', () => {
  it('names the access and the index it used', () => {
    const d = planDiff([plan('base', [step('partner', 'ref', 'IDX_PARTNER')])], 'base');
    expect(cellLabel(d.rows[0]?.cells[0] ?? { memberId: 'base', access: 'ref', key: 'IDX_PARTNER', rows: 1, work: 1, kind: 'range', tone: 'baseline' })).toBe('ref · IDX_PARTNER');
  });

  it('does not print a temp-table key as though it were an index', () => {
    expect(
      cellLabel({ memberId: 'a', access: 'eq_ref', key: '<auto_key0>', rows: 1, work: 1, kind: 'lookup', tone: 'same' }),
    ).toBe('eq_ref · index built on the fly');
  });
});

describe('work and scale', () => {
  it('counts a one-row lookup performed many times as the work it is', () => {
    const looped: PlanRow = { depth: 0, title: 'partner', access: 'eq_ref', key: 'PRIMARY', rows: 1, loops: 28616 };
    const d = planDiff([plan('base', [step('partner', 'ALL', undefined, 100)]), plan('other', [looped])], 'base');
    expect(d.rows[0].cells[1].work).toBe(28616);
  });

  it('totals the whole plan, including steps that read no table', () => {
    const p = plan('base', [
      step('partner', 'ALL', undefined, 1000),
      { depth: 1, title: '<materialized_subquery>', access: 'eq_ref', rows: 5 },
    ]);
    expect(planDiff([p], 'base').totals.base).toBe(1005);
  });

  it('puts every bar on one scale', () => {
    const d = planDiff(
      [plan('base', [step('partner', 'ref', 'idx', 40)]), plan('other', [step('partner', 'ALL', undefined, 900000)])],
      'base',
    );
    expect(d.maxWork).toBe(900000);
  });
});
