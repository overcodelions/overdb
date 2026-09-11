import { useEffect, useRef, useState } from 'react';
import { keyLabel, type PlanRow } from '@shared/plan';
import { chainFlow, type Flow } from '@shared/planFlow';
import { isDriven } from '@shared/planLoops';
import { planShape, share } from '@shared/planShape';
import { resolveStep, tableAliases } from '@shared/aliases';
import {
  branchesOf,
  descendants,
  feedersOf,
  planTree,
  rowsOf,
  subqueryNames,
  type PlanNode,
} from '@shared/planTree';
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

  /// The work hanging off a step that the main line does not draw.
  ///
  /// It was a dashed line and a count pointing at a ledger a screen away,
  /// and on a real plan it stood for 162,518 of the 191,277 rows — the
  /// picture was showing fifteen percent of the query. Drawn here as a fan
  /// under the step it feeds: vertical, so it costs no width, and ranked,
  /// because which of six independent subqueries is the expensive one is
  /// the only thing anybody wants from this.
  ///
  /// At most one step gets a fan. Two side by side is the two-thousand-
  /// pixel board this whole view replaced.
  const fanAt = steps.findIndex((step) => feedersOf(step.node).length > 0);
  const feeders = fanAt < 0 ? [] : feedersOf(steps[fanAt].node);
  const feederNames = subqueryNames(feeders, (t) => resolveStep(t, aliases)?.table ?? t);
  const fan = feeders
    .map((node, i) => ({ node, rows: rowsOf(node), name: feederNames[i] }))
    .sort((a, b) => b.rows - a.rows);
  const fanTotal = fan.reduce((n, f) => n + f.rows, 0);
  const fanMax = Math.max(1, ...fan.map((f) => f.rows));
  const everything = rows.reduce(
    (n, r) => n + (r.actualRows ?? r.rows ?? 0) * Math.max(1, r.loops ?? 1),
    0,
  );
  // Reported once, under the fan, rather than as a marker on every row.
  const hedged =
    fanAt >= 0 &&
    feedersOf(steps[fanAt].node).some(
      (b) => b.row.dependent === true || descendants(b).some((d) => d.row.dependent === true),
    );

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

      {fan.length > 0 && (
        // Hung off the step it feeds, not floating under the river. The
        // rule down its left continues the dashed connector the node
        // drops, so the fan reads as part of that step rather than as a
        // second table that happens to sit below the picture.
        <div
          className="mt-0.5 mb-5 border-l border-accent/30 pl-3"
          style={{
            marginLeft: xOf(fanAt) + 6,
            width: Math.max(320, Math.min(580, width - xOf(fanAt) - 32)),
          }}
        >
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              What feeds it
            </span>
            <span className="flex-1" />
            <span className="text-[10px] text-ink-faint">
              <span className="tabular-nums text-accent">{fanTotal.toLocaleString()} rows</span>
              {everything > 0 && <> · {Math.round((fanTotal / everything) * 100)}% of what this query reads</>}
            </span>
          </div>

          <div className="flex flex-col gap-[5px]">
            {fan.slice(0, 8).map((f) => {
              // "partner · print_media_activation" is two facts: the table
              // this subquery reads hardest, and the one that tells it
              // apart from its siblings. The second is the qualifier, and
              // it reads as one when it is dimmer than the first.
              const [head, ...rest] = f.name.split(' · ');
              return (
                <div key={f.node.index} className="flex items-center gap-2.5 h-[13px]">
                  <span
                    className="w-[196px] shrink-0 truncate font-mono text-[10px] text-ink-muted"
                    title={f.name}
                  >
                    {head}
                    {rest.length > 0 && <span className="text-ink-faint"> · {rest.join(' · ')}</span>}
                  </span>
                  <span className="flex-1 min-w-0 h-[6px] rounded-full bg-wash-strong">
                    <span
                      className="block h-[6px] rounded-full bg-accent/70"
                      style={{ width: `${(f.rows / fanMax) * 100}%`, minWidth: 4 }}
                    />
                  </span>
                  <span className="w-[62px] shrink-0 text-right tabular-nums text-[10px] text-ink">
                    {f.rows.toLocaleString()}
                  </span>
                </div>
              );
            })}
            {fan.length > 8 && (
              <p className="text-[10px] text-ink-faint pt-0.5">
                + {fan.length - 8} more, itemised below
              </p>
            )}
          </div>

          {hedged && (
            <p className="mt-2.5 text-[10px] text-ink-faint leading-snug max-w-[64ch]">
              The server marks these dependent and not cacheable. They are counted here as built
              once, which is what <span className="font-mono">&lt;materialize&gt;</span> means — if
              any were rebuilt per row it would cost far more than this.
            </p>
          )}
        </div>
      )}

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
      {/* One label, not two. These were separate texts — the survivor
          count centred on the reach, the fan-out at 60% along it — and on
          a short stretch they printed over each other into a single
          unreadable run of glyphs. They are one sentence anyway: this many
          rows arrive, and each fans out to that many. */}
      <text
        x={(x0 + x1) / 2}
        y={CY - half(Math.max(from, to)) - 8}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: 10 }}
      >
        <tspan fill={COOL}>
          {estimated ? '≈' : ''}
          {rows.toLocaleString()}
        </tspan>
        {widen > 1 && <tspan fill={HOT}> × {widen.toLocaleString()} each</tspan>}
      </text>
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
  // A stage — a sort, a temporary table — has no alias to resolve and no
  // index to name. Running it through the table path printed "no index"
  // under the word "sort", which reads as a finding and is not one.
  const stage = row.stage;
  const named = stage ? null : resolveStep(row.title, aliases);
  // The table leads: an alias means nothing an hour later. The alias trails
  // it so the step can still be found in the table underneath.
  const chars = Math.floor(w / 7.2);
  const title = middleTruncate(stage ? row.title : (named?.table ?? row.title), chars);
  const under = stage
    ? (row.extra ?? '')
    : [
        named?.alias,
        row.key
          // Covering is the good news in a plan, and "via IDX_FOO" alone
          // cannot tell it from an index that costs a row lookup each time.
          ? `via ${keyLabel(row.key)}${row.covering ? ' · covering' : ''}`
          : row.access,
      ]
        .filter(Boolean)
        .join(' · ');
  // A materialized subquery is not a branch — it is ONE thing built from
  // several steps — and until this it had no mark on the picture at all.
  // The counts live in the fan under the river; this is only the anchor
  // that says which step they belong to.
  const branches = branchesOf(step.node);
  const feeders = feedersOf(step.node);
  const feedNote =
    branches.length > 0
      ? branches.length === 1
        ? '1 subquery feeds this step'
        : `${branches.length} subqueries feed this step`
      : `built from ${feeders.length} step${feeders.length === 1 ? '' : 's'}`;

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
        fill={
          hot ? 'rgb(251 146 60 / 0.16)'
          : stage ? 'rgb(127 110 242 / 0.12)'
          : 'rgb(52 211 153 / 0.10)'
        }
        stroke={
          hot ? 'rgb(251 146 60 / 0.55)'
          : stage ? 'rgb(127 110 242 / 0.4)'
          : 'rgb(52 211 153 / 0.35)'
        }
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
        {stage
          ? `${STAGE_VERB[stage]} ${step.flow.read.toLocaleString()}`
          : step.runs > 1
            ? `${step.per.toLocaleString()} × ${step.runs.toLocaleString()} runs = ${step.flow.read.toLocaleString()}`
            : `reads ${step.flow.read.toLocaleString()}`}
      </text>
      {row.warn && !row.key && (
        <text x={x + w / 2} y={CY + 29} textAnchor="middle" style={{ fontSize: 10, fill: WARN }}>
          {clip(row.warn, chars + 6)}
        </text>
      )}

      {feeders.length > 0 && (
        <g>
          <path
            // Carried on to the foot of the frame, where the fan's own
            // left rule picks it up. Stopping at the label left the two
            // reading as separate things with a gap between them.
            d={`M${x + w / 2} ${CY + NODE_H / 2} V${FEEDS_Y - 10} H${x + 6} V228`}
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
          <text x={x + 14} y={FEEDS_Y + 4} style={{ fontSize: 10.5, fill: ACCENT }}>
            {feedNote}
            <tspan style={{ fill: 'rgb(155 155 166)' }}> — drawn below</tspan>
          </text>
        </g>
      )}
    </g>
  );
}

/// What each pass actually does to the rows. "reads" is wrong for all of
/// them — nothing here touches a table.
const STAGE_VERB: Record<NonNullable<PlanRow['stage']>, string> = {
  sort: 'sorts',
  temporary: 'writes',
  group: 'groups',
  distinct: 'dedupes',
  union: 'merges',
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
