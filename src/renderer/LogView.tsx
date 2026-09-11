import { useEffect, useRef } from 'react';
import { severity } from '@shared/sqlGuard';
import { useQuery, type LogEntry } from './queryStore';
import { useStore } from './store';

/// What actually ran, in order, with what came back.
///
/// The result grid answers "what did the last statement return". This
/// answers "did it run at all, against what, and how long did it take" —
/// which is the question you have when the grid says nothing to show, or
/// when a statement has been going for thirty seconds and you cannot tell
/// whether it is working or wedged.
export function LogView({
  connectionId,
  onOpen,
  onReplay,
  onPlan,
}: {
  /// The connection the pane is pointed at. A log line from any other one
  /// is history you can read, not something to re-run.
  connectionId: string | null;
  /// Put the statement back in the editor, unrun.
  onOpen(sql: string): void;
  /// Run it again, now.
  onReplay(sql: string): void;
  /// EXPLAIN it — which is the question you actually have about the line
  /// that took eight seconds.
  onPlan(sql: string): void;
}): JSX.Element {
  const log = useQuery((s) => s.log);
  const clearLog = useQuery((s) => s.clearLog);
  const cancelLogEntry = useQuery((s) => s.cancelLogEntry);
  const connections = useStore((s) => s.connections);
  const scroller = useRef<HTMLDivElement>(null);

  // Pinned to the bottom while it is the newest line that matters — the
  // same reason a terminal scrolls.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, log[log.length - 1]?.status]);

  if (log.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint px-8 text-center">
        Statements appear here as they run, with what they returned and how long they took.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px]">
        {log.map((entry) => (
          <Line
            key={entry.id}
            entry={entry}
            connection={connections.find((c) => c.id === entry.connectionId)?.name}
            actionable={entry.connectionId === connectionId}
            // Cancelling is NOT gated on the pane's connection. Replaying a
            // statement against whichever connection happens to be selected
            // is a mistake; stopping the one that is running is never one,
            // and the running statement you most need to stop is usually on
            // the connection you have just switched away from.
            onCancel={() => void cancelLogEntry(entry.id)}
            onOpen={onOpen}
            onReplay={onReplay}
            onPlan={onPlan}
          />
        ))}
      </div>
      <div className="shrink-0 border-t border-card px-3 py-1.5 flex items-center gap-2">
        <span className="text-[10px] text-ink-faint tabular-nums">
          {log.length} statement{log.length === 1 ? '' : 's'}
        </span>
        {(() => {
          // What is running RIGHT NOW, and where. The count alone made you
          // scroll the log to find out whether anything was still going.
          const live = log.filter((l) => l.status === 'running');
          if (!live.length) return null;
          const where = [...new Set(live.map((l) => l.connectionId))]
            .map((id) => connections.find((c) => c.id === id)?.name ?? 'a connection')
            .join(', ');
          return (
            <span className="text-[10px] text-good/90 tabular-nums">
              {live.length} running on {where}
            </span>
          );
        })()}
        <div className="flex-1" />
        <button
          onClick={clearLog}
          className="text-[10px] text-ink-faint hover:text-ink"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function Line({
  entry,
  connection,
  actionable,
  onCancel,
  onOpen,
  onReplay,
  onPlan,
}: {
  entry: LogEntry;
  connection?: string;
  actionable: boolean;
  onCancel(): void;
  onOpen(sql: string): void;
  onReplay(sql: string): void;
  onPlan(sql: string): void;
}): JSX.Element {
  const time = new Date(entry.at).toLocaleTimeString(undefined, { hour12: false });
  const sev = severity(entry.sql);

  const dot =
    entry.status === 'running' ? 'bg-ink-faint animate-pulse'
    : entry.status === 'error' ? 'bg-bad'
    : entry.status === 'cancelled' ? 'bg-warn'
    : sev === 'destructive' ? 'bg-bad/70'
    : sev === 'mutating' ? 'bg-warn/70'
    : 'bg-good/70';

  const live = entry.status === 'running';

  return (
    <div
      // A running line is the only one you can still do anything about, so
      // it is the only one that is not the same grey as its neighbours.
      className={`group py-1 border-b border-rule last:border-0 ${
        live ? 'bg-good/[0.06] -mx-3 px-3 shadow-[inset_2px_0_0_rgb(52_211_153)]' : ''
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full translate-y-[-1px] ${dot}`} />
        <span className="shrink-0 text-ink-faint tabular-nums">{time}</span>
        {connection && (
          // The connection is what a running line is ABOUT: it says which
          // server is spending time on your behalf, and in a log spanning
          // five of them the faint grey made that the hardest thing to
          // read.
          <span
            className={`shrink-0 truncate max-w-[180px] ${
              live ? 'text-good-strong' : 'text-ink-faint'
            }`}
          >
            {connection}
          </span>
        )}
        {entry.schema && <span className="shrink-0 text-ink-faint truncate max-w-[140px]">{entry.schema}</span>}
        {entry.write && (
          <span className="shrink-0 text-[9px] px-1 rounded bg-warn/10 text-warn/90 border border-warn/25">
            write
          </span>
        )}
        <div className="flex-1" />
        {/* Revealed on hover rather than always drawn: three buttons on
            every one of 300 lines is a wall of chrome over the thing you
            came here to read. */}
        {live && entry.runId && (
          // Always shown, never hover-only: a cancel you have to discover
          // by hovering is one you will not find while a query is eating a
          // production server.
          <button
            onClick={onCancel}
            title={`Cancel this statement on ${connection ?? 'its connection'} — aborts on the server, not just here`}
            className="shrink-0 text-[10px] px-1.5 rounded border border-bad/40 text-bad-strong hover:bg-bad/15"
          >
            Cancel
          </button>
        )}
        {actionable && !live && (
          <span className="shrink-0 hidden group-hover:flex items-baseline gap-2">
            <Action label="Edit" title="Put it back in the editor, unrun" onClick={() => onOpen(entry.sql)} />
            <Action label="Plan" title="EXPLAIN this statement" onClick={() => onPlan(entry.sql)} />
            <Action label="Run" title="Run this statement again" onClick={() => onReplay(entry.sql)} />
          </span>
        )}
        {/* The outcome stays put while they appear beside it: it is what
            you are reading down the column, and having it jump left under
            the cursor would break the scan. */}
        <span className="shrink-0 text-ink-faint tabular-nums">{outcome(entry)}</span>
      </div>
      {/* One line of SQL, whitespace collapsed. The editor above is where
          you read a statement; this is where you recognise it. */}
      <div className="mt-0.5 pl-[14px] text-ink-muted truncate" title={entry.sql}>
        {entry.sql.replace(/\s+/g, ' ').trim()}
      </div>
      {entry.error && (
        <div className="mt-0.5 pl-[14px] text-bad-strong/90 whitespace-pre-wrap">{entry.error}</div>
      )}
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
    <button
      onClick={onClick}
      title={title}
      className="text-[10px] text-ink-faint hover:text-accent"
    >
      {label}
    </button>
  );
}

function outcome(entry: LogEntry): string {
  if (entry.status === 'running') return 'running…';
  if (entry.status === 'cancelled') {
    return entry.rowCount ? `cancelled · ${entry.rowCount.toLocaleString()} rows kept` : 'cancelled';
  }
  if (entry.status === 'error') return 'failed';
  const ms = entry.durationMs === null ? '' : ` · ${entry.durationMs} ms`;
  if (entry.rowCount === null) return `ok${ms}`;
  return `${entry.rowCount.toLocaleString()} row${entry.rowCount === 1 ? '' : 's'}${ms}`;
}
