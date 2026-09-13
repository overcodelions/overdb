import { describe, expect, it } from 'vitest';
import { redshiftPanels } from './postgres';

/// SVV_TABLE_INFO hands every number back as a string, which is why the
/// panels parse rather than compare.
function row(patch: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    sch: 'public',
    tbl: 'events',
    mb: '100',
    rows: '1000',
    unsorted: '0',
    stats_off: '0',
    skew_rows: '1.0',
    ...patch,
  };
}

describe('redshiftPanels', () => {
  it('says nothing about a cluster with nothing wrong', () => {
    expect(redshiftPanels([row(), row({ tbl: 'sales' })])).toEqual([]);
  });

  it('raises a table once it is worth vacuuming, and escalates', () => {
    const panels = redshiftPanels([
      row({ tbl: 'quiet', unsorted: '4' }),
      row({ tbl: 'stale', unsorted: '12' }),
      row({ tbl: 'bad', unsorted: '60' }),
    ]);
    const unsorted = panels.find((p) => p.key === 'redshift-unsorted');
    expect(unsorted?.rows.map((r) => r.label)).toEqual(['public.bad', 'public.stale']);
    expect(unsorted?.rows[0].tone).toBe('bad');
    expect(unsorted?.rows[1].tone).toBe('watch');
  });

  it('reads skew as a multiple of the average slice, not a percentage', () => {
    const panels = redshiftPanels([row({ tbl: 'lopsided', skew_rows: '3.4' })]);
    const skew = panels.find((p) => p.key === 'redshift-skew');
    expect(skew?.rows[0].value).toBe('3.4×');
    expect(skew?.rows[0].ratio).toBeCloseTo(0.85);
    expect(skew?.rows[0].tone).toBe('bad');
  });

  it('treats a number the cluster would not give as zero rather than NaN', () => {
    expect(redshiftPanels([row({ unsorted: null, stats_off: null, skew_rows: null })])).toEqual([]);
  });

  it('keeps each panel to what crosses its own threshold', () => {
    const panels = redshiftPanels([
      row({ tbl: 'a', unsorted: '30' }),
      row({ tbl: 'b', stats_off: '80' }),
    ]);
    expect(panels.map((p) => p.key)).toEqual(['redshift-unsorted', 'redshift-stats']);
    expect(panels[0].rows).toHaveLength(1);
    expect(panels[1].rows).toHaveLength(1);
  });
});
