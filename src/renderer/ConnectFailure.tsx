import type { Connection } from '@shared/types';
import { diagnose } from '@shared/connectDiagnosis';
import { useStore } from './store';

/// Why this connection would not open, where you are looking when it
/// happens: above the editor you were about to type into.
///
/// It used to be a toast carrying the driver's sentence verbatim for four
/// seconds — "Access denied for user 'root'@'localhost' (using password:
/// NO)" — which is accurate and names neither the setting at fault nor the
/// place to change it. The form already knows how to say both (see
/// connectDiagnosis.ts); this says it here too, and hands the fix to the
/// form, which opens with the same failure already explained.
export function ConnectFailure({
  conn,
  error,
  retrying,
  onRetry,
}: {
  conn: Connection;
  error: string;
  retrying: boolean;
  onRetry(): void;
}): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const setConnectError = useStore((s) => s.setConnectError);

  const d = diagnose({
    engine: conn.engine,
    error,
    ssl: conn.ssl,
    secretSource: conn.secretSource,
    host: conn.tunnel?.remoteHost ?? conn.host,
    port: conn.port,
    user: conn.user,
    database: conn.database,
  });
  // Fixes the form can apply are behind its button; this only names them.
  const fixable = d.fixes.filter((f) => f.set);
  const tried = d.fixes.slice(0, 4).map((f) => f.label);

  return (
    <div role="alert" className="shrink-0 border-b border-bad/25 bg-bad/[0.06] px-4 py-3 flex gap-3">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth="1.6" strokeLinecap="round" aria-hidden className="shrink-0 mt-px text-bad">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.8v3.8M8 11.2v.01" />
      </svg>

      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div>
          <p className="text-[12.5px] font-semibold text-bad-strong leading-snug">
            Couldn’t connect to {conn.name}
          </p>
          <p className="mt-0.5 text-xs text-ink leading-snug">{d.cause}</p>
        </div>

        {/* Names only: the details are a paragraph each, and they are one
            click away in the form, next to the buttons that apply them. */}
        {tried.length > 0 && (
          <p className="text-[11.5px] text-ink-muted leading-snug">
            <span className="text-ink-faint">Try: </span>
            {tried.join(' · ')}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setSheet({ kind: 'editConnection', id: conn.id, failure: error })}
            className="h-7 px-3 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-xs font-medium"
          >
            {fixable.length > 0 ? 'Fix connection…' : 'Edit connection…'}
          </button>
          <button
            onClick={onRetry}
            disabled={retrying}
            className="h-7 px-3 rounded-[5px] border border-card bg-card hover:bg-wash-strong text-xs text-ink disabled:opacity-40"
          >
            {retrying ? 'Connecting…' : 'Try again'}
          </button>
          <details className="min-w-0">
            <summary className="text-[11px] text-ink-muted cursor-pointer select-none px-1">
              Driver message
            </summary>
            <p className="mt-1 font-mono text-[10.5px] text-ink-muted leading-snug break-words select-text">
              {error}
            </p>
          </details>
        </div>
      </div>

      <button
        onClick={() => setConnectError(conn.id, undefined)}
        aria-label="Dismiss"
        className="shrink-0 self-start w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-card"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
