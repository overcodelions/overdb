import { useEffect, useRef, useState } from 'react';
import { keyLabel, type PlanRow } from '@shared/plan';
import { chainFlow, type Flow } from '@shared/planFlow';
import { isDriven } from '@shared/planLoops';
import { planShape, share } from '@shared/planShape';
import { resolveStep, tableAliases } from '@shared/aliases';
import { branchesOf, planTree, type PlanNode } from '@shared/planTree';
import { middleTruncate } from '@shared/truncate';

/// The main line of the plan as a river.
///
/// Rows are the water. The stream is as thick as the number of rows in
/// flight, so it NARROWS where the server throws rows away and FLARES where
/// a nested loop makes one row into many. Those two events are the whole of
/// why a query is slow, and in a plan table they are invisible: one is a
/// `filtered` percentage six columns from the row count it applies to, and
/// the other is a `loops` field that a reader has to multiply by hand.
///
/// ONLY THE MAIN LINE IS DRAWN. The previous board wired every subquery in
/// as its own rail and grew to two thousand pixels, which put half the plan
/// behind a horizontal scrollbar; a picture you have to scroll is a picture
/// nobody reads twice. The subqueries are counted here, under the step they
/// feed, and itemised in the ledger below — where a list belongs.
///
/// WHERE THE PICTURE UNDERSTATES. Thickness is on a square-root scale.
/// Linear, one row beside 28,616 is a quarter of a pixel and reads as
/// nothing at all rather than as very little; the numbers on the labels are
/// exact, and the shape is what the scale is for.

/// Room for the widest node before names start getting cut.
const NODE_W = 214;
const NODE_W_MIN = 148;
const NODE_H = 80;
const CHIP_W = 92;
const RESULT_W = 104;
/// The stretch between two steps, where the narrowing and the flare happen.
const GAP = 138;
const GAP_MIN = 82;
const CY = 104;
/// Thickest and thinnest a stream is ever drawn.
const THICK_MAX = 62;
const THICK_MIN = 2.6;
/// Steps on the main line before the river gives up and points at the
/// ledger. A main line is short — this is a guard, not a layout.
const MAX_STEPS = 6;
/// Fixed depths for the two things written under the river, so they cannot
/// drift into each other as the stream changes thickness.
const DROP_Y = CY + 58;
const FEEDS_Y = CY + NODE_H / 2 + 48;

const HOT = 'rgb(251 146 60)';
const WARN = 'rgb(251 191 36)';
const COOL = 'rgb(52 211 153)';
const ACCENT = 'rgb(127 110 242)';

interface Step {
  node: PlanNode;
  flow: Flow;
  per: number;
  runs: number;
  /// Rows arriving from the step before — what the stream into it carries.
  arriving: number;
}

export function PlanRiver({
  rows,
  result,
  sql,
}: {
  rows: PlanRow[];
  result?: { rowCount: number; durationMs: number | null } | null;
  sql?: string;
}): JSX.Element | null {
  // How much room there is decides the node width and the length of the
  // stretches between them, so it is measured rather than assumed.
  const host = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setAvail(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setAvail(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tree = planTree(rows);
  const shape = planShape(rows, result?.rowCount ?? null);
  if (!tree.length || shape.read === null) return null;

  const aliases = sql ? tableAliases(sql) : {};

  // The main line: the top-level chain, in the order the server runs it.
  const trunk = tree.filter((n) => (n.row.actualRows ?? n.row.rows) !== undefined);
  if (!trunk.length) return null;
  const shown = trunk.slice(0, MAX_STEPS);
  const beyond = trunk.length - shown.length;

  const flows = chainFlow(
    shown.map((n) => ({
      per: n.row.actualRows ?? n.row.rows ?? 0,
      runs: Math.max(1, n.row.loops ?? 1),
      filtered: n.row.filtered,
      driven: isDriven(n.row.access),
    })),
    // Only the outermost chain may claim the returned count. When the
    // river is truncated the last drawn step is not the last step, so it
    // gets no closing comparison either.
    beyond > 0 ? null : (shape.returned ?? null),
  );

  const steps: Step[] = shown.map((node, i) => ({
    node,
    flow: flows[i],
    per: node.row.actualRows ?? node.row.rows ?? 0,
    runs: Math.max(1, node.row.loops ?? 1),
    arriving: i === 0 ? flows[0].read : flows[i - 1].out,
  }));

  // Scaled against EVERY step in the plan, drawn or not: thickness has to
  // mean the same thing here as a bar does in the ledger underneath, and a
  // scale taken from the drawn subset would call a small step large.
  const max = Math.max(
    1,
    ...rows.map((r) => (r.actualRows ?? r.rows ?? 0) * Math.max(1, r.loops ?? 1)),
  );
  const thick = (n: number): number =>
    THICK_MIN + (THICK_MAX - THICK_MIN) * Math.sqrt(Math.max(0, n) / max);

  // ---- Fit ------------------------------------------------------------
  const n = steps.length;
  const fixed = CHIP_W + RESULT_W;
  const room = Math.max(560, avail - 8);
  let nodeW = NODE_W;
  let gap = GAP;
  const need = () => fixed + n * nodeW + (n + 1) * gap;
  if (need() > room) gap = Math.max(GAP_MIN, (room - fixed - n * nodeW) / (n + 1));
  if (need() > room) nodeW = Math.max(NODE_W_MIN, (room - fixed - (n + 1) * gap) / n);
  const width = Math.max(room, need());

  const xOf = (i: number): number => CHIP_W + gap + i * (nodeW + gap);
  const endX = xOf(n - 1) + nodeW + gap;

  const anyMotion = steps.some((s) => s.flow.dropped > 0 || s.runs > 1);

  return (
    <div ref={host} className="px-3 pt-1 pb-2 overflow-x-auto">
      <svg width={width} height={228} viewBox={`0 0 ${width} 228`} fill="none">
        {/* Streams first, so every node paints over its own ends. */}
        <Reach
          x0={CHIP_W}
          x1={xOf(0)}
          from={thick(steps[0].arriving)}
          to={thick(steps[0].flow.read)}
          rows={steps[0].arriving}
          dropped={0}
          widen={steps[0].flow.widen}
          runs={steps[0].runs}
        />
        {steps.map((step, i) => {
          const next = steps[i + 1];
          return (
            <Reach
              key={`r${i}`}
              x0={xOf(i) + nodeW}
              x1={next ? xOf(i + 1) : endX}
              from={thick(step.flow.read)}
              to={thick(next ? next.flow.read : step.flow.out)}
              through={thick(step.flow.out)}
              rows={step.flow.out}
              dropped={step.flow.dropped}
              // Without ANALYZE the whole plan is the optimiser's guess —
              // the loop counts included, since those are derived from
              // `rows` × `filtered` rather than observed.
              estimated={step.flow.estimated || !shape.measured}
              filtered={step.node.row.filtered}
              widen={next?.flow.widen ?? 1}
              runs={next?.runs ?? 1}
              max={max}
            />
          );
        })}

        <Chip x={0} label="select" sub={`${steps[0].flow.read.toLocaleString()} rows`} />
        <Chip
          x={endX}
          w={RESULT_W}
          label="result"
          sub={
            shape.returned !== null
              ? `${shape.returned.toLocaleString()}${
                  result?.durationMs != null ? ` · ${result.durationMs} ms` : ''
                }`
              : 'not run'
          }
          tone={COOL}
        />

        {steps.map((step, i) => (
          <Node
            key={`n${i}`}
            x={xOf(i)}
            w={nodeW}
            step={step}
            aliases={aliases}
            hot={step.flow.dropped > 0 || (!step.node.row.key && step.node.row.warn !== undefined)}
          />
        ))}

        {beyond > 0 && (
          <text x={endX} y={CY + 46} style={{ fontSize: 10, fill: 'rgb(107 107 118)' }}>
            +{beyond} more
          </text>
        )}
      </svg>

      {anyMotion && (
        <p className="text-[10.5px] text-ink-faint leading-snug mt-1">
          The stream is the rows. It necks down where the WHERE clause throws them away — those are
          the flecks falling out of it — and flares where a loop reads many rows for each one
          arriving. A <span className="font-mono">≈</span> marks a count the server estimated rather
          than measured. Thickness is on a square-root scale; the numbers on the labels are exact.
        </p>
      )}
    </div>
  );
}

/// One stretch of river between two steps: the narrowing where rows are
/// discarded, then the flare where the next step's loop multiplies what is
/// left. Both are drawn even when only one happens, because a stretch that
/// changes shape for one reason and not the other would need a legend.
function Reach({
  x0,
  x1,
  from,
  to,
  through,
  rows,
  dropped,
  estimated,
  filtered,
  widen,
  runs,
  max,
}: {
  x0: number;
  x1: number;
  /// Thickness entering, at the surviving waist, and leaving.
  from: number;
  to: number;
  through?: number;
  /// Rows that survive this stretch.
  rows: number;
  dropped: number;
  /// Whether the survivor count is the server's estimate rather than a
  /// count of what actually came through.
  estimated?: boolean;
  /// What share of the rows the step behind this reach let through, 0-100.
  /// This narrowing IS that condition, so it is named here rather than on
  /// the node — the node says what was read, the reach says what survived.
  filtered?: number;
  /// How much the NEXT step's loop multiplies each arriving row.
  widen: number;
  runs: number;
  max?: number;
}): JSX.Element {
  const waist = through ?? Math.min(from, to);
  // The waist sits nearer the step that caused the drop than the one that
  // caused the flare, so the two events read in the order they happen.
  const a = x0 + (x1 - x0) * 0.42;
  const b = x0 + (x1 - x0) * 0.6;
  const half = (t: number) => t / 2;

  // How urgent the shedding looks is how much is being shed. Capped at both
  // ends: below a floor it reads as a stutter, above a ceiling as a blur.
  const severity = max && max > 0 ? Math.min(1, dropped / max) : 0;
  const shedMs = Math.round(2200 - 1500 * Math.sqrt(severity));
  const strainMs = Math.round(3600 - 1400 * Math.sqrt(severity));
  // A loop's cadence is its turn count, so 26,385 flickers and 12 ticks.
  const loopMs = Math.round(Math.max(420, 2400 - 320 * Math.log10(Math.max(1, runs))));

  return (
    <g>
      {dropped > 0 && (
        <>
          {/* The cone of rows that came in and did not come out. */}
          <path
            d={`M${x0} ${CY - half(from)} L${a} ${CY - half(waist)} L${a} ${CY + half(waist)} L${x0} ${CY + half(from)} Z`}
            fill={HOT}
            className="plan-strain"
            style={{ ['--strain' as string]: `${strainMs}ms` }}
          />
          <path
            d={`M${x0} ${CY - half(from)} L${a} ${CY - half(waist)} M${x0} ${CY + half(from)} L${a} ${CY + half(waist)}`}
            stroke={HOT}
            strokeOpacity="0.5"
            strokeWidth="1.2"
          />
          {/* The rows themselves, leaving. Three flecks, staggered, so the
              shedding reads as continuous rather than as a metronome. */}
          {[0, 1, 2].map((k) => (
            <rect
              key={k}
              x={x0 + (a - x0) * (0.25 + k * 0.22)}
              y={CY + half(from) * (0.3 + k * 0.2)}
              width="5"
              height="1.8"
              rx="0.9"
              fill={HOT}
              className="plan-shed"
              style={{
                ['--shed' as string]: `${shedMs}ms`,
                animationDelay: `${k * (shedMs / 3)}ms`,
              }}
            />
          ))}
          {/* Parked at a FIXED depth rather than under the wedge that
              caused it: keyed off the stream thickness it collided with the
              subquery note below the node, which sits at a fixed depth of
              its own. Two labels that move independently will eventually
              overlap. */}
          <text x={a + 6} y={DROP_Y} className="font-mono" style={{ fontSize: 11, fill: HOT }}>
            {estimated ? '≈ ' : ''}−{dropped.toLocaleString()}
          </text>
          <text x={a + 6} y={DROP_Y + 13} style={{ fontSize: 10, fill: 'rgb(155 155 166)' }}>
            {filtered !== undefined
              ? `fail the WHERE — ${share(filtered)} survive`
              : 'rows go no further'}
          </text>
        </>
      )}

      {/* What survives, all the way through. */}
      <path
        d={`M${x0} ${CY - half(from)} L${a} ${CY - half(waist)} L${b} ${CY - half(waist)} L${x1} ${CY - half(to)} L${x1} ${CY + half(to)} L${b} ${CY + half(waist)} L${a} ${CY + half(waist)} L${x0} ${CY + half(from)} Z`}
        fill={dropped > 0 || widen > 1 ? HOT : COOL}
        fillOpacity={dropped > 0 || widen > 1 ? 0.34 : 0.3}
      />
      {/* Direction of travel: a marker running ALONG the stream, never a
          second stream on top of it. Uncapped, a 62px-thick reach drew a
          31px dashed bar that filled the channel and read as a barcode. */}
      <path
        d={`M${x0} ${CY} H${x1}`}
        stroke={dropped > 0 ? HOT : COOL}
        strokeWidth={Math.min(9, Math.max(1.5, waist * 0.5))}
        strokeOpacity={waist > 18 ? 0.75 : 1}
        className={waist > 8 ? 'trace-flow' : 'trace-flow-thin'}
      />
      <text
        x={(x0 + x1) / 2}
        y={CY - half(Math.max(from, to)) - 8}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 10, fill: COOL }}
      >
        {estimated ? '≈' : ''}
        {rows.toLocaleString()}
      </text>

      {widen > 1 && (
        <text x={b + 4} y={CY - half(to) - 8} className="font-mono" style={{ fontSize: 10, fill: HOT }}>
          ×{widen.toLocaleString()} each
        </text>
      )}
      {runs > 1 && (
        // The loop, running backward against everything else on the board.
        <rect
          x={b + 2}
          y={CY - 1}
          width="7"
          height="2"
          rx="1"
          fill={HOT}
          className="plan-loop"
          style={{
            ['--loop' as string]: `${loopMs}ms`,
            ['--loop-span' as string]: `${Math.round(b - x0 + 10)}px`,
          }}
        />
      )}
    </g>
  );
}

/// Where the rows come from and where they end up. Deliberately plainer
/// than a step: neither of them is work.
function Chip({
  x,
  w = CHIP_W,
  label,
  sub,
  tone,
}: {
  x: number;
  w?: number;
  label: string;
  sub?: string;
  tone?: string;
}): JSX.Element {
  return (
    <g>
      <rect x={x} y={CY - 28} width={w} height={56} rx="5" fill="rgb(var(--c-surface))" />
      <rect
        x={x}
        y={CY - 28}
        width={w}
        height={56}
        rx="5"
        fill={tone ? `${tone.slice(0, -1)} / 0.14)` : 'var(--c-card-bg)'}
        stroke={tone ? `${tone.slice(0, -1)} / 0.5)` : 'var(--c-card-border)'}
      />
      <text x={x + w / 2} y={CY - 2} textAnchor="middle" className="fill-ink" style={{ fontSize: 11 }}>
        {label}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={CY + 13}
          textAnchor="middle"
          className="font-mono"
          style={{ fontSize: 10, fill: tone ?? 'rgb(var(--c-ink-faint))' }}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

/// One step of the main line, and — under it — a count of the subqueries
/// that feed it, pointing down at the ledger where they are itemised.
function Node({
  x,
  w,
  step,
  hot,
  aliases,
}: {
  x: number;
  w: number;
  step: Step;
  hot: boolean;
  aliases: Record<string, string>;
}): JSX.Element {
  const row = step.node.row;
  const named = resolveStep(row.title, aliases);
  // The table leads: an alias means nothing an hour later. The alias trails
  // it so the step can still be found in the table underneath.
  const chars = Math.floor(w / 7.2);
  const title = middleTruncate(named?.table ?? row.title, chars);
  const under = [named?.alias, row.key ? `via ${keyLabel(row.key)}` : row.access]
    .filter(Boolean)
    .join(' · ');
  const branches = branchesOf(step.node);
  const fed = branches.reduce(
    (sum, b) =>
      sum +
      [b, ...flatten(b)].reduce(
        (n, node) =>
          n + (node.row.actualRows ?? node.row.rows ?? 0) * Math.max(1, node.row.loops ?? 1),
        0,
      ),
    0,
  );

  return (
    <g>
      {hot && (
        <rect
          x={x - 9}
          y={CY - NODE_H / 2 - 9}
          width={w + 18}
          height={NODE_H + 18}
          rx="13"
          fill={HOT}
          className="trace-heat"
        />
      )}
      <rect x={x} y={CY - NODE_H / 2} width={w} height={NODE_H} rx="5" fill="rgb(var(--c-surface))" />
      <rect
        x={x}
        y={CY - NODE_H / 2}
        width={w}
        height={NODE_H}
        rx="5"
        fill={hot ? 'rgb(251 146 60 / 0.16)' : 'rgb(52 211 153 / 0.10)'}
        stroke={hot ? 'rgb(251 146 60 / 0.55)' : 'rgb(52 211 153 / 0.35)'}
      />

      <text x={x + w / 2} y={CY - 18} textAnchor="middle" className="fill-ink font-mono" style={{ fontSize: 12 }}>
        {title}
      </text>
      <text x={x + w / 2} y={CY - 2} textAnchor="middle" className="fill-ink-faint" style={{ fontSize: 10 }}>
        {clip(under || (row.access ?? 'no index'), chars + 6)}
      </text>
      {/* The arithmetic, done. `1 × 143` is the multiplication a plan table
          leaves to the reader, and it is the whole cost of a nested loop. */}
      <text
        x={x + w / 2}
        y={CY + 15}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 10, fill: step.runs > 1 ? HOT : 'rgb(var(--c-ink-muted))' }}
      >
        {step.runs > 1
          ? `${step.per.toLocaleString()} × ${step.runs.toLocaleString()} runs = ${step.flow.read.toLocaleString()}`
          : `reads ${step.flow.read.toLocaleString()}`}
      </text>
      {row.warn && !row.key && (
        <text x={x + w / 2} y={CY + 29} textAnchor="middle" style={{ fontSize: 10, fill: WARN }}>
          {clip(row.warn, chars + 6)}
        </text>
      )}

      {branches.length > 0 && (
        <g>
          <path
            d={`M${x + w / 2} ${CY + NODE_H / 2} V${FEEDS_Y - 10} H${x + 6}`}
            stroke={ACCENT}
            strokeOpacity="0.55"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            fill="none"
          />
          <path
            d={`M${x + w / 2} ${CY + NODE_H / 2} l -4 -7 m 4 7 l 4 -7`}
            stroke={ACCENT}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <text x={x + 6} y={FEEDS_Y + 4} style={{ fontSize: 10.5, fill: ACCENT }}>
            {branches.length === 1 ? '1 subquery feeds this step' : `${branches.length} subqueries feed this step`}
            <tspan style={{ fill: 'rgb(155 155 166)' }}>
              {' '}
              — {fed.toLocaleString()} rows, itemised below
            </tspan>
          </text>
        </g>
      )}
    </g>
  );
}

function flatten(node: PlanNode): PlanNode[] {
  return node.children.flatMap((c) => [c, ...flatten(c)]);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
