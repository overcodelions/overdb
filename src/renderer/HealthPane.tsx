import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '@shared/types';
import {
  formatBytes,
  formatDuration,
  killSupport,
  readings,
  seqScanOffenders,
  unusedIndexSummary,
  type HealthSnapshot,
  type ReadingTone,
  type Session,
} from '@shared/health';
import { useStore } from './store';

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

const TONE: Record<ReadingTone, string> = {
  good: 'text-good/90',
  watch: 'text-warn/90',
  bad: 'text-bad/90',
  unknown: 'text-ink-faint',
};

const REFRESH_OPTIONS = [0, 5, 15, 60] as const;

export function HealthPane({
  connection,
  onOpenSql,
}: {
  connection: Connection;
  /// Put a statement in the editor — reading a session's query and then
  /// having to retype it is the gap this closes.
  onOpenSql?(sql: string): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const askConfirm = useStore((s) => s.askConfirm);

  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [everyN, setEveryN] = useState<number>(15);
  const [showIdle, setShowIdle] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await window.overdb.invoke('perf:health', connection.id);
      if (!live.current) return;
      setHealth(snapshot);
      setError(null);
    } catch (err) {
      if (!live.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [connection.id]);

  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  // Polling is opt-in and visible. A dashboard that quietly re-queries a
  // production server every second is a dashboard that shows up in someone
  // else's slow-query list.
  useEffect(() => {
    if (everyN === 0) return;
    const timer = setInterval(() => void refresh(), everyN * 1000);
    return () => clearInterval(timer);
  }, [everyN, refresh]);

  const support = killSupport(connection.engine);

  const sessions = useMemo(() => {
    const all = health?.sessions ?? [];
    return showIdle ? all : all.filter((s) => s.state !== 'idle' || s.blockedBy.length > 0);
  }, [health, showIdle]);

  const kill = (session: Session, terminate: boolean) => {
    const verb = terminate ? 'Close this connection' : 'Cancel this statement';
    askConfirm({
      title: `${verb}?`,
      body: terminate
        ? `Session ${session.id}${session.user ? ` (${session.user})` : ''} will be disconnected and whatever it was doing rolled back.\n\n${session.query ?? ''}`
        : `The statement session ${session.id} is running will stop. The connection stays open and its client gets an error.\n\n${session.query ?? ''}`,
      confirmLabel: terminate ? 'Close it' : 'Cancel it',
      destructive: terminate,
      async onConfirm() {
        setBusySession(session.id);
        try {
          const res = await window.overdb.invoke('perf:killSession', {
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
            toast(terminate ? `Session ${session.id} closed.` : `Asked session ${session.id} to stop.`);
            await refresh();
          } else {
            toast(res.error ?? 'The server declined.', 'error');
          }
        } finally {
          setBusySession(null);
        }
      },
    });
  };

  const rows = health ? readings(health) : [];
  const unused = health ? unusedIndexSummary(health) : null;
  const scans = health ? seqScanOffenders(health) : [];

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b border-card px-3.5 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-ink-muted">
          {connection.name}
          {health?.serverVersion && (
            <span className="text-ink-faint"> · {shortVersion(health.serverVersion)}</span>
          )}
          {health?.uptimeSeconds !== null && health?.uptimeSeconds !== undefined && (
            <span className="text-ink-faint"> · up {formatDuration(health.uptimeSeconds)}</span>
          )}
        </span>

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          refresh
          <select
            value={everyN}
            onChange={(e) => setEveryN(Number(e.target.value))}
            className="bg-surface-muted border border-card rounded px-1 py-0.5 text-ink"
          >
            {REFRESH_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'manual' : `${n}s`}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card disabled:opacity-40"
        >
          {loading ? 'Reading…' : 'Read now'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error !== null ? (
          <p className="px-3.5 py-3 text-[11px] text-bad/90">{error}</p>
        ) : health === null ? (
          <p className="px-3.5 py-3 text-[11px] text-ink-faint">Reading the server's statistics…</p>
        ) : (
          <>
            {rows.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-px bg-card border-b border-card">
                {rows.map((r) => (
                  <div key={r.key} className="bg-surface px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{r.label}</p>
                    <p className={`text-base tabular-nums ${TONE[r.tone]}`}>{r.value}</p>
                    {/* The sentence is not optional garnish: a number with
                        nothing next to it is a number nobody acts on. */}
                    <p className="text-[10px] text-ink-faint leading-snug mt-0.5">{r.note}</p>
                  </div>
                ))}
              </div>
            )}

            <Section
              title={`Sessions (${sessions.length}${health.sessions.length !== sessions.length ? ` of ${health.sessions.length}` : ''})`}
              right={
                health.sessions.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[10px] text-ink-faint">
                    <input
                      type="checkbox"
                      checked={showIdle}
                      onChange={(e) => setShowIdle(e.target.checked)}
                    />
                    include idle
                  </label>
                )
              }
            >
              {health.sessions.length === 0 ? (
                <Empty>
                  {support.note ?? 'No client sessions, or this server did not let us read them.'}
                </Empty>
              ) : (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-ink-faint text-left">
                      <th className="px-3.5 py-1 font-normal">id</th>
                      <th className="px-2 py-1 font-normal">who</th>
                      <th className="px-2 py-1 font-normal">state</th>
                      <th className="px-2 py-1 font-normal text-right">for</th>
                      <th className="px-2 py-1 font-normal">statement</th>
                      <th className="px-2 py-1 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        support={support}
                        busy={busySession === s.id}
                        onKill={kill}
                        onOpenSql={onOpenSql}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {health.tables.length > 0 && (
              <Section title="Biggest tables">
                <table className="w-full text-[11px]">
                  <tbody>
                    {health.tables.slice(0, 15).map((t) => (
                      <tr key={`${t.schema}.${t.table}`} className="hover:bg-card">
                        <td className="px-3.5 py-0.5 font-mono text-ink-muted">
                          {t.schema}.{t.table}
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink">
                          {formatBytes(t.bytes)}
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink-faint">
                          {t.indexBytes === null ? '' : `+${formatBytes(t.indexBytes)} indexes`}
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink-faint">
                          {t.estimatedRows === null ? '' : `~${t.estimatedRows.toLocaleString()} rows`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}

            {unused !== null && (
              <Section title="Indexes the planner has not used">
                <p className="px-3.5 pb-1 text-[11px] text-ink-muted leading-relaxed max-w-[80ch]">
                  {unused}
                </p>
                <table className="w-full text-[11px]">
                  <tbody>
                    {health.unusedIndexes
                      .filter((ix) => !ix.unique)
                      .slice(0, 15)
                      .map((ix) => (
                        <tr key={`${ix.schema}.${ix.index}`} className="hover:bg-card">
                          <td className="px-3.5 py-0.5 font-mono text-ink-muted">{ix.index}</td>
                          <td className="px-2 py-0.5 font-mono text-ink-faint">
                            on {ix.schema}.{ix.table}
                          </td>
                          <td className="px-2 py-0.5 text-right tabular-nums text-ink-faint">
                            {ix.bytes === null ? '' : formatBytes(ix.bytes)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Section>
            )}

            {scans.length > 0 && (
              <Section title="Read hardest">
                <table className="w-full text-[11px]">
                  <tbody>
                    {scans.slice(0, 15).map((s) => (
                      <tr key={`${s.schema}.${s.table}`} className="hover:bg-card">
                        <td className="px-3.5 py-0.5 font-mono text-ink-muted">
                          {s.schema}.{s.table}
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink">
                          {s.sequentialRowsRead.toLocaleString()} rows
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink-faint">
                          over {s.sequentialScans.toLocaleString()} scans
                        </td>
                        <td className="px-2 py-0.5 text-right tabular-nums text-ink-faint">
                          {s.indexScans > 0 ? `${s.indexScans.toLocaleString()} index scans` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}

            {health.notes.length > 0 && (
              <Section title="What this server would not say">
                {/* Kept rather than swallowed: "you need pg_stat_statements"
                    is a more useful answer than an empty panel, and a
                    permission error looks exactly like a bug otherwise. */}
                {health.notes.map((note, i) => (
                  <p key={i} className="px-3.5 py-0.5 text-[10px] text-ink-faint leading-relaxed">
                    · {note}
                  </p>
                ))}
              </Section>
            )}

            <p className="px-3.5 py-2 text-[10px] text-ink-faint">
              Read from this server's own statistics views. No table data was queried, and none of
              it depends on whether writes are armed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="border-b border-card py-1.5">
      <div className="px-3.5 py-1 flex items-center gap-2">
        <p className="text-[10px] uppercase tracking-wide text-ink-faint">{title}</p>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="px-3.5 py-1 text-[11px] text-ink-faint">{children}</p>;
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
  return (
    <tr className={`align-top hover:bg-card ${blocked ? 'bg-bad/5' : ''}`}>
      <td className="px-3.5 py-1 font-mono text-ink-faint tabular-nums">
        {session.id}
        {session.isSelf && <span className="ml-1 text-accent">·you</span>}
      </td>
      <td className="px-2 py-1 text-ink-muted">
        {session.user ?? '—'}
        {session.application && <span className="text-ink-faint"> / {session.application}</span>}
        {session.clientAddress && (
          <span className="text-ink-faint block text-[10px]">{session.clientAddress}</span>
        )}
      </td>
      <td className="px-2 py-1">
        <span
          className={
            session.state === 'active'
              ? 'text-good/90'
              : (session.state ?? '').startsWith('idle in transaction')
                ? 'text-warn/90'
                : 'text-ink-faint'
          }
        >
          {session.state ?? '—'}
        </span>
        {session.waitEvent && (
          <span className="block text-[10px] text-ink-faint">waiting: {session.waitEvent}</span>
        )}
        {blocked && (
          <span className="block text-[10px] text-bad/90">
            blocked by {session.blockedBy.join(', ')}
          </span>
        )}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-ink-muted">
        {session.seconds === null ? '—' : formatDuration(session.seconds)}
      </td>
      <td className="px-2 py-1 text-ink-muted font-mono max-w-[42ch]">
        <span className="line-clamp-2">{session.query ?? '—'}</span>
        {session.query && onOpenSql && (
          <button
            onClick={() => onOpenSql(session.query ?? '')}
            className="text-[10px] text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
          >
            open in editor
          </button>
        )}
      </td>
      <td className="px-2 py-1 whitespace-nowrap text-right">
        {/* Never offered against our own connection: killing the session
            you are reading the list through is a trap, not a feature. */}
        {!session.isSelf && support.cancel && session.state === 'active' && (
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
