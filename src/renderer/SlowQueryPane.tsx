import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSql } from '@shared/formatSql';
import {
  deltaStats,
  isRetryable,
  movers,
  scanRatio,
  shares,
  sortStats,
  type SlowQueryOrder,
  type SlowQuerySupport,
  type SlowQueryUnavailable,
  type StatementStat,
} from '@shared/slowQueries';
import { CostScatter, ShareStrip, type CostPoint } from './Marks';
import { useStore } from './store';

/// What the SERVER thinks is expensive.
///
/// The result grid answers "what did my statement return"; the log answers
/// "what did I run". This answers the question neither can: what is costing
/// this database time, across every client, including the statements nobody
/// in this window has ever typed. That is almost always where the problem
/// is, and it is invisible from a query pane.
export function SlowQueryPane({
  connectionId,
  connectionName,
  onOpen,
  onPlan,
  onFaster,
  full,
  onToggleFull,
  onClose,
}: {
  connectionId: string | null;
  connectionName: string;
  /// Put the statement in the editor, unrun.
  onOpen(sql: string): void;
  /// EXPLAIN it.
  onPlan(sql: string): void;
  /// Hand it to the tuner.
  onFaster(sql: string): void;
  /// Whether the pane has the whole window or is docked under the editor.
  full: boolean;
  onToggleFull(): void;
  /// Back to the result of whatever you last ran.
  onClose(): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const askConfirm = useStore((s) => s.askConfirm);

  const [support, setSupport] = useState<SlowQuerySupport | null>(null);
  const [stats, setStats] = useState<StatementStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<SlowQueryOrder>('total');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  /// Collapsible, and remembered. The list is still the pane — somebody
  /// who came here to read statements should be able to put the charts
  /// away and have them stay away.
  const [charts, setCharts] = useState(true);
  /// Which statement the pointer is over, in either direction. The plot
  /// and the list are two views of one set of rows, and a bubble you
  /// cannot find in the list is a bubble that told you nothing.
  const [hover, setHover] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  /// 'since' is the default because a server up for forty days reports
  /// totals against an unknown denominator: "4.2 s" cannot tell you whether
  /// the index you just added helped. The baseline below makes the same
  /// answer `pg_stat_statements_reset()` gives, without the privilege to
  /// call it and without zeroing counters other people are reading.
  const [window_, setWindow] = useState<'since' | 'all'>('since');
  const baseline = useRef<StatementStat[] | null>(null);
  const [baselineAt, setBaselineAt] = useState<number | null>(null);

  const load = useCallback(
    async (opts: { rebase?: boolean } = {}) => {
      if (!connectionId) return;
      setError(null);
      try {
        const rows = await window.overdb.invoke('perf:slowQueries', { connectionId, limit: 200 });
        if (opts.rebase || baseline.current === null) {
          baseline.current = rows;
          setBaselineAt(Date.now());
        }
        setStats(rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [connectionId],
  );

  const probe = useCallback(async () => {
    if (!connectionId) return;
    setSupport(null);
    setStats(null);
    baseline.current = null;
    setBaselineAt(null);
    try {
      const s = await window.overdb.invoke('perf:slowQuerySupport', connectionId);
      setSupport(s);
      if (s.supported) await load({ rebase: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSupport(null);
    }
  }, [connectionId, load]);

  // Probed on open rather than on connect: a connection whose statement
  // history is unreadable is a perfectly healthy connection, and nothing
  // else in the app should have to know or wait for this answer.
  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    if (!auto || !support?.supported) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [auto, support, load]);

  if (!connectionId) {
    return <Empty>Select a connection to see what it is spending time on.</Empty>;
  }

  if (support === null && error === null) {
    return <Empty>Asking {connectionName} what it keeps…</Empty>;
  }

  if (support && !support.supported) {
    return <Unavailable reason={support.reason} onRetry={() => void probe()} />;
  }

  const rows = (() => {
    if (!stats) return [];
    const base = window_ === 'since' && baseline.current ? deltaStats(baseline.current, stats) : stats;
    return sortStats(base, order);
  })();

  // The denominator for the bars. Share of the visible window, not of the
  // server: these rows are the top N, and a bar drawn against a total that
  // includes rows nobody can see would be a proportion of nothing legible.
  const totalMs = rows.reduce((a, r) => a + r.totalMs, 0);
  const strip = shares(rows, 8);
  /// Always measured against the baseline, whichever window the list is
  /// showing: "what moved" only means anything relative to a starting
  /// point, and the all-time view has none of its own.
  const moved = baseline.current ? movers(baseline.current, stats ?? [], 4) : [];
  const worstMove = Math.max(...moved.map((m) => Math.abs(m.deltaMs)), 1);
  /// Every statement with measurable time, not just the ones on screen —
  /// the whole point of the plot is the shape of the population, and a
  /// scatter of the top eight is a bar chart with extra steps.
  const points: CostPoint[] = rows.slice(0, 200).map((r, i) => {
    const ratio = scanRatio(r);
    return {
      key: r.digest,
      calls: r.calls,
      meanMs: r.meanMs,
      totalMs: r.totalMs,
      flagged: (ratio !== null && ratio >= 100) || (r.noIndexUsed ?? 0) > 0,
      // Three labels. Naming every point is how a scatter stops being
      // readable, and the rest carry their name on hover and in the list.
      // Only where the label names a table. "select" on its own is three
      // characters of noise over a crowded plot.
      label: i < 3 && !r.redacted && shortLabel(r.sql).includes(' ') ? shortLabel(r.sql) : undefined,
    };
  });
  // Recomputed from the rows on every read rather than trusted from the
  // probe: the first redacted statement may not have existed when the pane
  // opened, and the banner should appear when it does.
  const redacted =
    support?.supported &&
    (support.visibility === 'own-statements-only' || rows.some((r) => r.redacted));

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-card">
        {full && <span className="text-[11px] text-ink shrink-0">Slow queries</span>}
        <Segmented<SlowQueryOrder>
          value={order}
          onChange={setOrder}
          options={[
            { value: 'total', label: 'Total time', title: 'What is costing this server the most, overall' },
            { value: 'mean', label: 'Slowest', title: 'What hurts most each time it runs' },
            { value: 'calls', label: 'Most run', title: 'What runs most often' },
          ]}
        />
        <Segmented<'since' | 'all'>
          value={window_}
          onChange={setWindow}
          options={[
            {
              value: 'since',
              label: 'Since opened',
              title: baselineAt
                ? `Change since ${new Date(baselineAt).toLocaleTimeString(undefined, { hour12: false })}`
                : 'Change since this pane opened',
            },
            { value: 'all', label: 'All time', title: 'Everything since the server last reset its counters' },
          ]}
        />
        <div className="flex-1" />
        <label
          className="flex items-center gap-1 text-[10px] text-ink-faint cursor-pointer"
          title="Re-read every 5 seconds"
        >
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto
        </label>
        <button onClick={() => void load()} className="text-[10px] text-ink-faint hover:text-ink">
          Refresh
        </button>
        <button
          onClick={() => void load({ rebase: true })}
          title="Start the since-opened window again from now. Nothing on the server changes."
          className="text-[10px] text-ink-faint hover:text-ink"
        >
          Rebase
        </button>
        {support?.supported && support.resettable && (
          <button
            title="Zero the server's own counters. This affects everyone reading them, not just you."
            onClick={() =>
              askConfirm({
                title: 'Reset the statement counters?',
                body:
                  `${connectionName} keeps this history for every client, not just overdb. ` +
                  'Resetting discards it for all of them.\n\n' +
                  'The Since-opened view already shows change over time without this.',
                confirmLabel: 'Reset counters',
                destructive: true,
                onConfirm: () => {
                  void (async () => {
                    const r = await window.overdb.invoke('perf:resetSlowQueries', connectionId);
                    if (!r.ok) toast(r.error ?? 'Could not reset the counters.', 'error');
                    else {
                      toast('Statement counters reset.');
                      await load({ rebase: true });
                    }
                  })();
                },
              })
            }
            className="text-[10px] text-bad-strong/80 hover:text-bad-strong"
          >
            Reset
          </button>
        )}
        <span className="w-px h-3.5 bg-card" />
        {full && (
          <button
            onClick={() => setCharts((v) => !v)}
            title={charts ? 'Hide the charts and give the list the room' : 'Show where the time went'}
            className="text-[10px] text-ink-faint hover:text-ink"
          >
            {charts ? 'Hide charts' : 'Charts'}
          </button>
        )}
        <button
          onClick={onToggleFull}
          title={
            full
              ? 'Dock it under the editor — the list alone, with your query still in view'
              : 'Fill the window — where the time went, and how each statement hurts'
          }
          className="text-[10px] px-1.5 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-card"
        >
          {full ? '⤡' : '⤢'}
          <span className="ml-1">{full ? 'Dock' : 'Expand'}</span>
        </button>
        <button
          onClick={onClose}
          title="Back to your results"
          aria-label="Close slow queries"
          className="text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-card"
        >
          ✕
        </button>
      </div>

      {redacted && <RedactedBanner />}
      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-bad-strong/90 border-b border-card">
          {error}
        </div>
      )}

      {full && charts && rows.length > 0 && (
        <div className="shrink-0 border-b border-card px-3 py-2.5 flex flex-col gap-2.5">
          <div>
            <div className="flex items-baseline gap-2">
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Where the time went</p>
              <p className="text-[10px] text-ink-faint">
                {ms(strip.totalMs)} of server time across{' '}
                {count(rows.reduce((a, r) => a + r.calls, 0))} calls
                {window_ === 'since' && baselineAt && (
                  <>
                    , since{' '}
                    {new Date(baselineAt).toLocaleTimeString(undefined, { hour12: false })}
                  </>
                )}
              </p>
            </div>
            <div className="mt-2">
              <ShareStrip shares={strip.shares} rest={strip.rest} />
            </div>
            {/* The number that decides the afternoon. A top eight holding
                sixty percent is worth working on; a top eight holding four
                means the cost is spread across two hundred statements and
                there is no top eight. */}
            {strip.rest > 0 && (
              <p className="mt-1.5 text-[10px] text-ink-faint">
                The remaining {(rows.length - strip.shares.length).toLocaleString()} statements
                together: {(strip.rest * 100).toFixed(0)}%
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,640px)_1fr] gap-2.5 items-start">
            <div className="bg-card border border-card rounded-md px-2.5 py-2 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">
                  How each one hurts
                </p>
                <div className="flex-1" />
                <span className="flex items-center gap-1.5 text-[9px] text-ink-faint">
                  <span className="w-[7px] h-[7px] rounded-full bg-accent/60" />
                  area is total time
                </span>
                <span className="flex items-center gap-1.5 text-[9px] text-ink-faint">
                  <span className="w-[7px] h-[7px] rounded-full bg-warn/60" />
                  reads 100+ rows per row returned
                </span>
              </div>
              <CostScatter
                points={points}
                // The picked one outranks the hovered one: a click is a
                // decision and the pointer moves on.
                highlight={expanded ?? hover}
                onHover={setHover}
                onPick={(digest) => {
                  setExpanded(digest);
                  // Opening a row two hundred statements down the list and
                  // leaving it offscreen is the same as doing nothing.
                  rowEls.current
                    .get(digest)
                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }}
              />
            </div>

            <div className="bg-card border border-card rounded-md px-2.5 py-2 min-w-0 flex flex-col">
              <div className="flex items-baseline gap-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">Biggest movers</p>
                <div className="flex-1" />
                <span className="text-[9px] text-ink-faint">change in total time</span>
              </div>
              {moved.length === 0 ? (
                <p className="mt-2 text-[10px] text-ink-faint">
                  Nothing has moved since this pane opened.
                </p>
              ) : (
                <div className="mt-2.5 flex flex-col gap-2">
                  {moved.map((m) => (
                    <div key={m.stat.digest} className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-[10px] text-ink-muted" title={m.stat.sql}>
                        {m.stat.redacted ? 'hidden — run by another user' : shortLabel(m.stat.sql)}
                      </span>
                      {/* A zero in the middle rather than bars from the
                          left, because the sign is the point: watching the
                          number go down after adding an index is why
                          anybody comes back to this pane. */}
                      <span className="w-[96px] shrink-0 flex h-1.5">
                        <span className="w-1/2 flex justify-end">
                          {m.deltaMs < 0 && (
                            <span
                              className="h-1.5 rounded-l-full bg-good/80"
                              style={{ width: `${(Math.abs(m.deltaMs) / worstMove) * 100}%`, minWidth: 4 }}
                            />
                          )}
                        </span>
                        <span className="w-1/2">
                          {m.deltaMs > 0 && (
                            <span
                              className="block h-1.5 rounded-r-full bg-hot/80"
                              style={{ width: `${(m.deltaMs / worstMove) * 100}%`, minWidth: 4 }}
                            />
                          )}
                        </span>
                      </span>
                      <span
                        className={`w-[62px] shrink-0 text-right tabular-nums text-[10px] ${
                          m.deltaMs > 0 ? 'text-hot' : 'text-good/90'
                        }`}
                      >
                        {m.deltaMs > 0 ? '+' : '−'}
                        {ms(Math.abs(m.deltaMs))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex-1" />
              <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
                Worked out here, against the snapshot taken when you opened this pane. Nothing on
                the server was reset.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* The four numbers used to be unlabelled, with only a title
          attribute to say which was which — which is a label you have to
          already know the answer to find. */}
      {rows.length > 0 && (
        <div className="shrink-0 flex items-baseline gap-3 px-3 py-1 border-b border-rule text-[10px] uppercase tracking-wide text-ink-faint">
          <span className="shrink-0 w-20 text-right">total</span>
          <span className="shrink-0 w-16 text-right">calls</span>
          <span className="shrink-0 w-20 text-right">each</span>
          <span className="flex-1">statement</span>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty>
          {window_ === 'since'
            ? 'Nothing has run on this server since you opened this pane.'
            : 'The server has no statements recorded yet.'}
        </Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {rows.map((s) => (
            <Row
              key={s.digest}
              connectionId={connectionId}
              stat={s}
              innerRef={(el) => {
                if (el) rowEls.current.set(s.digest, el);
                else rowEls.current.delete(s.digest);
              }}
              highlight={hover === s.digest}
              onHover={setHover}
              textLimit={support?.supported ? support.textLimit : null}
              share={totalMs > 0 ? s.totalMs / totalMs : 0}
              open={expanded === s.digest}
              onToggle={() => setExpanded(expanded === s.digest ? null : s.digest)}
              onOpen={onOpen}
              onPlan={onPlan}
              onFaster={onFaster}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  connectionId,
  stat,
  textLimit,
  share,
  open,
  onToggle,
  onOpen,
  onPlan,
  onFaster,
  innerRef,
  highlight,
  onHover,
}: {
  connectionId: string;
  stat: StatementStat;
  /// Registered so a click on the plot can scroll this row into view.
  innerRef(el: HTMLDivElement | null): void;
  /// The pointer is over this statement's bubble.
  highlight: boolean;
  onHover(digest: string | null): void;
  /// The server's cap on stored statement text, for explaining a truncated
  /// row. Null where the engine has no single variable to point at.
  textLimit: { parameter: string; bytes: number } | null;
  share: number;
  open: boolean;
  onToggle(): void;
  onOpen(sql: string): void;
  onPlan(sql: string): void;
  onFaster(sql: string): void;
}): JSX.Element {
  const formatStyle = useStore((s) => s.settings.formatStyle);
  const ratio = scanRatio(stat);
  /// A real execution of this statement, looked up only when the row is
  /// opened. `undefined` means not asked yet, `null` means asked and there
  /// is none — and the difference decides whether Plan is missing or merely
  /// pending.
  const [example, setExample] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!open || example !== undefined || stat.redacted || stat.truncated) return;
    let live = true;
    void window.overdb
      .invoke('perf:slowQueryExample', { connectionId, digest: stat.digest })
      .then((v) => live && setExample(v))
      .catch(() => live && setExample(null));
    return () => {
      live = false;
    };
  }, [open, example, connectionId, stat.digest, stat.redacted, stat.truncated]);

  return (
    <div
      ref={innerRef}
      onMouseEnter={() => onHover(stat.digest)}
      onMouseLeave={() => onHover(null)}
      className={`border-b border-rule last:border-0 ${
        // Matches the ring the plot puts round the same statement. Two
        // views of one row have to agree about which row it is.
        highlight ? 'bg-accent/10 shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : ''
      } ${open ? 'bg-wash' : ''}`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 hover:bg-card/40 group"
        // The bar is drawn as a background rather than an element so it sits
        // under the numbers instead of stealing a column from them.
        style={{
          backgroundImage: `linear-gradient(to right, rgb(52 211 153 / 0.10) ${(share * 100).toFixed(2)}%, transparent 0)`,
        }}
      >
        <div className="flex items-baseline gap-3 font-mono text-[11px]">
          <span className="shrink-0 w-20 text-right text-ink tabular-nums" title="Total time">
            {ms(stat.totalMs)}
          </span>
          <span className="shrink-0 w-16 text-right text-ink-muted tabular-nums" title="Calls">
            {count(stat.calls)}×
          </span>
          <span className="shrink-0 w-20 text-right text-ink-muted tabular-nums" title="Mean time per call">
            {ms(stat.meanMs)}
          </span>
          {/* The finding, not the timing. A statement reading ten thousand
              rows to return one is a missing index whether or not it is
              currently slow — it becomes slow when the table grows. */}
          {ratio !== null && ratio >= 100 ? (
            <span
              className="shrink-0 text-[9px] px-1 rounded bg-warn/10 text-warn/90 border border-warn/25"
              title={`Reads about ${count(Math.round(ratio))} rows for every row it returns`}
            >
              {count(Math.round(ratio))}:1 scan
            </span>
          ) : null}
          {stat.noIndexUsed !== null && stat.noIndexUsed > 0 && (
            <span
              className="shrink-0 text-[9px] px-1 rounded bg-warn/10 text-warn/90 border border-warn/25"
              title={`${count(stat.noIndexUsed)} call${stat.noIndexUsed === 1 ? '' : 's'} used no index`}
            >
              no index
            </span>
          )}
          {stat.truncated && (
            <span
              className="shrink-0 text-[9px] px-1 rounded bg-ink-faint/10 text-ink-faint border border-card"
              title="The server stored only the first part of this statement. The rest is gone, not hidden."
            >
              cut off
            </span>
          )}
          <span
            className={`flex-1 truncate ${stat.redacted ? 'text-ink-faint italic' : 'text-ink-muted'}`}
            title={stat.redacted ? undefined : stat.sql}
          >
            {stat.redacted ? 'hidden — run by another user' : stat.sql.replace(/\s+/g, ' ').trim()}
          </span>
        </div>
      </button>

      {open && !stat.redacted && (
        <div className="px-3 pb-2 pl-[92px]">
          <pre className="text-[11px] font-mono text-ink-muted whitespace-pre-wrap bg-surface-muted rounded p-2 overflow-x-auto">
            {formatSql(stat.sql, formatStyle)}
          </pre>
          {stat.truncated && (
            // Said here rather than only on the badge, because this is
            // where someone reads to the end and concludes overdb dropped
            // the rest of their query.
            <p className="mt-1 text-[10px] text-ink-faint">
              The server kept only this much
              {textLimit
                ? ` — ${textLimit.parameter} is ${textLimit.bytes} bytes`
                : ''}
              . The rest was discarded when the statement was recorded, so it cannot be
              fetched. Raising that limit needs a restart and applies to statements recorded
              afterwards.
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-3 text-[10px]">
            <Action
              label="Edit"
              title="Open it in a new editor tab, unrun — your current query stays where it is"
              onClick={() => onOpen(stat.sql)}
            />
            {/* Both hidden on a truncated statement rather than disabled
                with an excuse. EXPLAIN on half a statement is a syntax
                error, and asking a model to speed up a fragment gets you
                confident advice about a query that does not exist — which
                is worse than no button. */}
            {/* Plan appears ONLY with a real execution behind it.
                The normalized text cannot be planned at all — `?` and `$1`
                are not values, so EXPLAIN rejects it — and substituting
                NULL to make it parse turns every predicate into an
                impossible one, which yields a confident plan describing a
                query nobody ran. So this button is absent rather than
                broken, and says why. */}
            {!stat.truncated && example && (
              <Action
                label="Plan this example"
                title="EXPLAIN a real recent execution of this statement, with the values it actually ran with"
                onClick={() => onPlan(example)}
              />
            )}
            {/* Unaffected by any of that: a tuner reads a normalized
                statement perfectly well. Placeholders are not an obstacle
                to "this needs an index on partner_id". */}
            {!stat.truncated && (
              <Action label="Make it faster" title="Hand this statement to the tuner" onClick={() => onFaster(stat.sql)} />
            )}
            <div className="flex-1" />
            {Object.entries(stat.extra)
              .filter(([, v]) => v !== null && v !== 0)
              .map(([k, v]) => (
                <span key={k} className="text-ink-faint tabular-nums whitespace-nowrap">
                  {k} {typeof v === 'number' ? count(v) : String(v)}
                </span>
              ))}
            {stat.maxMs !== null && (
              <span className="text-ink-faint tabular-nums whitespace-nowrap" title="Slowest single call">
                worst {ms(stat.maxMs)}
              </span>
            )}
          </div>
          {!stat.truncated && example === null && (
            <p className="mt-1 text-[10px] text-ink-faint">
              No plan: the values above are placeholders, and the server has no recent
              execution of this statement left to borrow real ones from. Edit it, fill them
              in, and plan it in the editor.
            </p>
          )}
          {example && (
            <details className="mt-1">
              <summary className="text-[10px] text-ink-faint cursor-pointer hover:text-ink-muted">
                Planning a real execution, not the text above
              </summary>
              <pre className="mt-1 text-[10px] font-mono text-ink-faint whitespace-pre-wrap bg-surface-muted rounded p-2 overflow-x-auto">
                {example}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function RedactedBanner(): JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  const grant = 'GRANT pg_read_all_stats TO <your user>';
  if (dismissed) return <></>;
  return (
    <div className="shrink-0 flex items-baseline gap-2 px-3 py-1.5 border-b border-card text-[11px] text-ink-muted">
      <span>
        Showing SQL for your own statements only — this user cannot read other people&apos;s. The
        timings above are still real.
      </span>
      <code className="font-mono text-[10px] text-ink-faint">{grant}</code>
      <button
        onClick={() => void window.overdb.invoke('app:copyText', grant)}
        className="text-[10px] text-ink-faint hover:text-accent"
      >
        Copy
      </button>
      <div className="flex-1" />
      <button onClick={() => setDismissed(true)} className="text-[10px] text-ink-faint hover:text-ink">
        Dismiss
      </button>
    </div>
  );
}

/// The empty state IS the feature here. A pane that says nothing when it
/// cannot read the history sends you looking for a bug in overdb; one that
/// names the parameter and hands you the statement sends you to the right
/// place, which is usually somebody else's terminal.
function Unavailable({
  reason,
  onRetry,
}: {
  reason: SlowQueryUnavailable;
  onRetry(): void;
}): JSX.Element {
  const fix =
    reason.code === 'not-installed' ? reason.ddl
    : reason.code === 'permission-denied' ? reason.grant
    : reason.code === 'disabled' ? reason.sql
    : undefined;

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-8">
      <div className="max-w-lg text-center">
        <p className="text-xs text-ink">{reason.detail}</p>

        {reason.code === 'needs-restart' && (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            The parameter is <code className="font-mono">{reason.parameter}</code>.
            {reason.managed
              ? ' overdb cannot change it — it is set in the parameter group and takes effect on reboot.'
              : ' overdb cannot change it — it is read at server startup.'}
          </p>
        )}

        {fix && (
          <div className="mt-3">
            <p className="text-[10px] text-ink-faint mb-1">
              {reason.code === 'permission-denied'
                ? 'What a DBA would run:'
                : 'What turns it on:'}
            </p>
            <div className="flex items-center gap-2 justify-center">
              <code className="font-mono text-[11px] text-ink-muted bg-surface-muted rounded px-2 py-1 overflow-x-auto">
                {fix}
              </code>
              <button
                onClick={() => void window.overdb.invoke('app:copyText', fix)}
                className="shrink-0 text-[10px] text-ink-faint hover:text-accent"
              >
                Copy
              </button>
            </div>
            {reason.code === 'disabled' && (
              <p className="mt-1.5 text-[10px] text-ink-faint">
                It reverts when the server restarts.
              </p>
            )}
          </div>
        )}

        {reason.code === 'probe-failed' && (
          <p className="mt-2 text-[11px] text-bad-strong/80 font-mono whitespace-pre-wrap">
            {reason.serverMessage}
          </p>
        )}

        {/* Absent where it would be a lie: a restart and a different engine
            are not things a button here can retry into existence. */}
        {isRetryable(reason) && (
          <button
            onClick={onRetry}
            title="Ask again. A GRANT takes effect on this connection without reconnecting."
            className="mt-3 text-[11px] px-2 py-0.5 rounded border border-card text-ink-faint hover:text-ink hover:bg-card"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange(v: T): void;
  options: Array<{ value: T; label: string; title: string }>;
}): JSX.Element {
  return (
    <div className="flex items-stretch rounded border border-card overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 text-[10px] whitespace-nowrap ${
            o.value === value ? 'bg-card text-ink' : 'text-ink-faint hover:text-ink-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Action({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick(): void;
}): JSX.Element {
  return (
    <button onClick={onClick} title={title} className="text-ink-faint hover:text-accent">
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center text-xs text-ink-faint px-8 text-center">
      {children}
    </div>
  );
}

/// Milliseconds are the unit the servers report, but they are not the unit
/// anyone reads: nobody parses "412839 ms". Scaled at the point of display
/// so sorting still happens on the real number.
function ms(v: number): string {
  if (v >= 60_000) return `${(v / 60_000).toFixed(1)} min`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)} s`;
  if (v >= 10) return `${Math.round(v)} ms`;
  return `${v.toFixed(2)} ms`;
}

/// A few words naming a statement, for a plot point or a movers row.
///
/// Not a summary and not the SQL: enough to recognise which row of the
/// list below it is, which is all a label on a chart has room to be.
export function shortLabel(sql: string): string {
  const verb = /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? '';
  const table = /\b(?:from|into|update|join)\s+["`[]?([\w.]+)/i.exec(sql)?.[1];
  return table ? `${verb} ${table}` : verb || 'statement';
}

function count(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toLocaleString();
}
