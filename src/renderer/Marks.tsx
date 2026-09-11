/// The marks the health and slow-query panes are drawn from.
///
/// Shared rather than inlined in the two panes because the rules they
/// encode are claims about reading a chart, not about either pane: a bar
/// is scaled to the largest row anybody can SEE, a segment never vanishes
/// below four pixels, a ratio gets the band it actually moves in rather
/// than nought to a hundred, and a series drawn from polls this window
/// made says so out loud.
///
/// Every colour here comes through `currentColor` from a Tailwind text
/// class the caller passes. That is not a style preference — it is what
/// keeps the tone `readings()` computed, the number it coloured, and the
/// mark beside it from ever disagreeing.

/// A number against the ceiling it will hit, with the thresholds that
/// decide its tone drawn where they actually are.
///
/// The two hairlines are the point. A bar at 72% is meaningless on its
/// own; a bar at 72% with the line where new connections start being
/// refused is a thing you can act on before it happens.
export function CapacityBar({
  ratio,
  tone,
  thresholds = [],
}: {
  /// 0..1. Clamped, because a server reporting more sessions than its own
  /// maximum is a real thing (superuser reservations) and an overflowing
  /// div is not how to say it.
  ratio: number;
  /// Tailwind text class — the fill is `currentColor`.
  tone: string;
  /// Fractions of the track, each with a label for the axis beneath.
  thresholds?: Array<{ at: number; label: string; danger?: boolean }>;
}): JSX.Element {
  const width = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-wash-strong">
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-700 ease-out ${tone}`}
          style={{ width: `${width}%` }}
        />
        {thresholds.map((t) => (
          <div
            key={t.label}
            className={`absolute -top-0.5 -bottom-0.5 w-px ${t.danger ? 'bg-bad/60' : 'bg-ink-faint/50'}`}
            style={{ left: `${Math.max(0, Math.min(1, t.at)) * 100}%` }}
          />
        ))}
      </div>
      {thresholds.length > 0 && (
        // Positioned at the fraction each one marks, not spaced evenly.
        // A label reading "refused at 900" sitting anywhere other than
        // under the line it names is worse than no label: it puts the
        // ceiling somewhere the ceiling is not.
        <div className="relative mt-1 h-3 text-[9px] text-ink-faint">
          <span className="absolute left-0 top-0">0</span>
          {thresholds.map((t) => (
            <span
              key={t.label}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${Math.max(0, Math.min(1, t.at)) * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/// A series built from the reads this pane has already made.
///
/// Both engines answer every one of these questions with a snapshot and
/// keep no history at all, so there is no last hour to draw — only however
/// long you have been looking. That is why the caller is expected to put
/// the caption underneath, and why this will not render a single point as
/// a line: one sample is not a trend, and drawing it flat implies it is.
export function Sparkline({
  series,
  tone,
  band,
  height = 28,
}: {
  series: number[];
  /// Tailwind text class — stroke and fill are `currentColor`.
  tone: string;
  /// The domain to draw against. A ratio that lives between 95% and 100%
  /// is a flat line on a 0..1 axis, which hides the only movement there
  /// is. Omitted, the domain is taken from the data with a little room.
  band?: [number, number];
  height?: number;
}): JSX.Element {
  if (series.length < 2) {
    return (
      <div className="flex items-end text-[9px] text-ink-faint" style={{ height }}>
        waiting for a second reading
      </div>
    );
  }

  const [lo, hi] = band ?? autoBand(series);
  const span = hi - lo || 1;
  // A 100-wide box stretched to the element's width: the marks are scaled
  // non-uniformly on purpose, and the stroke is exempted from it so a wide
  // card does not draw a fat line.
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * 100;
    const y = 2 + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / span) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      className={`block w-full ${tone}`}
      height={height}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon
        points={`0,${height} ${points.join(' ')} 100,${height}`}
        fill="currentColor"
        opacity="0.12"
      />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/// Pad a flat series so it does not draw as a line pinned to one edge.
function autoBand(series: number[]): [number, number] {
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.15;
  return [lo - pad, hi + pad];
}

export interface Segment {
  key: string;
  label: string;
  count: number;
  /// Tailwind text class — the fill is `currentColor`.
  tone: string;
}

/// How a total divides up, with a legend that carries the counts.
///
/// The minimum width is load-bearing rather than cosmetic. On a healthy
/// pool idle really is ninety-odd percent, and letting it dominate is the
/// honest picture — but the two sessions stuck on a lock are the reason
/// anybody opened this pane, and at true scale they are a third of a
/// pixel. So they are drawn at four, and the legend carries the real
/// number.
export function StateMeter({ segments, total }: { segments: Segment[]; total: number }): JSX.Element {
  const sum = total || segments.reduce((a, s) => a + s.count, 0) || 1;
  return (
    <div>
      <div className="flex gap-0.5 h-2">
        {segments.map((s) => (
          <div
            key={s.key}
            className={`rounded-[2px] bg-current transition-[width] duration-700 ease-out ${s.tone}`}
            style={{
              width: `${(s.count / sum) * 100}%`,
              minWidth: s.count > 0 ? 4 : 0,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[10px] text-ink-faint">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`w-[5px] h-[5px] rounded-full bg-current ${s.tone}`} />
            {s.label} <span className="tabular-nums text-ink">{s.count.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/// One measure cut in two, drawn against the largest row in the list.
///
/// One hue at two steps rather than two colours, because rows and indexes
/// are halves of a size and not two categories — and a table carrying more
/// index than row is the single most useful thing this panel can show you,
/// which the old four-column table buried in a text suffix.
export function SplitBar({
  primary,
  secondary,
  scale,
}: {
  primary: number;
  secondary: number | null;
  /// The largest total in the visible list. Never a server-wide total: a
  /// bar drawn against rows nobody can see is a proportion of nothing.
  scale: number;
}): JSX.Element {
  const max = scale || 1;
  return (
    <div className="flex-1 flex gap-0.5 h-[7px] min-w-0">
      <div
        className="bg-accent rounded-[2px] transition-[width] duration-700 ease-out"
        style={{ width: `${Math.min(100, (primary / max) * 100)}%` }}
      />
      {secondary !== null && secondary > 0 && (
        <div
          className="bg-accent/40 rounded-[2px] transition-[width] duration-700 ease-out"
          style={{ width: `${Math.min(100, (secondary / max) * 100)}%` }}
        />
      )}
      <div className="flex-1" />
    </div>
  );
}

/// A ranked count with its bar under it.
///
/// Always scaled to the largest row shown, for the same reason SplitBar
/// is: these lists are a top N, and the rows below the cut are not
/// available to be a denominator.
export function BarRow({
  label,
  value,
  ratio,
  tone = 'text-accent',
  note,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  ratio: number;
  tone?: string;
  note?: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      {/* The label takes the tone only when the tone MEANS something. A
          lock wait should read red in its own words; an ordinary row
          should not be tinted by the colour its bar happens to use. */}
      <div className={`flex justify-between gap-3 text-[10px] ${tone === 'text-accent' ? 'text-ink-muted' : tone}`}>
        <span className="min-w-0 truncate">{label}</span>
        <span className="tabular-nums shrink-0">{value}</span>
      </div>
      <div className="mt-1 h-[5px] rounded-full bg-wash-strong">
        <div
          className={`h-[5px] rounded-full bg-current transition-[width] duration-700 ease-out ${tone}`}
          style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, minWidth: ratio > 0 ? 5 : 0 }}
        />
      </div>
      {note && <p className="mt-0.5 text-[9px] text-ink-faint">{note}</p>}
    </div>
  );
}

/// What proportion of the server's time the few statements above actually
/// account for — including the tail nobody is looking at.
///
/// The grey remainder is the number that decides your afternoon: a top
/// three holding sixty percent is an afternoon well spent, and a top three
/// holding four percent means the cost is spread across two hundred
/// statements and there is no top three.
export function ShareStrip({
  shares,
  rest,
  labelled = 3,
}: {
  shares: number[];
  rest: number;
  /// How many segments carry their percentage inside them. Every segment
  /// labelled is a row of unreadable numbers; none labelled is a bar
  /// nobody can read a value off.
  labelled?: number;
}): JSX.Element {
  return (
    <div className="flex gap-0.5 h-[11px]">
      {shares.map((share, i) => (
        <div
          key={i}
          className="rounded-[3px] flex items-center overflow-hidden"
          style={{
            width: `${share * 100}%`,
            minWidth: share > 0 ? 3 : 0,
            // Stepped by RANK, which is a magnitude — so one hue fading
            // out, never a categorical palette. Rank is not identity.
            backgroundColor: `rgb(var(--c-accent) / ${Math.max(0.3, 1 - i * 0.13).toFixed(2)})`,
          }}
        >
          {i < labelled && share > 0.04 && (
            <span className="pl-1.5 text-[9px] text-surface tabular-nums">
              {(share * 100).toFixed(0)}%
            </span>
          )}
        </div>
      ))}
      {rest > 0 && (
        <div className="rounded-[3px] bg-ink-faint/25" style={{ width: `${rest * 100}%` }} />
      )}
    </div>
  );
}

export interface CostPoint {
  key: string;
  calls: number;
  meanMs: number;
  totalMs: number;
  /// Drawn in the warn tone and always accompanied by the legend that says
  /// what it means — never colour alone.
  flagged: boolean;
  /// Only the few worth naming on the plot. Labelling every point is how a
  /// scatter becomes unreadable.
  label?: string;
}

const SCATTER = { w: 600, h: 196, left: 44, right: 12, top: 14, bottom: 26 };

/// Calls against time-per-call, both on log axes, area by total cost.
///
/// The one chart in either pane that says something the sorted list
/// cannot. Total time alone cannot tell a statement that is slow once from
/// one that is fine and runs two million times — and those want opposite
/// fixes: the first is a query to rewrite, the second is a caller to talk
/// to. The corners are labelled because that reading is the whole point,
/// and a quadrant nobody can name is a decoration.
export function CostScatter({
  points,
  onPick,
  onHover,
  highlight,
}: {
  points: CostPoint[];
  onPick?(key: string): void;
  onHover?(key: string | null): void;
  highlight?: string | null;
}): JSX.Element {
  const drawn = points.filter((p) => p.calls > 0 && p.meanMs > 0);
  if (drawn.length < 2) {
    return (
      <p className="text-[10px] text-ink-faint py-6 text-center">
        Two statements with measurable time are needed before this says anything.
      </p>
    );
  }

  const xs = drawn.map((p) => Math.log10(p.calls));
  const ys = drawn.map((p) => Math.log10(p.meanMs));
  const xd = decades(xs);
  const yd = decades(ys);
  const maxTotal = Math.max(...drawn.map((p) => p.totalMs)) || 1;

  const px = (calls: number) =>
    SCATTER.left +
    ((Math.log10(calls) - xd.lo) / (xd.hi - xd.lo || 1)) * (SCATTER.w - SCATTER.left - SCATTER.right);
  const py = (meanMs: number) =>
    SCATTER.h -
    SCATTER.bottom -
    ((Math.log10(meanMs) - yd.lo) / (yd.hi - yd.lo || 1)) * (SCATTER.h - SCATTER.top - SCATTER.bottom);
  // Area, not radius — a bubble twice as wide reads as four times the
  // cost, because it is.
  const r = (totalMs: number) => 4 + Math.sqrt(totalMs / maxTotal) * 9;

  // The picked one is drawn last so it is never buried under a neighbour,
  // which in a plot this crowded it otherwise would be.
  const ordered = [...drawn].sort((a, b) =>
    a.key === highlight ? 1 : b.key === highlight ? -1 : b.totalMs - a.totalMs,
  );

  return (
    <svg
      // Never scaled ABOVE its natural size. Uniform scaling is what keeps
      // the bubbles round, and it also blows the type up with everything
      // else — a 600px chart in a 1060px card renders 14px axis labels.
      className="block w-full mx-auto"
      style={{ maxWidth: SCATTER.w }}
      viewBox={`0 0 ${SCATTER.w} ${SCATTER.h}`}
      role="img"
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <g className="stroke-rule" strokeWidth="1">
        {ticks(xd).map((t) => (
          <line key={`x${t}`} x1={px(10 ** t)} y1={SCATTER.top} x2={px(10 ** t)} y2={SCATTER.h - SCATTER.bottom} />
        ))}
        {ticks(yd).map((t) => (
          <line key={`y${t}`} x1={SCATTER.left} y1={py(10 ** t)} x2={SCATTER.w - SCATTER.right} y2={py(10 ** t)} />
        ))}
      </g>

      <g className="fill-ink-faint font-mono" fontSize="8">
        {ticks(xd).map((t) => (
          <text key={`xl${t}`} x={px(10 ** t)} y={SCATTER.h - 14} textAnchor="middle">
            {countTick(10 ** t)}
          </text>
        ))}
        {ticks(yd).map((t) => (
          <text key={`yl${t}`} x={SCATTER.left - 6} y={py(10 ** t) + 3} textAnchor="end">
            {msTick(10 ** t)}
          </text>
        ))}
        <text x={(SCATTER.left + SCATTER.w) / 2} y={SCATTER.h - 2} textAnchor="middle" fontFamily="inherit">
          calls
        </text>
      </g>

      <g className="fill-ink-faint" fontSize="9" opacity="0.55">
        <text x={SCATTER.left + 8} y={SCATTER.top + 10}>
          slow, rarely run
        </text>
        <text x={SCATTER.w - SCATTER.right - 6} y={SCATTER.h - SCATTER.bottom - 6} textAnchor="end">
          fast, constantly run
        </text>
      </g>

      {/* Every bubble gets a ring in the surface colour before any of them
          get a fill. Without it a cluster of two hundred statements reads
          as one purple smear — the separation has to come from the gap,
          not from the outline, because the outlines are all the same
          colour as each other. */}
      <g stroke="rgb(var(--c-surface))" strokeWidth="3" fill="none">
        {ordered.map((p) => (
          <circle key={`h${p.key}`} cx={px(p.calls)} cy={py(p.meanMs)} r={r(p.totalMs)} />
        ))}
      </g>

      {ordered.map((p) => {
        const on = highlight === p.key;
        const size = r(p.totalMs);
        return (
          <g key={p.key}>
            <circle
              cx={px(p.calls)}
              cy={py(p.meanMs)}
              r={size}
              className={p.flagged ? 'text-warn' : 'text-accent'}
              fill="currentColor"
              fillOpacity={on ? 0.65 : 0.3}
              stroke="currentColor"
              strokeWidth={on ? 2.5 : 1.25}
            />
            {/* A separate, larger, invisible target. The smallest bubbles
                are 8px across, and an 8px click target is one nobody
                hits. */}
            <circle
              cx={px(p.calls)}
              cy={py(p.meanMs)}
              r={Math.max(size, 10)}
              fill="transparent"
              className={onPick ? 'cursor-pointer' : undefined}
              onClick={onPick ? () => onPick(p.key) : undefined}
              onMouseEnter={onHover ? () => onHover(p.key) : undefined}
            >
              <title>
                {`${p.label ?? 'statement'}\n${p.calls.toLocaleString()} calls · ${p.meanMs.toFixed(
                  2,
                )} ms each · ${(p.totalMs / 1000).toFixed(2)} s total`}
              </title>
            </circle>
          </g>
        );
      })}

      {/* Drawn over the marks, so they carry a surface outline of their
          own — a label sitting on top of a bubble is unreadable
          otherwise, and these sit on top of bubbles by construction. */}
      <g
        className="fill-ink"
        fontSize="9"
        stroke="rgb(var(--c-surface))"
        strokeWidth="3"
        paintOrder="stroke"
      >
        {ordered
          .filter((p) => p.label)
          .map((p) => (
            <text key={`t${p.key}`} x={px(p.calls) + r(p.totalMs) + 5} y={py(p.meanMs) + 3}>
              {p.label}
            </text>
          ))}
      </g>
    </svg>
  );
}

function decades(values: number[]): { lo: number; hi: number } {
  const lo = Math.floor(Math.min(...values));
  const hi = Math.ceil(Math.max(...values));
  return hi === lo ? { lo: lo - 1, hi: hi + 1 } : { lo, hi };
}

/// At most six gridlines, whatever the range — a log axis over eight
/// decades with a line on each is a hatch pattern, not a grid.
function ticks({ lo, hi }: { lo: number; hi: number }): number[] {
  const step = Math.max(1, Math.ceil((hi - lo) / 5));
  const out: number[] = [];
  for (let t = lo; t <= hi; t += step) out.push(t);
  return out;
}

function countTick(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}K`;
  return String(v);
}

function msTick(v: number): string {
  if (v >= 60_000) return `${v / 60_000}min`;
  if (v >= 1_000) return `${v / 1_000}s`;
  return `${v}ms`;
}
