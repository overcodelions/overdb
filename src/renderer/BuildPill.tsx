import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useBuilds, type BackgroundBuild } from './buildsStore';

/// The builds sent to the background, at the bottom of the window: what
/// each is doing and for how long, Stop, and what to do once it lands.
export function BuildPill(): JSX.Element | null {
  const jobs = useBuilds((s) => s.jobs);
  if (jobs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 w-[340px]" aria-live="polite">
      {jobs.map((j) => <One key={j.jobId} job={j} />)}
    </div>
  );
}

function Elapsed({ from }: { from: number }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.round((Date.now() - from) / 1000);
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)} min ${s % 60}s`}</>;
}

function One({ job }: { job: BackgroundBuild }): JSX.Element {
  const dismiss = useBuilds((s) => s.dismiss);
  const setSheet = useStore((s) => s.setSheet);
  const what = job.remote ? `Copying ${job.name} to this machine` : `Building a base of ${job.name}`;
  const close = (
    <button aria-label="Dismiss" onClick={() => dismiss(job.jobId)} className="shrink-0 w-5 h-5 rounded text-ink-faint hover:text-ink hover:bg-wash-strong">
      ×
    </button>
  );

  if (job.done) {
    return (
      <div className="rounded-lg border border-good/40 bg-surface-elevated shadow-xl shadow-black/30 px-3 py-2.5 flex flex-col gap-1.5 text-[12px]">
        <div className="flex items-start gap-2">
          <span className="mt-1 w-2 h-2 rounded-full bg-good shrink-0" />
          <span className="flex-1 min-w-0 font-semibold">{job.remote ? `Copied ${job.name} to this machine` : `Base of ${job.name} built`}</span>
          {close}
        </div>
        <div className="pl-4 text-[11px] text-ink-muted">
          {job.done.report.tables} tables · {job.done.report.rows.toLocaleString()} rows — a base for {job.done.label}
        </div>
        <button
          className="ml-4 self-start h-6 px-2.5 rounded-[5px] bg-accent text-white text-[11px] font-semibold hover:bg-accent-strong"
          onClick={() => {
            dismiss(job.jobId);
            setSheet({ kind: 'tickets' });
          }}
        >
          Make a branch…
        </button>
      </div>
    );
  }

  if (job.error) {
    const log = job.log;
    return (
      <div className="rounded-lg border border-bad/40 bg-surface-elevated shadow-xl shadow-black/30 px-3 py-2.5 flex flex-col gap-1.5 text-[12px]">
        <div className="flex items-start gap-2">
          <span className="mt-1 w-2 h-2 rounded-full bg-bad shrink-0" />
          <span className="flex-1 min-w-0 font-semibold">{job.remote ? `The copy of ${job.name} stopped` : `The base of ${job.name} stopped`}</span>
          {close}
        </div>
        <p className="pl-4 text-[11px] text-bad-strong break-words line-clamp-3">{job.error}</p>
        <div className="pl-4 flex gap-3 text-[11px]">
          {log && (
            <button className="text-ink-muted hover:text-ink underline decoration-dotted underline-offset-2" onClick={() => void window.overdb.invoke('app:showLog', log)}>
              Show the log
            </button>
          )}
          <button className="text-accent hover:underline" onClick={() => { dismiss(job.jobId); setSheet({ kind: 'baseline', connectionId: job.connectionId }); }}>
            Open it again
          </button>
        </div>
      </div>
    );
  }

  const p = job.last;
  return (
    <div className="rounded-lg border border-card bg-surface-elevated shadow-xl shadow-black/30 px-3 py-2.5 flex flex-col gap-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0 font-semibold truncate">{what}</span>
        <span className="text-[11px] text-ink-muted tabular-nums shrink-0"><Elapsed from={job.startedAt} /></span>
      </div>
      <div className="pl-5 text-[11px] text-ink-muted truncate" title={p?.text}>{p?.text ?? 'Starting'}</div>
      {p?.total ? (
        <div className="ml-5 h-[3px] rounded bg-card overflow-hidden" aria-hidden="true">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${(100 * (p.done ?? 0)) / p.total}%` }} />
        </div>
      ) : null}
      <button
        className="ml-5 self-start text-[11px] text-ink-muted hover:text-bad underline decoration-dotted underline-offset-2"
        onClick={() => void window.overdb.invoke('baseline:cancelBuild', job.jobId)}
      >
        Stop
      </button>
    </div>
  );
}
