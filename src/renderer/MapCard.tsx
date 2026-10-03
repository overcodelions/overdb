import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useStore } from './store';

// The database map, from the window's side: whether there is one, how far
// behind it is, and building or refreshing it. A build runs in main and
// outlives any sheet, so its progress lives here, keyed by the connection
// it was started from. See src/shared/dbMap.ts.

type Status = Extract<Awaited<ReturnType<typeof statusOf>>, { ok: true }>['status'];

function statusOf(connectionId: string) {
  return window.overdb.invoke('map:status', connectionId);
}

interface Job {
  jobId: string;
  refresh: boolean;
  startedAt: number;
  /// The last few steps per repo.
  steps: Array<{ repo: string | null; text: string }>;
}

interface MapState {
  status: Record<string, Status | undefined>;
  loading: Record<string, boolean>;
  jobs: Record<string, Job | undefined>;
  error: Record<string, string | null>;
  done: Record<string, string | null>;
  load(connectionId: string): Promise<Status | null>;
  build(connectionId: string, refresh: boolean): Promise<void>;
  stop(connectionId: string): void;
}

let listening = false;

export const useMaps = create<MapState>((set, get) => {
  const listen = () => {
    if (listening) return;
    listening = true;
    window.overdb.onMainEvent((e) => {
      if (e.kind !== 'map:progress') return;
      const entry = Object.entries(get().jobs).find(([, j]) => j?.jobId === e.jobId);
      if (!entry) return;
      const [cid, job] = entry;
      const text = `${e.step.kind === 'note' ? '' : `${e.step.kind} `}${e.step.text}`;
      set({ jobs: { ...get().jobs, [cid]: { ...job!, steps: [...job!.steps, { repo: e.repo, text }].slice(-60) } } });
    });
  };

  return {
    status: {},
    loading: {},
    jobs: {},
    error: {},
    done: {},

    async load(connectionId) {
      set({ loading: { ...get().loading, [connectionId]: true } });
      const res = await statusOf(connectionId).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
      set({
        loading: { ...get().loading, [connectionId]: false },
        ...(res.ok ? { status: { ...get().status, [connectionId]: res.status } } : { error: { ...get().error, [connectionId]: res.error } }),
      });
      return res.ok ? res.status : null;
    },

    async build(connectionId, refresh) {
      listen();
      const jobId = crypto.randomUUID();
      set({
        jobs: { ...get().jobs, [connectionId]: { jobId, refresh, startedAt: Date.now(), steps: [] } },
        error: { ...get().error, [connectionId]: null },
        done: { ...get().done, [connectionId]: null },
      });
      const res = await window.overdb.invoke('map:build', { jobId, connectionId, refresh });
      set({ jobs: { ...get().jobs, [connectionId]: undefined } });
      if (res.ok) {
        const extra = res.failures.length ? ` ${res.failures.length} repo${res.failures.length === 1 ? '' : 's'} did not finish: ${res.failures.join('; ')}` : '';
        set({ done: { ...get().done, [connectionId]: `Mapped ${res.tables} tables and ${res.links} links.${res.dropped ? ` Left out ${res.dropped} names that aren’t in the database.` : ''}${extra}` } });
      } else {
        set({ error: { ...get().error, [connectionId]: res.error } });
      }
      await get().load(connectionId);
    },

    stop(connectionId) {
      const job = get().jobs[connectionId];
      if (job) void window.overdb.invoke('map:cancel', job.jobId);
    },
  };
});

function since(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function Elapsed({ from }: { from: number }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.round((Date.now() - from) / 1000);
  return <>{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</>;
}

/// What the map says, and the buttons to make or refresh it.
export function MapCard({ connectionId, onChange }: { connectionId: string; onChange?(): void }): JSX.Element | null {
  const m = useMaps();
  const status = m.status[connectionId];
  const job = m.jobs[connectionId];
  const error = m.error[connectionId];
  const done = m.done[connectionId];
  const mapLocation = useStore((s) => s.settings.mapLocation);

  useEffect(() => {
    void m.load(connectionId);
  }, [connectionId, mapLocation]);

  useEffect(() => {
    if (!job && done) onChange?.();
    // A finished build changes what a seed plans from.
  }, [job, done]);

  if (status === undefined && m.loading[connectionId]) {
    return <p className="text-[11px] text-ink-muted">Looking for a map…</p>;
  }
  if (!status) return null;

  const fresh = status.freshness;
  const behind = fresh?.repos.filter((r) => !r.mapped || r.behind !== 0) ?? [];

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {job ? (
        <>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" aria-hidden="true" />
            <span className="flex-1">
              {job.refresh ? 'Refreshing the map' : 'Mapping'} · <Elapsed from={job.startedAt} />
            </span>
            <button className="text-[11px] text-ink-muted hover:text-ink" onClick={() => m.stop(connectionId)}>Stop</button>
          </div>
          <ul className="flex flex-col gap-0.5 font-mono text-[10.5px] text-ink-muted max-h-[140px] overflow-hidden">
            {job.steps.slice(-7).map((st, i) => (
              <li key={i} className="truncate">
                {st.repo ? <span className="text-ink-faint">{baseName(st.repo)} </span> : null}
                {st.text}
              </li>
            ))}
            {job.steps.length === 0 && <li>Starting claude in each linked repo</li>}
          </ul>
          <p className="text-[10.5px] text-ink-faint leading-snug">
            Read, Grep and Glob only, one pass per repo. It keeps going if you close this; what each repo maps is saved as it finishes.
          </p>
        </>
      ) : status.map ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold">{status.map.tables} tables mapped</span>
            <span className="text-ink-muted">
              · {status.map.links} links{status.map.learned ? ` · ${status.map.learned} learned from seeds` : ''} · {since(status.map.updatedAt)}
            </span>
          </div>
          {fresh?.fresh ? (
            <p className="text-[11px] text-good">Up to date with the code and the schemas.</p>
          ) : (
            <p className="text-[11px] text-warn-strong leading-snug">
              {[
                ...behind.map((r) => (!r.mapped ? `${baseName(r.path)} not mapped yet` : r.behind ? `${baseName(r.path)} is ${r.behind} commit${r.behind === 1 ? '' : 's'} ahead` : `${baseName(r.path)} has moved`)),
                ...(fresh?.schemas.length ? [`${fresh.schemas.join(', ')} changed`] : []),
              ].join(' · ') || 'Behind'}
            </p>
          )}
          <div className="flex gap-2">
            {!fresh?.fresh && (
              <button className="h-[26px] px-2.5 rounded-md bg-accent/15 hover:bg-accent/25 text-[11px]" onClick={() => void m.build(connectionId, true)}>
                Refresh
              </button>
            )}
            <button className="h-[26px] px-2.5 rounded-md border border-card hover:bg-wash-strong text-[11px]" onClick={() => void m.build(connectionId, false)}>
              Map again from scratch
            </button>
          </div>
        </>
      ) : status.repos === 0 ? (
        <p className="text-[11px] text-ink-muted leading-snug">Link the repos whose code uses this database, then map it once so seeds plan in seconds.</p>
      ) : (
        <>
          <p className="text-[11px] leading-snug">
            No map yet. Mapping reads each linked repo once — a few minutes per repo — and writes down what the code knows about
            every table, so a seed plans from it in seconds instead of reading the code each time.
          </p>
          <button className="self-start h-[26px] px-2.5 rounded-md bg-accent text-white text-[11px] font-semibold hover:bg-accent-strong" onClick={() => void m.build(connectionId, false)}>
            Map this database
          </button>
        </>
      )}
      {error && <p role="alert" className="text-[11px] text-bad-strong">{error}</p>}
      {done && !job && <p className="text-[11px] text-ink-muted">{done}</p>}
      <p className="text-[10px] text-ink-faint font-mono truncate" title={status.file}>
        {status.file.replace(/^\/Users\/[^/]+/, '~')}
      </p>
    </div>
  );
}
