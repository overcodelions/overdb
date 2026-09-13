import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "@shared/types";
import {
  formatBytes,
  formatDuration,
  killSupport,
  mergePulse,
  pushSample,
  readings,
  seqScanOffenders,
  sessionStates,
  splitReadings,
  unusedIndexSummary,
  waitEvents,
  type HealthPanel,
  type HealthScope,
  type HealthSnapshot,
  type ReadingTone,
  type Session,
} from "@shared/health";
import { BarRow, CapacityBar, Sparkline, SplitBar, StateMeter } from "./Marks";
import { useStore } from "./store";

/// What this server is doing right now.
///
/// The counterpart to the slow-query pane: that one is the server's memory,
/// this one is its pulse. Both read statistics views and nothing else — no
/// row of anyone's data is touched here, and nothing on this screen is
/// affected by whether writes are armed.
///
/// Except one thing, and it is called out where it lives: cancelling
/// somebody's statement. That acts on the server, so it is gated in main
/// with the same typed-name rule that arming writes uses, and the button
/// says which of the two verbs it is.
///
/// The pane has two densities, and they answer different questions.
/// Expanded it fills the window and is a dashboard: the vitals across the
/// top, the session list given the height of the window, and everything
/// that explains it in a column beside — what those sessions are waiting
/// on, then the sizes, the scans and the indexes nobody uses. The list is
/// the thing you came for and the rest is reference, which is why the
/// reference is the part that goes narrow.
/// Docked under the editor it is a glance: the vitals strip and the worst
/// sessions, which is all there is room for and all you want while you are
/// still writing the query above it.

const TONE: Record<ReadingTone, string> = {
  good: "text-good/90",
  watch: "text-warn/90",
  bad: "text-bad/90",
  unknown: "text-ink-faint",
};

const REFRESH_OPTIONS = [0, 1, 5, 15, 60] as const;

/// How stale the storage half is allowed to get before a tick re-reads it.
///
/// Table sizes and index counters move on the scale of hours; a minute of
/// lag on them is not a reading anybody would act on differently. At a 60s
/// refresh this changes nothing — every tick reads everything, as it always
/// did. At 1s it is the difference between 60 relation walks a minute and
/// one.
const STORAGE_EVERY_MS = 60_000;

/// The series drawn on the vitals cards, built entirely on this side.
///
/// Neither engine keeps a history of any of this — every read is a
/// snapshot of the instant — so there is no last hour to ask for. What
/// there is, is the reads this pane has already made, which is why every
/// sparkline is captioned with when the pane opened rather than with a
/// duration. Drawing a smooth twenty-four hours would be inventing data,
/// and it is the same reason the slow-query pane defaults to "since
/// opened" instead of showing all-time totals nobody can act on.
interface Series {
  connections: number[];
  cache: number[];
  rollback: number[];
  since: number;
}

const EMPTY_SERIES: Series = {
  connections: [],
  cache: [],
  rollback: [],
  since: Date.now(),
};

export function HealthPane({
  connection,
  onOpenSql,
  full,
  onToggleFull,
  onClose,
}: {
  connection: Connection;
  /// Put a statement in the editor — reading a session's query and then
  /// having to retype it is the gap this closes.
  onOpenSql?(sql: string): void;
  /// Whether the pane has the whole window or is docked under the editor.
  full: boolean;
  onToggleFull(): void;
  /// Back to the result of whatever you last ran.
  onClose(): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const askConfirm = useStore((s) => s.askConfirm);

  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [everyN, setEveryN] = useState<number>(15);
  const [showIdle, setShowIdle] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [series, setSeries] = useState<Series>(EMPTY_SERIES);
  /// When the storage half was last actually measured — the clock the poll
  /// below re-reads it against. Not rendered: at a fast refresh, an age
  /// captioned on each panel is a number changing once a second on the one
  /// part of the screen that is deliberately not news. The footer says the
  /// cadence once instead.
  const [storageAt, setStorageAt] = useState<number | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  /// The same 'open' | 'closed' | 'error' the sidebar dot is drawn from.
  const connected = useStore((s) => s.connState[connection.id]) === "open";

  const refresh = useCallback(
    async (scope: HealthScope = "full") => {
      // Reads never stack. A server in trouble is exactly the server whose
      // reads take longer than the interval, and queueing another one behind
      // the last is adding load to the thing you are watching fall over.
      if (inFlight.current) return;
      inFlight.current = true;
      // Only a read somebody asked for says it is reading. At 1s the pulse
      // would otherwise flicker the button once a second, which reads as a
      // struggling pane rather than a working one.
      if (scope === "full") setLoading(true);
      try {
        const snapshot = await window.overdb.invoke(
          "perf:health",
          connection.id,
          scope,
        );
        if (!live.current) return;
        if (scope === "full") setStorageAt(Date.now());
        // A pulse did not ask about sizes or indexes, and its empty lists
        // mean "did not ask" rather than "nothing there".
        setHealth((prev) =>
          scope === "pulse" && prev ? mergePulse(prev, snapshot) : snapshot,
        );
        setSeries((prev) => sample(prev, snapshot));
        setError(null);
      } catch (err) {
        if (!live.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight.current = false;
        if (live.current && scope === "full") setLoading(false);
      }
    },
    [connection.id],
  );

  useEffect(() => {
    live.current = true;
    // Thrown away on every connection change rather than kept per id: a
    // line that jumps from one server's numbers to another's, with no
    // break to say so, is the one chart shape that can get somebody paged
    // about the wrong database.
    setSeries({ ...EMPTY_SERIES, since: Date.now() });
    setStorageAt(null);
    void refresh("full");
    return () => {
      live.current = false;
    };
  }, [refresh]);

  // Polling is opt-in and visible, and what it polls is the pulse: the
  // sessions, the connection count, the counters, the replicas. That is
  // what makes a one-second option something other than a way to put a
  // production server in its own slow-query list — the half that costs
  // real work is re-read on the slow cadence below, or on Read now.
  //
  // Held in a ref so that re-reading the storage half does not re-create
  // the callback and restart the timer underneath the user.
  const tick = useRef<() => void>(() => {});
  tick.current = () => {
    // Not against a connection that is not open. Main opens a connection
    // for a read somebody asked for, which is what makes opening this pane
    // work — but a timer is nobody asking, and a poll that reconnects
    // would put back, every few seconds, a connection the user closed.
    if (!connected) return;
    const stale =
      storageAt === null || Date.now() - storageAt >= STORAGE_EVERY_MS;
    void refresh(stale ? "full" : "pulse");
  };

  useEffect(() => {
    if (everyN === 0) return;
    const timer = setInterval(() => tick.current(), everyN * 1000);
    return () => clearInterval(timer);
  }, [everyN]);

  const support = killSupport(connection.engine);

  const sessions = useMemo(() => {
    const all = health?.sessions ?? [];
    const shown = showIdle
      ? all
      : all.filter((s) => s.state !== "idle" || s.blockedBy.length > 0);
    // Worst first, and "worst" is not "oldest": a session blocked on a
    // lock is the reason anybody opened this pane, and one holding an
    // open transaction is the reason it is blocked. Age only breaks ties
    // inside a bucket.
    return [...shown].sort(
      (a, b) => rank(a) - rank(b) || (b.seconds ?? 0) - (a.seconds ?? 0),
    );
  }, [health, showIdle]);

  const kill = (session: Session, terminate: boolean) => {
    const verb = terminate ? "Close this connection" : "Cancel this statement";
    askConfirm({
      title: `${verb}?`,
      body: terminate
        ? `Session ${session.id}${session.user ? ` (${session.user})` : ""} will be disconnected and whatever it was doing rolled back.\n\n${session.query ?? ""}`
        : `The statement session ${session.id} is running will stop. The connection stays open and its client gets an error.\n\n${session.query ?? ""}`,
      confirmLabel: terminate ? "Close it" : "Cancel it",
      destructive: terminate,
      async onConfirm() {
        setBusySession(session.id);
        try {
          const res = await window.overdb.invoke("perf:killSession", {
            connectionId: connection.id,
            sessionId: session.id,
            terminate,
            // main requires the typed name on a prod connection. Passing it
            // here means the dialog above is the confirmation for
            // everything else and prod still gets its own refusal, with the
            // instruction in it, rather than a silently different flow.
            confirm: connection.name,
          });
          if (res.ok) {
            toast(
              terminate
                ? `Session ${session.id} closed.`
                : `Asked session ${session.id} to stop.`,
            );
            await refresh();
          } else {
            toast(res.error ?? "The server declined.", "error");
          }
        } finally {
          setBusySession(null);
        }
      },
    });
  };

  const rows = health ? readings(health) : [];
  const { charted, counts } = splitReadings(rows);
  const states = health ? sessionStates(health) : null;
  const waits = health ? waitEvents(health) : [];
  const unused = health ? unusedIndexSummary(health) : null;
  const scans = health ? seqScanOffenders(health) : [];
  const since = new Date(series.since).toLocaleTimeString(undefined, {
    hour12: false,
  });

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b border-card px-3.5 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-ink">Health</span>
        <span className="text-[11px] text-ink-faint min-w-0 truncate">
          {connection.name}
          {health?.serverVersion && (
            <> · {shortVersion(health.serverVersion)}</>
          )}
          {health?.uptimeSeconds !== null &&
            health?.uptimeSeconds !== undefined && (
              <> · up {formatDuration(health.uptimeSeconds)}</>
            )}
        </span>

        <div className="flex-1" />

        {everyN > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-good/80" />
            live
          </span>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          refresh
          <select
            value={everyN}
            onChange={(e) => setEveryN(Number(e.target.value))}
            className="bg-surface-muted border border-card rounded px-1 py-0.5 text-ink"
          >
            {REFRESH_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "manual" : `${n}s`}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void refresh("full")}
          disabled={loading}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card disabled:opacity-40"
        >
          {loading ? "Reading…" : "Read now"}
        </button>
        <span className="w-px h-3.5 bg-card" />
        <button
          onClick={onToggleFull}
          title={
            full
              ? "Dock it under the editor — the vitals and the worst sessions, with your query still in view"
              : "Fill the window — sizes, indexes and what every session is waiting on"
          }
          className="text-[11px] px-1.5 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-card"
        >
          {full ? "⤡" : "⤢"}
          <span className="ml-1">{full ? "Dock" : "Expand"}</span>
        </button>
        <button
          onClick={onClose}
          title="Back to your results"
          aria-label="Close health"
          className="text-[11px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-card"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error !== null ? (
          <p className="px-3.5 py-3 text-[11px] text-bad/90">{error}</p>
        ) : health === null ? (
          <p className="px-3.5 py-3 text-[11px] text-ink-faint">
            Reading the server's statistics…
          </p>
        ) : full ? (
          <div className="p-3 flex flex-col gap-3">
            {charted.length > 0 && (
              /* Edge to edge and equal, rather than a row of cards capped
                 at 400px with the rest of a wide window left empty. The
                 connection bar is the one that needs the width: its
                 threshold labels sit at the fraction they mark, and they
                 collide with each other in a narrow card.

                 The cap on the card, rather than on the track, is for the
                 engines that answer fewer of these: Redshift has no cache
                 ratio and no rollback counters, and two cards sharing a
                 wide window between them would otherwise each be a slab
                 with a number in the corner. */
              <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2.5">
                {charted.map((r) => (
                  <div
                    key={r.key}
                    className="bg-card border border-card rounded-md px-3 py-2 flex flex-col min-w-0 max-w-[560px]"
                  >
                    <p className="text-[10px] uppercase tracking-wide text-ink-faint">
                      {r.label}
                    </p>
                    <p
                      className={`text-[21px] leading-tight tabular-nums ${TONE[r.tone]}`}
                    >
                      {r.value}
                    </p>
                    <div className="mt-2">
                      <Mark
                        reading={r.key}
                        health={health}
                        series={series}
                        tone={TONE[r.tone]}
                      />
                    </div>
                    {((r.key === "cache" && series.cache.length > 1) ||
                      (r.key === "rollbacks" &&
                        series.rollback.length > 1)) && (
                      <p className="mt-0.5 text-[9px] text-ink-faint">
                        since you opened this tab, {since}
                      </p>
                    )}
                    <div className="flex-1" />
                    {/* The sentence is not optional garnish: a number with
                        nothing next to it is a number nobody acts on. */}
                    <p className="mt-1.5 text-[10px] text-ink-faint leading-snug text-pretty">
                      {r.note}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {counts.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px]">
                {counts.map((r) => (
                  <span
                    key={r.key}
                    className="flex items-center gap-1.5 min-w-0"
                    title={r.note}
                  >
                    <span
                      className={`w-[5px] h-[5px] rounded-full bg-current ${TONE[r.tone]}`}
                    />
                    <span className="uppercase tracking-wide text-ink-faint">
                      {r.label}
                    </span>
                    <span className={`tabular-nums ${TONE[r.tone]}`}>
                      {r.value}
                    </span>
                  </span>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-3 items-start">
              <div className="bg-card border border-card rounded-md min-w-0">
                <SessionHeader
                  states={states}
                  showIdle={showIdle}
                  onShowIdle={setShowIdle}
                  hasSessions={health.sessions.length > 0}
                />
                <div
                  /* A fixed height that fills what the window has left,
                     rather than one that shrinks to fit the rows: sessions
                     come and go on every read, and a box that resizes under
                     the list makes everything below it jump once a second.
                     Nothing overflows sideways — the table is fixed-layout —
                     so the horizontal axis is clipped rather than left to
                     grow a scrollbar the vertical one implies. */
                  className="h-[clamp(248px,calc(100vh-330px),900px)] overflow-y-auto overflow-x-hidden mt-1"
                >
                  {health.sessions.length === 0 ? (
                    <Empty>
                      {support.note ??
                        "No client sessions, or this server did not let us read them."}
                    </Empty>
                  ) : sessions.length === 0 ? (
                    /* Every session there is, is filtered out. An empty
                       table under a header saying 432 are connected reads
                       as a broken pane; the count and the way to see them
                       is the whole answer. */
                    <Empty>
                      {health.sessions.length.toLocaleString()} idle session
                      {health.sessions.length === 1 ? " is" : "s are"} hidden.
                      Tick <span className="text-ink">include idle</span> to see
                      them.
                    </Empty>
                  ) : (
                    <SessionTable
                      sessions={sessions}
                      support={support}
                      busySession={busySession}
                      onKill={kill}
                      onOpenSql={onOpenSql}
                    />
                  )}
                </div>
                <p className="px-3 py-1.5 text-[10px] text-ink-faint border-t border-rule">
                  Sorted by what is blocking, then by age.
                  {everyN > 0 && <> Re-read every {everyN}s.</>}
                </p>
              </div>

              <div className="flex flex-col gap-3 min-w-0">
                <Card
                  title="What they are waiting on"
                  bodyClass="min-h-[132px]"
                >
                  {waits.length === 0 ? (
                    <p className="text-[10px] text-ink-faint">
                      Nothing is waiting on anything this server will name.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {waits[0].count === 1
                        ? waits.map((w) => (
                            <div
                              key={w.event}
                              className={`flex items-baseline gap-2 text-[10px] ${
                                w.blocking ? "text-bad/90" : "text-ink-muted"
                              }`}
                            >
                              <span
                                className={`w-[5px] h-[5px] rounded-full bg-current ${
                                  w.blocking ? "" : "text-accent"
                                }`}
                              />
                              <span className="min-w-0 truncate">
                                {w.event}
                              </span>
                            </div>
                          ))
                        : waits.map((w) => (
                            <BarRow
                              key={w.event}
                              label={w.event}
                              value={w.count}
                              ratio={w.count / waits[0].count}
                              tone={w.blocking ? "text-bad/90" : "text-accent"}
                            />
                          ))}
                    </div>
                  )}
                  <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
                    A count of who is in each state at this instant — not time
                    spent. Neither engine hands a client that without summary
                    tables most managed servers leave off.
                  </p>
                </Card>

                {/* Everything that is not the session list lives in this
                    column. They are all the same shape — a name, a bar, a
                    number — which reads fine narrow, and stacking them here
                    rather than in a strip along the bottom leaves the list
                    the whole height of the window instead of a third of
                    it. */}
                {health.tables.length > 0 && <Tables health={health} />}

                {scans.length > 0 && <ReadHardest scans={scans} />}

                {unused !== null && (
                  <UnusedIndexes health={health} summary={unused} />
                )}

                {/* What this engine says about itself that the others
                    have no word for. Drawn without knowing what it is:
                    the adapter decided both the title and the rows. */}
                {health.panels.map((panel) => (
                  <PanelCard key={panel.key} panel={panel} />
                ))}

                {health.replication.length > 0 && (
                  <Replication health={health} />
                )}
              </div>
            </div>

            {health.notes.length > 0 && (
              <Card title="What this server would not say">
                {/* Kept rather than swallowed: "you need pg_stat_statements"
                    is a more useful answer than an empty panel, and a
                    permission error looks exactly like a bug otherwise. */}
                {health.notes.map((note, i) => (
                  <p
                    key={i}
                    className="text-[10px] text-ink-faint leading-relaxed"
                  >
                    · {note}
                  </p>
                ))}
              </Card>
            )}

            {/* The cadence is stated here rather than captioned on each
                panel it applies to: at a fast refresh a per-card age is a
                number that changes every second, which reads as noise and
                draws the eye to the one part of the screen that is not
                news. */}
            <p className="text-[10px] text-ink-faint">
              Read from this server's own statistics views. No table data was
              queried, and none of it depends on whether writes are armed.
              {everyN > 0 && (
                <>
                  {" "}
                  Sizes, scans and index counters are re-read once a minute;
                  everything else every {everyN}s.
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            {charted.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] border-b border-card">
                {charted.map((r) => (
                  <div
                    key={r.key}
                    className="px-3 py-1.5 border-r border-rule last:border-r-0"
                  >
                    <p className="text-[10px] uppercase tracking-wide text-ink-faint">
                      {r.label}
                    </p>
                    <p
                      className={`text-[15px] leading-tight tabular-nums ${TONE[r.tone]}`}
                    >
                      {r.value}
                    </p>
                    <div className="mt-1">
                      <Mark
                        reading={r.key}
                        health={health}
                        series={series}
                        tone={TONE[r.tone]}
                        compact
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <SessionHeader
              states={states}
              showIdle={showIdle}
              onShowIdle={setShowIdle}
              hasSessions={health.sessions.length > 0}
              meter={false}
            />
            {health.sessions.length === 0 ? (
              <Empty>
                {support.note ??
                  "No client sessions, or this server did not let us read them."}
              </Empty>
            ) : sessions.length === 0 ? (
              <Empty>
                {health.sessions.length.toLocaleString()} idle session
                {health.sessions.length === 1 ? " is" : "s are"} hidden. Tick{" "}
                <span className="text-ink">include idle</span> to see them.
              </Empty>
            ) : (
              <SessionTable
                sessions={sessions}
                support={support}
                busySession={busySession}
                onKill={kill}
                onOpenSql={onOpenSql}
              />
            )}

            <p className="px-3.5 py-2 text-[10px] text-ink-faint">
              Worst first.{" "}
              <button
                onClick={onToggleFull}
                className="underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                Expand
              </button>{" "}
              for what they are waiting on, table sizes and the indexes the
              planner never chose.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/// Record one reading of each charted measure.
///
/// Split out so the rule is in one place: a measure the server withheld
/// contributes nothing rather than a zero. A gap in a series is honest; a
/// zero is a reading nobody took, and on a cache-hit chart it is a reading
/// that looks like an outage.
function sample(prev: Series, snapshot: HealthSnapshot): Series {
  const txns = snapshot.transactions;
  const totalTxns = txns ? txns.committed + txns.rolledBack : 0;
  return {
    since: prev.since,
    connections: pushSample(
      prev.connections,
      snapshot.connections?.used ?? null,
    ),
    cache: pushSample(prev.cache, snapshot.cacheHitRatio),
    rollback: pushSample(
      prev.rollback,
      totalTxns > 0 ? txns!.rolledBack / totalTxns : null,
    ),
  };
}

/// Which mark belongs under which reading.
///
/// A ceiling gets a capacity bar, a ratio gets a series in the band it
/// actually moves in, and a size gets the split between the rows you keep
/// and the indexes you pay for on every write.
function Mark({
  reading,
  health,
  series,
  tone,
  compact = false,
}: {
  reading: string;
  health: HealthSnapshot;
  series: Series;
  tone: string;
  compact?: boolean;
}): JSX.Element | null {
  const height = compact ? 16 : 28;

  if (reading === "connections") {
    const max = health.connections?.max ?? null;
    if (max === null || max <= 0) {
      return (
        <Sparkline series={series.connections} tone={tone} height={height} />
      );
    }
    return (
      <CapacityBar
        ratio={(health.connections?.used ?? 0) / max}
        tone={tone}
        // The same two fractions `readings()` changes tone at. The bar, the
        // colour and the sentence under it all come from one threshold, so
        // they cannot drift apart.
        thresholds={
          compact
            ? [{ at: 0.9, label: "", danger: true }]
            : [
                { at: 0.7, label: String(Math.round(max * 0.7)) },
                {
                  at: 0.9,
                  label: `refused at ${Math.round(max * 0.9)}`,
                  danger: true,
                },
              ]
        }
      />
    );
  }

  if (reading === "cache") {
    // 0..1 would draw every healthy server as the same flat line pinned to
    // the top, hiding the only movement a cache ratio ever has.
    const lo = Math.min(
      0.95,
      ...(series.cache.length > 0 ? series.cache : [0.95]),
    );
    return (
      <Sparkline
        series={series.cache}
        tone={tone}
        band={[lo, 1]}
        height={height}
      />
    );
  }

  if (reading === "rollbacks") {
    return <Sparkline series={series.rollback} tone={tone} height={height} />;
  }

  if (reading === "size") {
    const indexBytes = health.tables.reduce(
      (a, t) => a + (t.indexBytes ?? 0),
      0,
    );
    const total = health.databaseBytes ?? 0;
    if (indexBytes <= 0 || total <= 0) return null;
    return (
      <div>
        <div className="flex gap-0.5 h-[7px]">
          <div
            className="bg-accent rounded-l-[3px]"
            style={{
              width: `${Math.max(0, ((total - indexBytes) / total) * 100)}%`,
            }}
          />
          <div className="flex-1 bg-accent/40 rounded-r-[3px]" />
        </div>
        {!compact && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[9px] text-ink-faint">
            <span className="flex items-center gap-1">
              <span className="w-[5px] h-[5px] rounded-full bg-accent" />
              {formatBytes(Math.max(0, total - indexBytes))} rows
            </span>
            <span className="flex items-center gap-1">
              <span className="w-[5px] h-[5px] rounded-full bg-accent/40" />
              {formatBytes(indexBytes)} indexes
            </span>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function SessionHeader({
  states,
  showIdle,
  onShowIdle,
  hasSessions,
  meter = true,
}: {
  states: ReturnType<typeof sessionStates> | null;
  showIdle: boolean;
  onShowIdle(v: boolean): void;
  hasSessions: boolean;
  meter?: boolean;
}): JSX.Element {
  return (
    <div className={meter ? "px-3 pt-2" : "px-3.5 pt-2 pb-1"}>
      <div className="flex items-center gap-2">
        <p className="text-[10px] uppercase tracking-wide text-ink-faint">
          Sessions
        </p>
        {states && (
          <span className="text-[10px] text-ink-faint">
            {states.total.toLocaleString()} connected ·{" "}
            {states.awake.toLocaleString()} awake
          </span>
        )}
        <div className="flex-1" />
        {hasSessions && (
          <label className="flex items-center gap-1.5 text-[10px] text-ink-faint">
            <input
              type="checkbox"
              checked={showIdle}
              onChange={(e) => onShowIdle(e.target.checked)}
            />
            include idle
          </label>
        )}
      </div>
      {meter && states && states.total > 0 && (
        <div className="mt-2">
          <StateMeter
            total={states.total}
            segments={[
              {
                key: "active",
                label: "active",
                count: states.active,
                tone: "text-good/90",
              },
              {
                key: "idle-txn",
                label: "idle in transaction",
                count: states.idleInTransaction,
                tone: "text-warn/90",
              },
              {
                key: "blocked",
                label: "blocked",
                count: states.blocked,
                tone: "text-bad/90",
              },
              {
                key: "idle",
                label: "idle",
                count: states.idle,
                tone: "text-ink-faint",
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function SessionTable({
  sessions,
  support,
  busySession,
  onKill,
  onOpenSql,
}: {
  sessions: Session[];
  support: ReturnType<typeof killSupport>;
  busySession: string | null;
  onKill(session: Session, terminate: boolean): void;
  onOpenSql?(sql: string): void;
}): JSX.Element {
  return (
    <table className="w-full text-[11px] table-fixed">
      <thead className="sticky top-0 z-10">
        {/* The background is on the cells rather than the row: a sticky
            <tr> does not paint one in every engine, and a transparent
            header with rows sliding under it is worse than none. */}
        <tr className="text-[10px] uppercase tracking-wide text-ink-faint text-left [&>th]:bg-surface-muted">
          <th className="px-3 py-1 font-normal w-[84px]">id</th>
          <th className="px-2 py-1 font-normal w-[124px]">who</th>
          <th className="px-2 py-1 font-normal w-[150px]">state</th>
          <th className="px-2 py-1 font-normal w-[70px] text-right">for</th>
          <th className="px-2 py-1 font-normal">statement</th>
          <th className="px-2 py-1 font-normal w-[96px]" />
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            support={support}
            busy={busySession === s.id}
            onKill={onKill}
            onOpenSql={onOpenSql}
          />
        ))}
      </tbody>
    </table>
  );
}

function Tables({ health }: { health: HealthSnapshot }): JSX.Element {
  const rows = health.tables.slice(0, 10);
  const scale = Math.max(...rows.map((t) => t.bytes + (t.indexBytes ?? 0)), 1);
  // Worth a sentence only when it is true of this database. A table with
  // more index than row is the shape a table takes after years of one-off
  // indexes, and it is invisible in a column of totals.
  const topHeavy = rows.find((t) => (t.indexBytes ?? 0) > t.bytes);

  return (
    <Card
      title="Biggest tables"
      right={
        <div className="flex gap-2.5 text-[9px] text-ink-faint">
          <span className="flex items-center gap-1">
            <span className="w-[5px] h-[5px] rounded-full bg-accent" />
            rows
          </span>
          <span className="flex items-center gap-1">
            <span className="w-[5px] h-[5px] rounded-full bg-accent/40" />
            indexes
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map((t) => (
          <div
            key={`${t.schema}.${t.table}`}
            className="flex items-center gap-2"
          >
            <span
              className={`w-[38%] shrink-0 truncate font-mono text-[10px] ${
                (t.indexBytes ?? 0) > t.bytes
                  ? "text-warn/90"
                  : "text-ink-muted"
              }`}
              title={`${t.schema}.${t.table}`}
            >
              {t.schema}.{t.table}
            </span>
            <SplitBar
              primary={t.bytes}
              secondary={t.indexBytes}
              scale={scale}
            />
            <span className="shrink-0 w-[54px] text-right tabular-nums text-[10px] text-ink">
              {formatBytes(t.bytes + (t.indexBytes ?? 0))}
            </span>
          </div>
        ))}
      </div>
      {topHeavy && (
        <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
          {topHeavy.table} carries more index than row.
        </p>
      )}
    </Card>
  );
}

function ReadHardest({
  scans,
}: {
  scans: ReturnType<typeof seqScanOffenders>;
}): JSX.Element {
  const rows = scans.slice(0, 6);
  const scale = Math.max(...rows.map((s) => s.sequentialRowsRead), 1);
  return (
    <Card
      title="Read hardest"
      right={
        <span className="text-[9px] text-ink-faint">rows read end to end</span>
      }
    >
      <div className="flex flex-col gap-2">
        {rows.map((s) => (
          <BarRow
            key={`${s.schema}.${s.table}`}
            label={
              <span className="font-mono">
                {s.schema}.{s.table}
              </span>
            }
            value={s.sequentialRowsRead.toLocaleString()}
            ratio={s.sequentialRowsRead / scale}
            tone="text-hot"
            note={
              <>
                over {s.sequentialScans.toLocaleString()} scans
                {s.indexScans > 0 && (
                  <> · {s.indexScans.toLocaleString()} index scans</>
                )}
              </>
            }
          />
        ))}
      </div>
      <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
        Ranked by rows read, not by scans — reading a small table end to end is
        often the right plan.
      </p>
    </Card>
  );
}

function UnusedIndexes({
  health,
  summary,
}: {
  health: HealthSnapshot;
  summary: string;
}): JSX.Element {
  const all = health.unusedIndexes.filter((ix) => !ix.unique);
  const rows = all.slice(0, 6);
  const scale = Math.max(...rows.map((ix) => ix.bytes ?? 0), 1);
  /// MySQL's sys.schema_unused_indexes names the indexes and nothing else.
  /// Rather than a column of dashes, the size column is simply absent.
  const sized = rows.some((ix) => ix.bytes !== null);
  return (
    <Card title="Indexes the planner never chose">
      <div className="flex flex-col gap-1.5">
        {rows.map((ix) => (
          <div
            key={`${ix.schema}.${ix.index}`}
            className="flex items-center gap-2"
          >
            <span
              className="flex-1 min-w-0 truncate font-mono text-[10px] text-ink-muted"
              title={`${ix.index} on ${ix.schema}.${ix.table}`}
            >
              {ix.index}{" "}
              <span className="text-ink-faint">
                on {ix.schema}.{ix.table}
              </span>
            </span>
            {sized && (
              <>
                <span className="w-14 shrink-0 h-[5px] rounded-full bg-wash-strong">
                  <span
                    className="block h-[5px] rounded-full bg-accent/60"
                    style={{ width: `${((ix.bytes ?? 0) / scale) * 100}%` }}
                  />
                </span>
                <span className="shrink-0 w-[48px] text-right tabular-nums text-[10px] text-ink-muted">
                  {formatBytes(ix.bytes ?? 0)}
                </span>
              </>
            )}
          </div>
        ))}
        {all.length > rows.length && (
          <p className="text-[10px] text-ink-faint">
            + {all.length - rows.length} more
          </p>
        )}
      </div>
      <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
        {summary}
      </p>
    </Card>
  );
}

function Replication({ health }: { health: HealthSnapshot }): JSX.Element {
  const scale = Math.max(...health.replication.map((r) => r.lagBytes ?? 0), 1);
  return (
    <Card
      title={`Replicas ${health.replication.length}`}
      right={
        <span className="text-[9px] text-ink-faint">
          64 MB is where a read starts reading the past
        </span>
      }
    >
      <div className="flex flex-col gap-1.5">
        {health.replication.map((r, i) => (
          <div key={r.client ?? i} className="flex items-center gap-2">
            <span className="w-[38%] shrink-0 truncate font-mono text-[10px] text-ink-muted">
              {r.client ?? "replica"}
              {r.state && <span className="text-ink-faint"> · {r.state}</span>}
            </span>
            <span className="flex-1 h-[5px] rounded-full bg-wash-strong">
              <span
                className={`block h-[5px] rounded-full bg-current ${
                  (r.lagBytes ?? 0) > 64 * 1024 * 1024
                    ? "text-warn/90"
                    : "text-good/90"
                }`}
                style={{ width: `${((r.lagBytes ?? 0) / scale) * 100}%` }}
              />
            </span>
            <span className="shrink-0 w-[52px] text-right tabular-nums text-[10px] text-ink-muted">
              {r.lagBytes === null ? "—" : formatBytes(r.lagBytes)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
        Bars are scaled to the worst replica, not to the threshold.
      </p>
    </Card>
  );
}

function Card({
  title,
  right,
  children,
  grow = "",
  bodyClass = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  /// Flex sizing for the wrapping rows. Passed rather than fixed because
  /// the storage panels share a row whose membership depends on what this
  /// particular server would answer.
  grow?: string;
  /// Usually a floor under a card whose contents change on every read, so
  /// a shorter list does not drag the rest of the page up.
  bodyClass?: string;
}): JSX.Element {
  return (
    <div
      className={`bg-card border border-card rounded-md px-3 py-2 min-w-0 ${grow}`}
    >
      <div className="flex items-baseline gap-2 mb-2">
        <p className="text-[10px] uppercase tracking-wide text-ink-faint">
          {title}
        </p>
        <div className="flex-1" />
        {right}
      </div>
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

/// One of the panels an adapter described for itself.
///
/// Deliberately the only thing in this file that renders content it did
/// not choose the shape of — which is what keeps an engine's own facts an
/// adapter change rather than a renderer change.
function PanelCard({ panel }: { panel: HealthPanel }): JSX.Element {
  return (
    <Card title={panel.title}>
      {panel.rows.length === 0 ? (
        <p className="text-[10px] text-ink-faint">
          {panel.empty ?? "Nothing to report."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {panel.rows.map((row) => (
            <div key={row.label} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 font-mono text-[10px] text-ink-muted">
                <span className="block truncate" title={row.label}>
                  {row.label}
                </span>
                {row.sub && (
                  <span className="block truncate text-ink-faint">
                    {row.sub}
                  </span>
                )}
              </span>
              {row.ratio !== undefined && (
                <span className="w-14 shrink-0 h-[5px] rounded-full bg-wash-strong">
                  <span
                    className={`block h-[5px] rounded-full bg-current ${TONE[row.tone ?? "unknown"]}`}
                    style={{
                      width: `${Math.max(0, Math.min(1, row.ratio)) * 100}%`,
                    }}
                  />
                </span>
              )}
              <span
                className={`shrink-0 w-[64px] text-right tabular-nums text-[10px] ${TONE[row.tone ?? "unknown"]}`}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {panel.note && (
        <p className="mt-2 text-[10px] text-ink-faint leading-snug text-pretty">
          {panel.note}
        </p>
      )}
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="px-3.5 py-2 text-[11px] text-ink-faint">{children}</p>;
}

/// Worst first: blocked, then holding a transaction open, then running,
/// then everything else. The order the list is read in, not the order the
/// server happened to return.
function rank(s: Session): number {
  if (s.blockedBy.length > 0) return 0;
  if ((s.state ?? "").startsWith("idle in transaction")) return 1;
  if (s.state === "active") return 2;
  return 3;
}

function SessionRow({
  session,
  support,
  busy,
  onKill,
  onOpenSql,
}: {
  session: Session;
  support: ReturnType<typeof killSupport>;
  busy: boolean;
  onKill(session: Session, terminate: boolean): void;
  onOpenSql?(sql: string): void;
}): JSX.Element {
  const blocked = session.blockedBy.length > 0;
  const idleInTxn = (session.state ?? "").startsWith("idle in transaction");
  return (
    <tr
      className={`align-top hover:bg-card ${
        blocked
          ? "bg-bad/5 shadow-[inset_2px_0_0_rgb(var(--c-bad))]"
          : idleInTxn
            ? "bg-warn/5 shadow-[inset_2px_0_0_rgb(var(--c-warn))]"
            : ""
      }`}
    >
      <td className="px-3 py-1 font-mono text-ink-faint tabular-nums truncate">
        {session.id}
        {session.isSelf && <span className="ml-1 text-accent">· you</span>}
      </td>
      <td className="px-2 py-1 text-ink-muted truncate">
        {session.user ?? "—"}
        {session.application && (
          <span className="text-ink-faint"> / {session.application}</span>
        )}
        {session.clientAddress && (
          <span className="text-ink-faint block text-[10px] truncate">
            {session.clientAddress}
          </span>
        )}
      </td>
      <td className="px-2 py-1">
        <span
          className={
            blocked
              ? "text-bad/90"
              : idleInTxn
                ? "text-warn/90"
                : session.state === "active"
                  ? "text-good/90"
                  : "text-ink-faint"
          }
        >
          {session.state ?? "—"}
        </span>
        {session.waitEvent && (
          <span
            className="block text-[10px] text-ink-faint truncate"
            title={session.waitEvent}
          >
            waiting: {session.waitEvent}
          </span>
        )}
        {blocked && (
          <span className="block text-[10px] text-bad/90 truncate">
            blocked by {session.blockedBy.join(", ")}
          </span>
        )}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-ink-muted">
        {session.seconds === null ? "—" : formatDuration(session.seconds)}
      </td>
      <td className="px-2 py-1 text-ink-muted font-mono min-w-0">
        <span className="block truncate" title={session.query ?? undefined}>
          {session.query ?? "—"}
        </span>
        {session.query && onOpenSql && (
          <button
            onClick={() => onOpenSql(session.query ?? "")}
            className="text-[10px] text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
          >
            open in editor
          </button>
        )}
      </td>
      <td className="px-2 py-1 whitespace-nowrap text-right">
        {/* Never offered against our own connection: killing the session
            you are reading the list through is a trap, not a feature. */}
        {!session.isSelf && support.cancel && session.state === "active" && (
          <button
            disabled={busy}
            onClick={() => onKill(session, false)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
        )}
        {!session.isSelf && support.terminate && (
          <button
            disabled={busy}
            onClick={() => onKill(session, true)}
            className="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-faint hover:text-bad/90 disabled:opacity-40"
          >
            Close
          </button>
        )}
      </td>
    </tr>
  );
}

/// `PostgreSQL 17.2 (Debian …) on x86_64…` is a paragraph. The header wants
/// the first few words of it.
function shortVersion(version: string): string {
  const match = /^(\w+)\s+([\d.]+)/.exec(version);
  return match ? `${match[1]} ${match[2]}` : version.slice(0, 40);
}
