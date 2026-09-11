import { useEffect, useRef, useState } from 'react';
import type { PlanRow } from '@shared/plan';
import { choke, chokeSentence, heat, planShape, wasteSentence } from '@shared/planShape';
import { PlanRiver } from './PlanRiver';
import { PlanLedger } from './PlanLedger';
import { PlanReading, PlanVerdict } from './PlanReading';
import { resolveStep, tableAliases } from '@shared/aliases';
import { useStore } from './store';

/// The plan, twice: as a picture, then as the table.
///
/// The table came first and is still the precise answer — what is read, how,
/// on which index, how many rows expected, how much survives. But reading it
/// is a skill, and the thing it is usually hiding is one ratio: rows read
/// against rows kept. So that goes on top, drawn, and the numbers stay
/// underneath for when the picture raises a question.
export function PlanView({
  rows,
  raw,
  result,
  sql,
  compare,
  onDropCompare,
  onTune,
  tuning,
}: {
  rows: PlanRow[];
  raw: string;
  /// What the statement actually returned, when it has been run. Without it
  /// there is no ratio to draw — only the plan's own estimates.
  result?: { rowCount: number; durationMs: number | null } | null;
  /// The statement this plan is for, so alias-named steps can say which
  /// table they read.
  sql?: string;
  /// A plan for a statement that has NOT been run — a suggested rewrite.
  compare?: { rows: PlanRow[]; raw: string; sql: string };
  onDropCompare?(): void;
  /// Ask the model what it would try instead. It PROPOSES; the server's own
  /// EXPLAIN of the proposal is what adjudicates, and that comes back into
  /// `compare` above.
  onTune?(): void;
  tuning?: boolean;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        No plan returned.
      </div>
    );
  }

  const aliases = sql ? tableAliases(sql) : {};

  return (
    <div className="h-full overflow-auto">
      <Picture rows={rows} result={result} sql={sql} onTune={onTune} tuning={tuning} />
      {compare && <Comparison rows={rows} compare={compare} onDrop={onDropCompare} />}

      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-surface-muted">
          <tr className="text-left text-ink-faint">
            <Th>Step</Th>
            <Th>Access</Th>
            <Th>Key</Th>
            <Th className="text-right">Est. rows</Th>
            <Th className="text-right">Actual</Th>
            <Th className="text-right">Filtered</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={`border-b grid-rule ${row.warn ? 'bg-warn/10' : ''}`}>
              <td className="px-2.5 py-1 font-mono text-ink" style={{ paddingLeft: 10 + row.depth * 16 }}>
                {row.depth > 0 && <span className="text-ink-faint mr-1">└</span>}
                {row.title}
                {(() => {
                  // The alias is what the plan says; the table is what you
                  // need. Both, because the alias is how you find the step
                  // again in the statement.
                  const named = resolveStep(row.title, aliases);
                  return named?.alias ? (
                    <span className="ml-1.5 text-ink-faint">{named.table}</span>
                  ) : null;
                })()}
                {row.warn && (
                  <div className="mt-0.5 text-[10px] text-warn/90 font-sans">{row.warn}</div>
                )}
                {row.extra && (
                  <div className="mt-0.5 text-[10px] text-ink-faint font-mono truncate" title={row.extra}>
                    {row.extra}
                  </div>
                )}
              </td>
              <td className="px-2.5 py-1">
                {row.access && (
                  <span
                    className={`font-mono ${
                      row.warn && !row.key ? 'text-warn/90' : 'text-ink-muted'
                    }`}
                  >
                    {row.access}
                  </span>
                )}
              </td>
              <td className="px-2.5 py-1 font-mono text-ink-muted">
                {row.key ?? <span className="text-ink-faint">—</span>}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.rows?.toLocaleString() ?? '—'}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.actualRows?.toLocaleString() ?? '—'}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.filtered !== undefined ? `${row.filtered}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <RawPlan raw={raw} />
    </div>
  );
}

/// The plan exactly as the server sent it, with a way to get it out.
///
/// Everything above this is an interpretation, and the moment anyone wants
/// a second opinion — a colleague, a ticket, a model — what they need is
/// the server's own words, not ours. Copying it out of a <pre> by hand
/// loses the last line as often as not.
function RawPlan({ raw }: { raw: string }): JSX.Element {
  const toast = useStore((s) => s.toast);
  // Pretty-printed when it is JSON, which every engine but SQLite sends.
  // One line of three thousand characters is not a thing anyone reads, and
  // the servers do not all indent it themselves.
  const text = (() => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  })();

  return (
    <details className="p-3 group">
      <summary className="text-[11px] text-ink-faint cursor-pointer flex items-center gap-2">
        <span>Raw plan</span>
        <span className="text-ink-faint/60">{text.length.toLocaleString()} characters</span>
      </summary>
      <div className="mt-2 relative">
        <button
          onClick={() => {
            void window.overdb.invoke('app:copyText', text);
            toast('Raw plan copied.');
          }}
          title="Copy the plan exactly as the server sent it"
          className="absolute top-1.5 right-1.5 text-[10px] px-2 py-0.5 rounded border border-card bg-surface text-ink-muted hover:text-ink hover:bg-card"
        >
          Copy
        </button>
        <pre className="text-[10px] font-mono whitespace-pre-wrap text-ink-muted bg-surface-muted rounded p-2.5 pr-16 max-h-[420px] overflow-auto">
          {text}
        </pre>
      </div>
    </details>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <th className={`px-2.5 py-1.5 font-medium border-b border-card ${className}`}>{children}</th>
  );
}

/// The suggested rewrite, planned but not run.
///
/// EXPLAIN executes nothing, so this is the server's own estimate for a
/// statement nobody has taken a risk on yet — which is the only honest way
/// to answer "would that actually be faster?". It is labelled as a
/// different statement, because a comparison that looks like two views of
/// one query is a comparison that will be misread.
function Comparison({
  rows,
  compare,
  onDrop,
}: {
  rows: PlanRow[];
  compare: { rows: PlanRow[]; raw: string; sql: string };
  onDrop?(): void;
}): JSX.Element {
  const before = planShape(rows, null).read;
  const after = planShape(compare.rows, null).read;

  return (
    <div className="border-b border-card">
      <div className="flex items-baseline gap-2 px-3 pt-3">
        <span className="text-[11px] text-ink">If you ran this instead</span>
        <span className="text-[10px] text-ink-faint">planned, not run</span>
        <div className="flex-1" />
        {before !== null && after !== null && (
          <span className="text-[11px] font-mono tabular-nums">
            <span className="text-warn/90">{before.toLocaleString()}</span>
            <span className="text-ink-faint"> → </span>
            <span className={after < before ? 'text-good/90' : 'text-warn/90'}>
              {after.toLocaleString()}
            </span>
            <span className="text-ink-faint"> rows read</span>
          </span>
        )}
        {onDrop && (
          <button onClick={onDrop} className="text-[10px] text-ink-faint hover:text-ink">
            ✕
          </button>
        )}
      </div>
      <pre className="mx-3 mt-2 px-2 py-1.5 rounded border border-card bg-surface text-[10px] font-mono leading-snug text-ink-muted whitespace-pre-wrap max-h-20 overflow-y-auto">
        {compare.sql}
      </pre>
      <PlanRiver rows={compare.rows} result={null} sql={compare.sql} />
    </div>
  );
}

type Picture = 'plan' | 'bars';

/// Below this the sidebar goes underneath rather than beside: a reading
/// column squeezed to nothing is worse than a reading column further down.
const WIDE = 940;

/// The plan, drawn.
///
/// One view, in three registers, because the same person asks three
/// questions in the same minute and used to have to switch pictures between
/// them. What SHAPE is this query — the river. What did each step do — the
/// ledger. What is actually wrong with it — the reading, in words, beside
/// the steps it is talking about.
///
/// The bars remain as an alternative, and only as an alternative: they
/// answer "is this wasteful" faster than anything else here, and they are
/// the right thing to look at when the plan has no measured rows to draw.
function Picture({
  rows,
  result,
  sql,
  onTune,
  tuning,
}: {
  rows: PlanRow[];
  result?: { rowCount: number; durationMs: number | null } | null;
  sql?: string;
  onTune?(): void;
  tuning?: boolean;
}): JSX.Element | null {
  const [mode, setMode] = useState<Picture>(() => {
    try {
      return localStorage.getItem('overdb.plan.picture') === 'bars' ? 'bars' : 'plan';
    } catch {
      return 'plan';
    }
  });
  const choose = (next: Picture) => {
    setMode(next);
    try {
      localStorage.setItem('overdb.plan.picture', next);
    } catch {
      // Losing the preference costs a click; failing to switch costs the view.
    }
  };

  // The reading sits beside the ledger only when there is room for both.
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setWide(el.clientWidth >= WIDE);
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= WIDE));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shape = planShape(rows, result?.rowCount ?? null);
  if (shape.read === null) return null;
  const aliases = sql ? tableAliases(sql) : {};

  return (
    <div ref={host} className="border-b border-card">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="text-[11px] text-ink">The work this query does</span>
        <div className="flex-1" />
        {onTune && mode === 'bars' && (
          <button
            onClick={onTune}
            disabled={tuning}
            className="text-[10px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:border-accent/40 disabled:opacity-50"
          >
            {tuning ? 'Thinking…' : 'What would make this faster?'}
          </button>
        )}
        <div className="flex rounded border border-card overflow-hidden">
          {(['plan', 'bars'] as const).map((m) => (
            <button
              key={m}
              onClick={() => choose(m)}
              className={`text-[10px] px-2 py-0.5 ${
                mode === m ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === 'bars' ? (
        <PlanBars rows={rows} shape={shape} result={result} sql={sql} />
      ) : (
        <>
          <PlanVerdict rows={rows} result={result} />
          <PlanRiver rows={rows} result={result} sql={sql} />
          <div
            className="px-3 pb-3 pt-1 grid gap-6 items-start"
            style={{ gridTemplateColumns: wide ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)' }}
          >
            <PlanLedger rows={rows} result={result} aliases={aliases} />
            <PlanReading
              rows={rows}
              result={result}
              aliases={aliases}
              onTune={onTune}
              tuning={tuning}
            />
          </div>
        </>
      )}
    </div>
  );
}

/// The work, as a Gantt of where it goes.
///
/// Two bars answer "is this wasteful": what had to be read, and what came
/// back. Under them the steps are laid out end to end on one track, each
/// starting where the last finished and as wide as its share of the total —
/// so a single step owning nine tenths of the work is a shape, not a number
/// you have to find in a column.
///
/// The axis is WORK, not time. Without ANALYZE there are no per-step
/// timings, and drawing estimates on a clock would be a promise the plan
/// cannot keep.
function PlanBars({
  rows,
  shape,
  result,
  sql,
}: {
  rows: PlanRow[];
  shape: ReturnType<typeof planShape>;
  result?: { rowCount: number; durationMs: number | null } | null;
  sql?: string;
}): JSX.Element | null {
  if (shape.read === null) return null;
  const max = shape.read;
  const sentence = wasteSentence(shape);
  const returned = shape.returned;
  const aliases = sql ? tableAliases(sql) : {};

  // Back into plan order for the Gantt: the steps run in the order the
  // server runs them, and a chart of "when" that is sorted by size is not a
  // chart of when.
  const total = shape.total ?? 0;
  let offset = 0;
  const track = [...shape.steps]
    .sort((a, b) => rows.indexOf(a.row) - rows.indexOf(b.row))
    .map(({ row, read }) => {
      const start = total > 0 ? offset / total : 0;
      offset += read;
      return { row, read, start, width: total > 0 ? read / total : 0 };
    });
  // Where the rows stop travelling — the same test the circuit and the rail
  // use, so the three pictures agree about which step is the problem.
  const chokes = track.map((t, i) =>
    choke(t.read, i === track.length - 1 ? (returned ?? t.read) : track[i + 1].read),
  );

  return (
    <div className="px-3 pb-3 pt-2 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Row
          label="Rows it must read"
          note={shape.measured ? undefined : 'estimated'}
          value={max}
          tone="hot"
        />
        <Bar value={1} tone="hot" />

        {returned !== null ? (
          <>
            <Row label="Rows you asked for" value={returned} tone="cool" />
            <Bar value={max > 0 ? returned / max : 0} tone="cool" />
          </>
        ) : (
          <p className="text-[10px] text-ink-faint mt-0.5">
            Run the statement to see how many of those rows come back.
          </p>
        )}
      </div>

      {sentence && (
        <p className="text-[11px] text-ink-muted leading-snug max-w-[1600px]">{sentence}</p>
      )}

      {track.length > 1 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] uppercase tracking-[0.07em] text-ink-faint">
              Where the work goes
            </span>
            <span className="text-[9px] text-ink-faint">
              in the order the server runs them
            </span>
          </div>
          {track.map(({ row, read, start, width }, i) => {
            const named = resolveStep(row.title, aliases);
            const throttle = chokes[i];
            const hot = throttle !== null || heat(row, read, max) > 0.6;
            return (
              <div
                key={i}
                className="flex items-center gap-2"
                title={throttle ? chokeSentence(throttle) : undefined}
              >
                <span
                  className="font-mono text-[10px] text-ink truncate shrink-0"
                  style={{ width: 132 }}
                  title={named ? `${named.table}${named.alias ? ` (${named.alias})` : ''}` : row.title}
                >
                  {named?.table ?? row.title}
                </span>
                <span className="flex-1 min-w-0 h-[13px] rounded-[3px] bg-card border border-card relative overflow-hidden">
                  <span
                    className={`absolute top-0 bottom-0 rounded-[2px] bar-grow ${
                      hot
                        ? 'bg-gradient-to-r from-warn/45 to-warn/70'
                        : 'bg-good/55'
                    }`}
                    style={{
                      left: `${(start * 100).toFixed(3)}%`,
                      width: `max(2px, ${(width * 100).toFixed(3)}%)`,
                    }}
                  />
                </span>
                <span className="font-mono text-[10px] tabular-nums text-ink-faint shrink-0 w-[72px] text-right">
                  {read.toLocaleString()}
                </span>
                {/* A fixed column so the drops line up and can be scanned
                    down, rather than appearing wherever a bar happened to
                    end. */}
                <span className="font-mono text-[10px] tabular-nums shrink-0 w-[76px] text-right text-warn/90">
                  {throttle ? `−${throttle.dropped.toLocaleString()}` : ''}
                </span>
              </div>
            );
          })}
          {chokes.some(Boolean) && (
            <p className="text-[10px] text-warn/90 leading-snug mt-0.5 max-w-[1600px]">
              An amber number is what that step read and did not pass on. The widest bar is the
              most work; the biggest amber number is the most WASTED work, and those are usually
              different steps.
            </p>
          )}
          {/* The multiplier that makes a join expensive, said once, under
              the chart it explains. */}
          {track.some(({ row }) => (row.loops ?? 1) > 1) && (
            <p className="text-[10px] text-ink-faint leading-snug mt-0.5">
              Bars include repeats: a step inside a join runs once per row from the step before
              it, and its row count is per run.
            </p>
          )}
        </div>
      )}

      {result?.durationMs != null && (
        <div className="text-[11px] text-ink-faint">
          Took {result.durationMs.toLocaleString()} ms
          {shape.heaviest?.warn && (
            <span className="text-warn/90"> · {shape.heaviest.warn}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  note,
  value,
  tone,
}: {
  label: string;
  note?: string;
  value: number;
  tone: 'hot' | 'cool';
}): JSX.Element {
  const colour = tone === 'hot' ? 'text-warn/90' : 'text-good/90';
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className={colour}>{label}</span>
      {note && <span className="text-ink-faint">{note}</span>}
      <span className="flex-1" />
      <span className={`font-mono tabular-nums ${colour}`}>{value.toLocaleString()}</span>
    </div>
  );
}

function Bar({ value, tone }: { value: number; tone: 'hot' | 'cool' }): JSX.Element {
  // A floor of 2px: a bar for three rows next to a bar for ten thousand is
  // mathematically a hairline, and an invisible bar reads as no bar at all
  // rather than as a very small one.
  const width = `max(2px, ${(Math.max(0, Math.min(1, value)) * 100).toFixed(3)}%)`;
  return (
    <div className="h-[11px] rounded-[3px] bg-card border border-card overflow-hidden">
      <div
        className={`h-full rounded-[2px] bar-grow ${
          tone === 'hot'
            ? 'bg-gradient-to-r from-warn/35 to-warn/60'
            : 'bg-good/60'
        }`}
        style={{ width }}
      />
    </div>
  );
}
