import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Cell, ColumnMeta } from '@shared/types';
import {
  buildChartData,
  chartRefusal,
  formatNumber,
  formatTime,
  isTemporalKind,
  MAX_SCATTER_SERIES,
  MAX_SERIES,
  niceTicks,
  numericValue,
  proposeChart,
  scaleWarning,
  type ChartSpec,
  type ChartType,
} from '@shared/chartSpec';

/// The result set as a picture.
///
/// Drawn by hand in SVG rather than pulled from a chart library, for the
/// same reason the grid was: what a library gives you is configuration, and
/// what this needs is four mark types over data whose shape overdb already
/// knows. A dependency here would also have to be taught our theme tokens,
/// which is most of the work of drawing it.
///
/// Two rules run through the whole file. Colours are assigned by slot in a
/// fixed order and never cycled — the order is what keeps adjacent series
/// separable for a colour-blind reader, and a ninth series is named as
/// omitted rather than given a made-up hue. And a null is a gap, never a
/// zero: a line that dips to the floor where a measure is missing is a
/// claim the data does not make.

const MARGIN = { top: 14, right: 18, bottom: 34, left: 60 };
/// Eight validated slots; `chartSpec` caps the series count to match.
const SLOTS = 8;
const colour = (i: number) => `var(--series-${(i % SLOTS) + 1})`;

interface Hover {
  /// Index into the plotted rows.
  index: number;
  x: number;
  y: number;
}

export function ChartView({
  columns,
  rows,
  truncated,
}: {
  columns: ColumnMeta[];
  rows: Cell[][];
  /// Whether the grid stopped at the row cap. A chart of a capped result is
  /// a chart of the rows that arrived, and saying so is the difference
  /// between a partial answer and a wrong one.
  truncated: boolean;
}): JSX.Element {
  const refusal = useMemo(() => chartRefusal(columns, rows), [columns, rows]);
  const proposed = useMemo(() => proposeChart(columns, rows), [columns, rows]);
  const [spec, setSpec] = useState<ChartSpec | null>(proposed);

  // A new result is a new question: the axis you picked for the last one is
  // rarely the right one for this. Keyed on the column shape rather than the
  // rows, so streaming chunks do not reset the chart mid-arrival.
  const signature = columns.map((c) => `${c.name}:${c.kind}`).join('|');
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setSpec(proposed);
    } else if (spec === null && proposed !== null) {
      // The first chunk of a streaming result can be a single row, which is
      // not chartable; the second usually is.
      setSpec(proposed);
    }
  }, [signature, proposed, spec]);

  if (refusal !== null || spec === null) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p className="text-xs text-ink-muted">{refusal ?? 'Nothing to plot.'}</p>
        <p className="text-[11px] text-ink-faint">
          The rows are still in the table — this only changes how they are drawn.
        </p>
      </div>
    );
  }

  return <Chart columns={columns} rows={rows} spec={spec} setSpec={setSpec} truncated={truncated} />;
}

function Chart({
  columns,
  rows,
  spec,
  setSpec,
  truncated,
}: {
  columns: ColumnMeta[];
  rows: Cell[][];
  spec: ChartSpec;
  setSpec(spec: ChartSpec): void;
  truncated: boolean;
}): JSX.Element {
  const data = useMemo(() => buildChartData(spec, columns, rows), [spec, columns, rows]);
  const warning = useMemo(() => scaleWarning(data.series), [data.series]);

  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [hover, setHover] = useState<Hover | null>(null);

  const plotW = Math.max(0, size.w - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, size.h - MARGIN.top - MARGIN.bottom);

  // Bars and areas are read against the baseline, so their scale has to
  // include zero or the picture exaggerates every difference. Lines and
  // scatters are read against each other, so theirs does not.
  const zeroed = spec.type === 'bar' || spec.type === 'area';
  const { yMin, yMax } = useMemo(() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of data.series) {
      for (const v of s.values) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) return { yMin: 0, yMax: 1 };
    if (zeroed) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    // A perfectly flat series has no range to scale against; give it one so
    // it draws as a line through the middle rather than dividing by zero.
    if (lo === hi) return { yMin: lo - 1, yMax: hi + 1 };
    return { yMin: lo, yMax: hi };
  }, [data.series, zeroed]);

  const yTicks = useMemo(() => niceTicks(yMin, yMax, Math.max(2, Math.floor(plotH / 44))), [yMin, yMax, plotH]);
  const y = (v: number) => MARGIN.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const band = data.xKind === 'category' || spec.x === null;
  const { xMin, xSpan } = useMemo(() => {
    const finite = data.xs.filter(Number.isFinite);
    if (finite.length === 0) return { xMin: 0, xSpan: 1 };
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    return { xMin: lo, xSpan: hi === lo ? 1 : hi - lo };
  }, [data.xs]);

  const bandWidth = data.xs.length > 0 ? plotW / data.xs.length : plotW;
  const x = (i: number) =>
    band
      ? MARGIN.left + bandWidth * (i + 0.5)
      : MARGIN.left + ((data.xs[i] - xMin) / xSpan) * plotW;

  const numeric = useMemo(
    () => columns.map((_, i) => i).filter((i) => rows.some((r) => numericValue(r[i]) !== null)),
    [columns, rows],
  );

  const seriesCap = spec.type === 'scatter' ? MAX_SCATTER_SERIES : MAX_SERIES;

  return (
    <div className="h-full flex flex-col">
      <Controls
        columns={columns}
        numeric={numeric}
        spec={spec}
        setSpec={setSpec}
        seriesCap={seriesCap}
      />

      <div ref={boxRef} className="flex-1 min-h-0 relative">
        {size.w > 0 && size.h > 0 && (
          <svg
            width={size.w}
            height={size.h}
            role="img"
            aria-label={`${spec.type} chart of ${data.series.map((s) => s.name).join(', ')}`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - box.left;
              if (data.xs.length === 0) return;
              // Nearest band, or nearest point on a continuous axis. Hit
              // targets are the whole column of the plot rather than the
              // mark, so a 2px line is still easy to interrogate.
              let index = 0;
              if (band) {
                index = Math.min(
                  data.xs.length - 1,
                  Math.max(0, Math.floor((px - MARGIN.left) / bandWidth)),
                );
              } else {
                let best = Number.POSITIVE_INFINITY;
                data.xs.forEach((_, i) => {
                  const d = Math.abs(x(i) - px);
                  if (d < best) {
                    best = d;
                    index = i;
                  }
                });
              }
              setHover({ index, x: e.clientX - box.left, y: e.clientY - box.top });
            }}
          >
            {/* Grid first, and recessive: it is a reading aid, not data. */}
            {yTicks.map((t) => (
              <g key={t}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--c-rule)"
                  strokeWidth={1}
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(t) + 3}
                  textAnchor="end"
                  className="fill-ink-faint text-[10px] tabular-nums"
                >
                  {formatNumber(t)}
                </text>
              </g>
            ))}
            {/* The zero line, when zero is inside the range and is not
                already the axis floor — a bar chart with negatives is
                unreadable without it. */}
            {yMin < 0 && yMax > 0 && (
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(0)}
                y2={y(0)}
                stroke="rgb(var(--c-ink-faint) / 0.55)"
                strokeWidth={1}
              />
            )}

            <XAxis
              data={data}
              band={band}
              bandWidth={bandWidth}
              x={x}
              plotW={plotW}
              plotH={plotH}
              xSpan={xSpan}
            />

            {spec.type === 'bar' && (
              <Bars data={data} bandWidth={bandWidth} x={x} y={y} yFloor={y(Math.max(0, yMin))} />
            )}
            {(spec.type === 'line' || spec.type === 'area') && (
              <Lines data={data} spec={spec} x={x} y={y} baseline={y(zeroed ? 0 : yMin)} />
            )}
            {spec.type === 'scatter' && <Dots data={data} x={x} y={y} />}

            {hover !== null && (
              <line
                x1={x(hover.index)}
                x2={x(hover.index)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                stroke="rgb(var(--c-ink-faint) / 0.5)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
          </svg>
        )}

        {hover !== null && (
          <Tooltip data={data} hover={hover} width={size.w} height={size.h} />
        )}
      </div>

      <Footer data={data} warning={warning} truncated={truncated} rowCount={rows.length} />
    </div>
  );
}

/// The x axis, labelled at whatever density fits.
///
/// Ticks are thinned rather than rotated: a wall of 45° text is how a chart
/// stops being readable, and the tooltip already names the point exactly.
function XAxis({
  data,
  band,
  bandWidth,
  x,
  plotW,
  plotH,
  xSpan,
}: {
  data: ReturnType<typeof buildChartData>;
  band: boolean;
  bandWidth: number;
  x(i: number): number;
  plotW: number;
  plotH: number;
  xSpan: number;
}): JSX.Element {
  const baseline = MARGIN.top + plotH;
  const n = data.xs.length;
  if (n === 0) return <g />;

  // Roughly one label per 72px, so they never touch.
  const wanted = Math.max(2, Math.floor(plotW / 72));
  const stride = Math.max(1, Math.ceil(n / wanted));

  const label = (i: number) =>
    data.xKind === 'time' ? formatTime(data.xs[i], xSpan) : data.labels[i];

  return (
    <g>
      <line
        x1={MARGIN.left}
        x2={MARGIN.left + plotW}
        y1={baseline}
        y2={baseline}
        stroke="var(--c-card-border)"
        strokeWidth={1}
      />
      {data.xs.map((_, i) =>
        i % stride === 0 ? (
          <text
            key={i}
            x={x(i)}
            y={baseline + 15}
            textAnchor="middle"
            className="fill-ink-faint text-[10px]"
          >
            {clip(label(i), Math.max(6, Math.floor((band ? bandWidth * stride : 72) / 6)))}
          </text>
        ) : null,
      )}
    </g>
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/// Grouped bars, with a 2px gap between neighbours so two adjacent series
/// never read as one wide block, and rounded ends at the data end only —
/// the baseline end stays square because it is an anchor, not a value.
function Bars({
  data,
  bandWidth,
  x,
  y,
  yFloor,
}: {
  data: ReturnType<typeof buildChartData>;
  bandWidth: number;
  x(i: number): number;
  y(v: number): number;
  yFloor: number;
}): JSX.Element {
  const count = Math.max(1, data.series.length);
  const slot = bandWidth / count;
  const width = Math.max(1, slot - 2);
  const r = Math.min(4, width / 2);

  return (
    <g>
      {data.series.map((s, si) =>
        s.values.map((v, i) => {
          if (v === null) return null;
          const left = x(i) - bandWidth / 2 + si * slot + 1;
          const top = Math.min(y(v), yFloor);
          const height = Math.abs(y(v) - yFloor);
          if (height < 0.5) return null;
          const up = y(v) <= yFloor;
          return (
            <path
              key={`${si}:${i}`}
              d={roundedBar(left, top, width, height, r, up)}
              fill={colour(si)}
            />
          );
        }),
      )}
    </g>
  );
}

/// A bar with only its data end rounded. Negative bars round downward, so
/// the rounding always marks the value rather than the axis.
function roundedBar(
  left: number,
  top: number,
  w: number,
  h: number,
  r: number,
  up: boolean,
): string {
  const radius = Math.min(r, h);
  const right = left + w;
  const bottom = top + h;
  return up
    ? `M${left},${bottom} L${left},${top + radius} Q${left},${top} ${left + radius},${top} L${right - radius},${top} Q${right},${top} ${right},${top + radius} L${right},${bottom} Z`
    : `M${left},${top} L${left},${bottom - radius} Q${left},${bottom} ${left + radius},${bottom} L${right - radius},${bottom} Q${right},${bottom} ${right},${bottom - radius} L${right},${top} Z`;
}

/// Lines, and areas under them.
///
/// A null breaks the path rather than being interpolated across: joining
/// the two sides of a gap draws a measurement that was never taken.
function Lines({
  data,
  spec,
  x,
  y,
  baseline,
}: {
  data: ReturnType<typeof buildChartData>;
  spec: ChartSpec;
  x(i: number): number;
  y(v: number): number;
  baseline: number;
}): JSX.Element {
  const runs = (values: Array<number | null>): number[][] => {
    const out: number[][] = [];
    let current: number[] = [];
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(x(i))) {
        if (current.length > 0) out.push(current);
        current = [];
      } else current.push(i);
    });
    if (current.length > 0) out.push(current);
    return out;
  };

  // Direct labels up to four series; past that the legend carries identity
  // on its own and end-labels would collide.
  const direct = data.series.length <= 4;

  return (
    <g>
      {data.series.map((s, si) => {
        const segments = runs(s.values);
        const last = segments.at(-1)?.at(-1);
        return (
          <g key={s.column}>
            {spec.type === 'area' &&
              segments.map((run, ri) => (
                <path
                  key={`a${ri}`}
                  d={`M${x(run[0])},${baseline} ${run.map((i) => `L${x(i)},${y(s.values[i] as number)}`).join(' ')} L${x(run.at(-1) as number)},${baseline} Z`}
                  fill={colour(si)}
                  opacity={0.16}
                />
              ))}
            {segments.map((run, ri) => (
              <path
                key={`l${ri}`}
                d={run.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i)},${y(s.values[i] as number)}`).join(' ')}
                fill="none"
                stroke={colour(si)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {/* A single point has no line to be; without this a one-row
                series after a gap draws nothing at all. */}
            {segments
              .filter((run) => run.length === 1)
              .map((run) => (
                <circle
                  key={`p${run[0]}`}
                  cx={x(run[0])}
                  cy={y(s.values[run[0]] as number)}
                  r={4}
                  fill={colour(si)}
                  stroke="rgb(var(--c-surface))"
                  strokeWidth={2}
                />
              ))}
            {direct && last !== undefined && (
              <text
                x={x(last) + 6}
                y={y(s.values[last] as number) + 3}
                className="fill-ink-muted text-[10px]"
              >
                {s.name}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/// Points, ringed in the surface colour so overlapping marks stay countable
/// rather than merging into a blob.
function Dots({
  data,
  x,
  y,
}: {
  data: ReturnType<typeof buildChartData>;
  x(i: number): number;
  y(v: number): number;
}): JSX.Element {
  return (
    <g>
      {data.series.map((s, si) =>
        s.values.map((v, i) =>
          v === null || !Number.isFinite(x(i)) ? null : (
            <circle
              key={`${si}:${i}`}
              cx={x(i)}
              cy={y(v)}
              r={4}
              fill={colour(si)}
              stroke="rgb(var(--c-surface))"
              strokeWidth={2}
              opacity={0.9}
            />
          ),
        ),
      )}
    </g>
  );
}

/// What the crosshair is over, exactly.
///
/// Values are shown as they arrived, not as the axis formats them: the axis
/// says 12.35k because it has 40px, and the tooltip is where you go to find
/// out it was 12,348.
function Tooltip({
  data,
  hover,
  width,
  height,
}: {
  data: ReturnType<typeof buildChartData>;
  hover: Hover;
  width: number;
  height: number;
}): JSX.Element {
  const flip = hover.x > width - 200;
  const label = data.labels[hover.index] ?? '';
  return (
    <div
      className="absolute z-10 pointer-events-none rounded border border-card bg-surface-elevated px-2.5 py-1.5 shadow-lg"
      style={{
        left: flip ? undefined : hover.x + 14,
        right: flip ? width - hover.x + 14 : undefined,
        top: Math.min(Math.max(8, hover.y - 20), Math.max(8, height - 24 * data.series.length - 40)),
      }}
    >
      <p className="text-[10px] text-ink-faint mb-1 max-w-[220px] truncate">{label}</p>
      {data.series.map((s, si) => {
        const v = s.values[hover.index];
        return (
          <p key={s.column} className="flex items-center gap-1.5 text-[11px] leading-5">
            <span
              className="w-2 h-2 rounded-sm shrink-0"
              style={{ background: colour(si) }}
              aria-hidden
            />
            <span className="text-ink-muted max-w-[140px] truncate">{s.name}</span>
            <span className="ml-auto text-ink tabular-nums font-mono">
              {/* A gap is reported as a gap. Showing 0 here would be the
                  same lie the line deliberately does not tell. */}
              {v === null ? <span className="text-ink-faint">no value</span> : v.toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/// The legend, plus everything the chart is not showing.
function Footer({
  data,
  warning,
  truncated,
  rowCount,
}: {
  data: ReturnType<typeof buildChartData>;
  warning: string | null;
  truncated: boolean;
  rowCount: number;
}): JSX.Element {
  return (
    <div className="shrink-0 border-t border-card px-3.5 py-2 flex flex-col gap-1.5">
      {/* Always present for two or more series: identity must never rest on
          colour alone. One series needs no box — the axis and the controls
          already name it. */}
      {data.series.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {data.series.map((s, si) => (
            <span key={s.column} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span
                className="w-2.5 h-2.5 rounded-sm"
                style={{ background: colour(si) }}
                aria-hidden
              />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 text-[10px] text-ink-faint">
        <span>
          {rowCount.toLocaleString()} row{rowCount === 1 ? '' : 's'}
          {truncated && ' (capped)'}
        </span>
        {truncated && (
          <span className="text-warn/90">
            This is the shape of the rows that arrived, not of the table. Raise the row cap or
            aggregate in SQL before reading a trend off it.
          </span>
        )}
        {data.omittedRows > 0 && (
          <span>
            {data.omittedRows.toLocaleString()} more categories not drawn — an axis that wide is
            not readable.
          </span>
        )}
        {data.omittedSeries.length > 0 && (
          <span>Not drawn: {data.omittedSeries.join(', ')}.</span>
        )}
        {warning !== null && <span className="text-warn/90">{warning}</span>}
      </div>
    </div>
  );
}

const TYPES: Array<{ type: ChartType; label: string; title: string }> = [
  { type: 'line', label: 'Line', title: 'A measure over an ordered axis' },
  { type: 'bar', label: 'Bar', title: 'A measure per category, read against zero' },
  { type: 'area', label: 'Area', title: 'A line with the space under it filled — read against zero' },
  { type: 'scatter', label: 'Scatter', title: 'One measure against another, with no line implied' },
];

function Controls({
  columns,
  numeric,
  spec,
  setSpec,
  seriesCap,
}: {
  columns: ColumnMeta[];
  numeric: number[];
  spec: ChartSpec;
  setSpec(spec: ChartSpec): void;
  seriesCap: number;
}): JSX.Element {
  const atCap = spec.series.length >= seriesCap;
  return (
    <div className="shrink-0 border-b border-card px-3.5 py-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <div className="flex items-center gap-px">
        {TYPES.map((t) => (
          <button
            key={t.type}
            title={t.title}
            onClick={() => {
              // Switching to scatter can exceed its tighter colour budget;
              // trimming here keeps the spec honest rather than letting the
              // view silently drop what the controls still show as on.
              const series = t.type === 'scatter' ? spec.series.slice(0, MAX_SCATTER_SERIES) : spec.series;
              setSpec({ ...spec, type: t.type, series });
            }}
            className={`px-2 py-0.5 text-[11px] rounded ${
              spec.type === t.type
                ? 'bg-accent/20 text-ink'
                : 'text-ink-faint hover:text-ink-muted hover:bg-card'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        x
        <select
          value={spec.x === null ? '' : String(spec.x)}
          onChange={(e) => setSpec({ ...spec, x: e.target.value === '' ? null : Number(e.target.value) })}
          className="bg-surface-muted border border-card rounded px-1.5 py-0.5 text-[11px] text-ink max-w-[180px]"
        >
          <option value="">row number</option>
          {columns.map((c, i) => (
            <option key={i} value={i}>
              {c.name}
              {isTemporalKind(c.kind) ? ' (time)' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {numeric.map((i) => {
          const on = spec.series.includes(i);
          const slot = spec.series.indexOf(i);
          return (
            <button
              key={i}
              disabled={!on && atCap}
              title={
                !on && atCap
                  ? `${seriesCap} series is the colour budget — turn one off first.`
                  : undefined
              }
              onClick={() =>
                setSpec({
                  ...spec,
                  series: on ? spec.series.filter((s) => s !== i) : [...spec.series, i],
                })
              }
              className={`flex items-center gap-1.5 text-[11px] ${
                on ? 'text-ink' : 'text-ink-faint hover:text-ink-muted disabled:opacity-40'
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-sm border border-card"
                style={{ background: on ? colour(slot) : 'transparent' }}
                aria-hidden
              />
              {columns[i]?.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
