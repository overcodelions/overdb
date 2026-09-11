import type { Cell, CellKind, ColumnMeta } from './types';

/// Turning a result set into a chart, decided here rather than in the view.
///
/// The whole module is pure and takes the same `ColumnMeta[]` + `Cell[][]`
/// the grid gets, for the usual reason: what is chartable is a question
/// about types and values, and answering it inside a React component means
/// it can only be checked by clicking.
///
/// Two things shape every decision below. First, driver type-parsing is
/// deliberately off (see src/db/adapters/*), so a `numeric` arrives as the
/// exact string the server sent and a `timestamptz` keeps its offset —
/// every value here is parsed from text, never assumed to be a JS number.
/// Second, a chart drawn from a capped grid is a chart of the rows that
/// arrived, not of the table; this module reports the counts that let the
/// view say so rather than quietly plotting a lie.

export type ChartType = 'line' | 'bar' | 'area' | 'scatter';

export interface ChartSpec {
  type: ChartType;
  /// Column index for the x axis, or null for "the row's position in the
  /// result" — which is honest only because the grid's order is the
  /// server's order.
  x: number | null;
  /// Column indices drawn as series. Always numeric columns.
  series: number[];
}

/// Eight is the categorical palette's length, and a ninth series is never a
/// generated colour: past this the extra columns are named as omitted so the
/// chart never claims to show more than it does.
export const MAX_SERIES = 8;

/// Scatter puts every series against every other, so its colours have to
/// separate in all pairs rather than just adjacent ones — which the palette
/// only guarantees for the first three slots.
export const MAX_SCATTER_SERIES = 3;

/// Beyond this a category axis is a smear of unreadable ticks. The chart
/// draws the first N and says how many it left out.
export const MAX_CATEGORIES = 400;

export function isNumericKind(kind: CellKind): boolean {
  return kind === 'int' || kind === 'bigint' || kind === 'float' || kind === 'decimal';
}

export function isTemporalKind(kind: CellKind): boolean {
  return kind === 'date' || kind === 'timestamp' || kind === 'timestamptz';
}

/// A cell as a number, or null when it is not one.
///
/// Strict on purpose: `'12 items'` is not 12, and a chart that reads it as
/// 12 is inventing data. Booleans are rejected too — a bar chart of true
/// and false is a count, and counting is the query's job, not ours.
export function numericValue(cell: Cell): number | null {
  if (cell === null) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  if (text === '') return null;
  // Number('') is 0 and Number(' ') is 0; both are handled above. Number
  // also accepts '0x10' and 'Infinity', neither of which a numeric column
  // produces and neither of which should silently become a point.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/// A cell as epoch millis, or null.
///
/// `Date.parse` is used for its ISO handling only — every temporal column
/// arrives as the server's own ISO string, and the offset in it is what
/// makes the parse unambiguous. A bare date ('2026-01-04') parses as UTC
/// midnight, which is what the server meant by it.
export function temporalValue(cell: Cell): number | null {
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  if (text === '') return null;
  // Postgres writes 'YYYY-MM-DD HH:MM:SS+00'; Date.parse wants a 'T' and a
  // two-digit offset. Normalising here is cheaper than a date library and
  // covers what the three engines actually emit. The offset fix is applied
  // only when there is a time at all — a bare '2026-01-04' ends in what
  // looks exactly like a two-digit offset, and "fixing" it produces
  // '2026-01-04:00', which parses as nothing.
  const withT = text.replace(' ', 'T');
  const iso = withT.includes(':') ? withT.replace(/([+-]\d{2})$/, '$1:00') : withT;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

function columnIndices(columns: ColumnMeta[], pred: (c: ColumnMeta) => boolean): number[] {
  const out: number[] = [];
  columns.forEach((c, i) => {
    if (pred(c)) out.push(i);
  });
  return out;
}

/// Does this column hold enough real values to be worth drawing?
///
/// A column typed `text` that happens to hold digits is still chartable, and
/// a column typed `numeric` that is entirely NULL is not. Types propose;
/// values decide.
function usableNumeric(rows: Cell[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    if (numericValue(row[index]) !== null && ++seen >= 2) return true;
  }
  return false;
}

function usableTemporal(rows: Cell[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    if (temporalValue(row[index]) !== null && ++seen >= 2) return true;
  }
  return false;
}

function strictlyOrdered(values: Array<number | null>): boolean {
  let last: number | null = null;
  let direction = 0;
  for (const v of values) {
    if (v === null) continue;
    if (last !== null) {
      const step = v - last;
      if (step === 0) continue;
      const sign = step > 0 ? 1 : -1;
      if (direction === 0) direction = sign;
      else if (direction !== sign) return false;
    }
    last = v;
  }
  return true;
}

/// Why this result cannot be charted, in a sentence, or null when it can.
///
/// Returned rather than thrown because the answer belongs on screen: an
/// empty chart panel with no explanation is the single most common way a
/// visualisation feature gets written off as broken.
export function chartRefusal(columns: ColumnMeta[], rows: Cell[][]): string | null {
  if (columns.length === 0) return 'Nothing to plot — this statement returned no columns.';
  if (rows.length === 0) return 'Nothing to plot — this statement returned no rows.';
  if (rows.length === 1) {
    return 'Nothing to plot — one row is a number, not a shape. Group by something to get a series.';
  }
  const numeric = columnIndices(columns, () => true).filter((i) => usableNumeric(rows, i));
  if (numeric.length === 0) {
    return 'Nothing to plot — no column in this result holds numbers. A chart needs a measure.';
  }
  return null;
}

/// The chart this result is asking for.
///
/// Picking it rather than making the user configure one is most of the
/// value: by the time you have chosen an axis and a series from two
/// dropdowns you could have read the grid. The proposal is a starting
/// point, not a verdict — every part of it is adjustable in the view.
export function proposeChart(columns: ColumnMeta[], rows: Cell[][]): ChartSpec | null {
  if (chartRefusal(columns, rows) !== null) return null;

  const numeric = columns
    .map((_, i) => i)
    .filter((i) => usableNumeric(rows, i));

  // A declared temporal column is the strongest signal there is: a time
  // column plus a measure is a time series, and nothing else it could be
  // is more likely.
  const temporal = columnIndices(columns, (c) => isTemporalKind(c.kind)).find((i) =>
    usableTemporal(rows, i),
  );
  if (temporal !== undefined) {
    const series = numeric.filter((i) => i !== temporal).slice(0, MAX_SERIES);
    if (series.length > 0) return { type: 'line', x: temporal, series };
  }

  // Next: one label column and one or more measures — `select status,
  // count(*) group by status`, which is the shape most analytical queries
  // land in. Bars, because the categories have no order to interpolate
  // across and a line between them would imply one.
  const label = columns.findIndex(
    (c, i) => !numeric.includes(i) && !isTemporalKind(c.kind) && c.kind !== 'bytes',
  );
  if (label >= 0) {
    const series = numeric.slice(0, MAX_SERIES);
    if (series.length > 0) return { type: 'bar', x: label, series };
  }

  // All numeric. If the first column runs in one direction it is an axis —
  // a bucket, an hour, a year — and the rest are measures against it.
  if (numeric.length >= 2) {
    const candidate = numeric[0];
    const values = rows.map((r) => numericValue(r[candidate]));
    const series = numeric.slice(1, MAX_SERIES + 1);
    return strictlyOrdered(values)
      ? { type: 'line', x: candidate, series }
      : { type: 'scatter', x: candidate, series: series.slice(0, MAX_SCATTER_SERIES) };
  }

  // A single measure and nothing to put it against: the row's position in
  // the result is the only x there is, and it is a real one as long as the
  // grid is showing the server's order.
  return { type: 'bar', x: null, series: numeric.slice(0, MAX_SERIES) };
}

export interface ChartSeries {
  name: string;
  /// Which result column this is, so the view can colour it by identity
  /// rather than by its position in a filtered list.
  column: number;
  values: Array<number | null>;
}

export interface ChartData {
  /// x positions, one per plotted row, in the order the rows arrived.
  xs: number[];
  /// What to write under each tick. For a category axis this is the cell's
  /// text; for the others it is a formatted number or time.
  labels: string[];
  xKind: 'time' | 'number' | 'category';
  series: ChartSeries[];
  /// Rows past MAX_CATEGORIES, which are not drawn.
  omittedRows: number;
  /// Series past the palette, named so the chart can say what it left out
  /// instead of silently dropping a column.
  omittedSeries: string[];
}

export function buildChartData(
  spec: ChartSpec,
  columns: ColumnMeta[],
  rows: Cell[][],
): ChartData {
  const xKind: ChartData['xKind'] =
    spec.x === null
      ? 'number'
      : isTemporalKind(columns[spec.x]?.kind ?? 'other') && usableTemporal(rows, spec.x)
        ? 'time'
        : usableNumeric(rows, spec.x)
          ? 'number'
          : 'category';

  // A category axis is drawn one band per row, so it is the only one with a
  // row budget: 400 bands is already past readable, and 100k would hang the
  // renderer. Continuous axes plot every row, because points overlapping is
  // information rather than a failure.
  const budget = xKind === 'category' ? MAX_CATEGORIES : rows.length;
  const drawn = rows.slice(0, budget);

  const xs: number[] = [];
  const labels: string[] = [];
  drawn.forEach((row, i) => {
    if (spec.x === null) {
      xs.push(i + 1);
      labels.push(String(i + 1));
      return;
    }
    const cell = row[spec.x];
    if (xKind === 'time') {
      const t = temporalValue(cell);
      xs.push(t ?? Number.NaN);
      labels.push(cell === null ? '∅' : String(cell));
    } else if (xKind === 'number') {
      const n = numericValue(cell);
      xs.push(n ?? Number.NaN);
      labels.push(n === null ? '∅' : formatNumber(n));
    } else {
      xs.push(i);
      labels.push(cell === null ? '∅' : cellText(cell));
    }
  });

  const cap = spec.type === 'scatter' ? MAX_SCATTER_SERIES : MAX_SERIES;
  const kept = spec.series.slice(0, cap);
  const omittedSeries = spec.series.slice(cap).map((i) => columns[i]?.name ?? `column ${i + 1}`);

  const series: ChartSeries[] = kept.map((column) => ({
    name: columns[column]?.name ?? `column ${column + 1}`,
    column,
    values: drawn.map((row) => numericValue(row[column])),
  }));

  return { xs, labels, xKind, series, omittedRows: rows.length - drawn.length, omittedSeries };
}

function cellText(cell: Cell): string {
  if (cell === null) return '∅';
  if (typeof cell === 'object') return 'binary';
  return String(cell);
}

/// Two series three orders of magnitude apart share one axis and the small
/// one is a flat line on the floor. The fix is two charts, not two axes —
/// so this says what happened rather than growing a second scale.
export function scaleWarning(series: ChartSeries[]): string | null {
  if (series.length < 2) return null;
  const spans = series.map((s) => {
    let max = 0;
    for (const v of s.values) {
      if (v !== null) max = Math.max(max, Math.abs(v));
    }
    return { name: s.name, max };
  });
  const real = spans.filter((s) => s.max > 0);
  if (real.length < 2) return null;
  const biggest = real.reduce((a, b) => (a.max > b.max ? a : b));
  const smallest = real.reduce((a, b) => (a.max < b.max ? a : b));
  if (biggest.max / smallest.max < 1000) return null;
  return `${smallest.name} is more than a thousand times smaller than ${biggest.name}, so it sits flat on the axis. Chart them separately to see it.`;
}

/// Round numbers at roughly `count` intervals, which is what an axis wants —
/// 0, 25, 50, 75, 100 rather than 0, 23.7, 47.4.
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  // The smallest of {1, 2, 5, 10} × magnitude that is still at least the
  // raw interval — so five ticks across 0..100 are 20 apart, not 50.
  const r = raw / magnitude;
  const step = (r > 5 ? 10 : r > 2 ? 5 : r > 1 ? 2 : 1) * magnitude;
  const out: number[] = [];
  // A tick loop driven by repeated addition drifts on floats; multiplying a
  // counter keeps every tick exactly on the step.
  const first = Math.ceil(min / step);
  for (let i = first; i * step <= max + step / 1e6; i++) out.push(i * step);
  return out;
}

/// Axis and tooltip numbers. Thousands get a separator, big ones get a
/// suffix, and anything below 1 keeps enough precision to be distinct.
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}k`;
  if (abs >= 1) return trim(n);
  if (abs === 0) return '0';
  return Number(n.toPrecision(3)).toString();
}

function trim(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/// A time tick, at whatever resolution the span justifies: a chart spanning
/// three years should not label every tick with a wall-clock time, and one
/// spanning ten minutes is unreadable without it.
export function formatTime(ms: number, spanMs: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (spanMs > 3 * 365 * 24 * 3600e3) return String(d.getFullYear());
  if (spanMs > 90 * 24 * 3600e3) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (spanMs > 2 * 24 * 3600e3) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (spanMs > 2 * 3600e3) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
