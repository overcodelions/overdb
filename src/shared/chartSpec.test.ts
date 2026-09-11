import { describe, expect, it } from 'vitest';
import type { Cell, CellKind, ColumnMeta } from './types';
import {
  buildChartData,
  chartRefusal,
  formatNumber,
  formatTime,
  niceTicks,
  numericValue,
  proposeChart,
  scaleWarning,
  temporalValue,
} from './chartSpec';

function col(name: string, kind: CellKind, typeName = kind): ColumnMeta {
  return { name, kind, typeName, nullable: true, sourceTable: null };
}

describe('numericValue', () => {
  it('reads the exact strings the drivers hand back', () => {
    // Type parsing is off, so a numeric column arrives as text and a chart
    // that only accepted JS numbers would plot nothing at all.
    expect(numericValue('1234.5678')).toBe(1234.5678);
    expect(numericValue('-0.5')).toBe(-0.5);
    expect(numericValue('1e3')).toBe(1000);
  });

  it('refuses text that merely starts with a number', () => {
    // Number('12 items') is NaN but parseFloat would say 12 — inventing a
    // point out of a label is worse than drawing nothing.
    expect(numericValue('12 items')).toBeNull();
    expect(numericValue('')).toBeNull();
    expect(numericValue('  ')).toBeNull();
    expect(numericValue('0x10')).toBeNull();
    expect(numericValue('Infinity')).toBeNull();
    expect(numericValue(null)).toBeNull();
  });

  it('refuses booleans', () => {
    // A bar chart of true and false is a count, and counting is the
    // query's job.
    expect(numericValue(true)).toBeNull();
  });
});

describe('temporalValue', () => {
  it("keeps the server's offset", () => {
    expect(temporalValue('2026-01-04T12:00:00+00:00')).toBe(Date.parse('2026-01-04T12:00:00Z'));
  });

  it('parses the space-separated form Postgres emits', () => {
    expect(temporalValue('2026-01-04 12:00:00+00')).toBe(Date.parse('2026-01-04T12:00:00Z'));
  });

  it('reads a bare date as the server meant it', () => {
    expect(temporalValue('2026-01-04')).toBe(Date.parse('2026-01-04'));
  });

  it('is null for anything that is not a time', () => {
    expect(temporalValue('yesterday')).toBeNull();
    expect(temporalValue(42)).toBeNull();
  });
});

describe('chartRefusal', () => {
  it('says why rather than showing an empty panel', () => {
    expect(chartRefusal([], [])).toMatch(/no columns/);
    expect(chartRefusal([col('a', 'int')], [])).toMatch(/no rows/);
    expect(chartRefusal([col('a', 'int')], [[1]])).toMatch(/one row/);
    expect(chartRefusal([col('a', 'text')], [['x'], ['y']])).toMatch(/no column .* holds numbers/);
  });

  it('allows a numeric-looking text column', () => {
    // Types propose, values decide: `count(*)` comes back as text on some
    // drivers, and refusing it would refuse the commonest query there is.
    expect(chartRefusal([col('n', 'text')], [['1'], ['2']])).toBeNull();
  });

  it('refuses a numeric column that is entirely null', () => {
    expect(chartRefusal([col('n', 'int')], [[null], [null]])).toMatch(/holds numbers/);
  });
});

describe('proposeChart', () => {
  it('makes a time column the axis and draws a line', () => {
    const columns = [col('day', 'date'), col('signups', 'int'), col('churn', 'int')];
    const rows: Cell[][] = [
      ['2026-01-01', 5, 1],
      ['2026-01-02', 8, 2],
    ];
    expect(proposeChart(columns, rows)).toEqual({ type: 'line', x: 0, series: [1, 2] });
  });

  it('turns a group-by into bars', () => {
    const columns = [col('status', 'text'), col('n', 'bigint')];
    const rows: Cell[][] = [
      ['active', '12'],
      ['closed', '4'],
    ];
    expect(proposeChart(columns, rows)).toEqual({ type: 'bar', x: 0, series: [1] });
  });

  it('reads an ordered numeric first column as an axis', () => {
    const columns = [col('hour', 'int'), col('requests', 'int')];
    const rows: Cell[][] = [
      [0, 100],
      [1, 140],
      [2, 90],
    ];
    expect(proposeChart(columns, rows)).toEqual({ type: 'line', x: 0, series: [1] });
  });

  it('scatters two unordered measures rather than joining them with a line', () => {
    // A line between points whose x jumps around draws a path through the
    // result's row order, which means nothing.
    const columns = [col('price', 'float'), col('qty', 'int')];
    const rows: Cell[][] = [
      [9.5, 3],
      [2.0, 8],
      [7.5, 1],
    ];
    expect(proposeChart(columns, rows)).toEqual({ type: 'scatter', x: 0, series: [1] });
  });

  it('falls back to row position for a lone measure', () => {
    const columns = [col('n', 'int')];
    const rows: Cell[][] = [[1], [2], [3]];
    expect(proposeChart(columns, rows)).toEqual({ type: 'bar', x: null, series: [0] });
  });

  it('is null exactly when there is a refusal', () => {
    expect(proposeChart([col('a', 'text')], [['x'], ['y']])).toBeNull();
  });
});

describe('buildChartData', () => {
  const columns = [col('day', 'date'), col('signups', 'int')];
  const rows: Cell[][] = [
    ['2026-01-01', 5],
    ['2026-01-02', null],
    ['2026-01-03', 9],
  ];

  it('keeps a null as a gap, not a zero', () => {
    // Plotting a missing measure as zero is the difference between "we did
    // not record it" and "it was none", and only one of those is true.
    const data = buildChartData({ type: 'line', x: 0, series: [1] }, columns, rows);
    expect(data.series[0].values).toEqual([5, null, 9]);
    expect(data.xKind).toBe('time');
  });

  it('bands a category axis by row position and labels it with the cell', () => {
    const cat = [col('status', 'text'), col('n', 'int')];
    const data = buildChartData({ type: 'bar', x: 0, series: [1] }, cat, [
      ['active', 3],
      ['closed', 4],
    ]);
    expect(data.xKind).toBe('category');
    expect(data.xs).toEqual([0, 1]);
    expect(data.labels).toEqual(['active', 'closed']);
  });

  it('names the series it dropped past the palette', () => {
    const many = Array.from({ length: 10 }, (_, i) => col(`m${i}`, 'int'));
    const manyRows: Cell[][] = [Array(10).fill(1), Array(10).fill(2)];
    const data = buildChartData(
      { type: 'line', x: null, series: many.map((_, i) => i) },
      many,
      manyRows,
    );
    expect(data.series).toHaveLength(8);
    expect(data.omittedSeries).toEqual(['m8', 'm9']);
  });

  it('caps a scatter at three series, where the palette separates in all pairs', () => {
    const many = Array.from({ length: 5 }, (_, i) => col(`m${i}`, 'float'));
    const manyRows: Cell[][] = [Array(5).fill(1), Array(5).fill(2)];
    const data = buildChartData(
      { type: 'scatter', x: 0, series: [1, 2, 3, 4] },
      many,
      manyRows,
    );
    expect(data.series).toHaveLength(3);
    expect(data.omittedSeries).toEqual(['m4']);
  });

  it('reports the rows a category axis could not draw', () => {
    const cat = [col('k', 'text'), col('n', 'int')];
    const many: Cell[][] = Array.from({ length: 500 }, (_, i) => [`k${i}`, i]);
    const data = buildChartData({ type: 'bar', x: 0, series: [1] }, cat, many);
    expect(data.xs).toHaveLength(400);
    expect(data.omittedRows).toBe(100);
  });

  it('plots every row on a continuous axis', () => {
    const nums = [col('x', 'float'), col('y', 'float')];
    const many: Cell[][] = Array.from({ length: 500 }, (_, i) => [i, i * 2]);
    const data = buildChartData({ type: 'line', x: 0, series: [1] }, nums, many);
    expect(data.xs).toHaveLength(500);
    expect(data.omittedRows).toBe(0);
  });
});

describe('scaleWarning', () => {
  it('names the series that is flat against the axis', () => {
    const warning = scaleWarning([
      { name: 'bytes', column: 0, values: [1e9, 2e9] },
      { name: 'errors', column: 1, values: [1, 2] },
    ]);
    expect(warning).toMatch(/errors/);
    expect(warning).toMatch(/bytes/);
  });

  it('is quiet when the series are comparable', () => {
    expect(
      scaleWarning([
        { name: 'a', column: 0, values: [10, 20] },
        { name: 'b', column: 1, values: [15, 25] },
      ]),
    ).toBeNull();
  });

  it('is quiet for one series', () => {
    expect(scaleWarning([{ name: 'a', column: 0, values: [1, 1e9] }])).toBeNull();
  });
});

describe('niceTicks', () => {
  it('lands on round numbers', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('does not drift on floats', () => {
    // Repeated addition gives 0.30000000000000004; a multiplied counter
    // does not, and an axis labelled that way looks broken.
    const ticks = niceTicks(0, 1, 5);
    expect(ticks).toHaveLength(6);
    expect(ticks[3]).toBe(3 * 0.2);
    expect(ticks[3]).toBeCloseTo(0.6, 10);
  });

  it('handles a flat series', () => {
    expect(niceTicks(7, 7)).toEqual([7]);
  });
});

describe('formatNumber', () => {
  it('suffixes the big ones and keeps the small ones distinct', () => {
    expect(formatNumber(1_500_000)).toBe('1.5M');
    expect(formatNumber(12_345)).toBe('12.35k');
    expect(formatNumber(0.00123)).toBe('0.00123');
    expect(formatNumber(0)).toBe('0');
  });
});

describe('formatTime', () => {
  const t = Date.parse('2026-01-04T09:05:06Z');

  it('labels at the resolution the span justifies', () => {
    expect(formatTime(t, 5 * 365 * 24 * 3600e3)).toBe('2026');
    expect(formatTime(t, 120 * 24 * 3600e3)).toBe('2026-01');
  });
});
