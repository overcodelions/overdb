import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { MapFreshness } from '@shared/dbMap';
import { useStore } from './store';
import { MAP_TAB, openPane } from './queryStore';

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
  /// Main's word that the connection's own schema is mapped, kept apart
  /// from the steps so it does not scroll away.
  ready?: string;
  /// Passes finished and planned, once main has planned them.
  parts?: { done: number; total: number };
}

interface MapState {
  status: Record<string, Status | undefined>;
  loading: Record<string, boolean>;
  jobs: Record<string, Job | undefined>;
  error: Record<string, string | null>;
  done: Record<string, string | null>;
  load(connectionId: string): Promise<Status | null>;
  build(connectionId: string, refresh: boolean, rest?: boolean): Promise<void>;
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
      if (e.step.kind === 'parts') {
        const [done, total] = e.step.text.split('/').map(Number);
        set({ jobs: { ...get().jobs, [cid]: { ...job!, parts: { done, total } } } });
        return;
      }
      const text = `${e.step.kind === 'note' ? '' : `${e.step.kind} `}${e.step.text}`;
      const ready = e.step.text.startsWith('Ready to seed') ? e.step.text : job!.ready;
      set({ jobs: { ...get().jobs, [cid]: { ...job!, ready, steps: [...job!.steps, { repo: e.repo, text }].slice(-400) } } });
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

    async build(connectionId, refresh, rest = false) {
      listen();
      const jobId = crypto.randomUUID();
      set({
        jobs: { ...get().jobs, [connectionId]: { jobId, refresh, startedAt: Date.now(), steps: [] } },
        error: { ...get().error, [connectionId]: null },
        done: { ...get().done, [connectionId]: null },
      });
      const res = await window.overdb.invoke('map:build', { jobId, connectionId, refresh, rest });
      set({ jobs: { ...get().jobs, [connectionId]: undefined } });
      if (res.ok) {
        const extra = res.failures.length ? ` ${res.failures.length} repo${res.failures.length === 1 ? '' : 's'} did not finish: ${res.failures.join('; ')}` : '';
        set({ done: { ...get().done, [connectionId]: `Mapped ${res.tables} tables and ${res.links} links.${res.dropped ? ` Left out ${res.dropped} names that aren’t in the database.` : ''}${res.leftOut ? ` ${res.leftOut} tables no code names were left out.` : ''}${extra}` } });
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

/// Why a map is behind, in a few words however many repos it reads: a
/// dozen services each "not mapped yet" is a wall, not a reason.
export function behindText(fresh: MapFreshness | null | undefined): string {
  if (!fresh) return '';
  const unmapped = fresh.repos.filter((r) => !r.mapped);
  const moved = fresh.repos.filter((r) => r.mapped && r.behind !== 0);
  const name = (rs: typeof unmapped) => (rs.length === 1 ? baseName(rs[0].path) : `${rs.length} repos`);
  return [
    unmapped.length && `${name(unmapped)} not mapped yet`,
    moved.length && (moved.length === 1 && moved[0].behind ? `${baseName(moved[0].path)} is ${moved[0].behind} commit${moved[0].behind === 1 ? '' : 's'} ahead` : `${name(moved)} moved on since`),
    fresh.schemas.length && `${fresh.schemas.join(', ')} changed`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function since(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function Elapsed({ from }: { from: number }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.round((Date.now() - from) / 1000);
  return <>{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</>;
}

/// What the map says, and the buttons to make or refresh it. `compact` is
/// the one line a sheet shows — Seed, a base, a set — with the way to the
/// Map pane, where the map and its repos are managed.
export function MapCard({ connectionId, onChange, compact = false }: { connectionId: string; onChange?(): void; compact?: boolean }): JSX.Element | null {
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

  if (compact) {
    const open = (
      <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => openPane(connectionId, MAP_TAB)}>
        Open map
      </button>
    );
    return (
      <div className="flex flex-col gap-1 text-[12px]">
        <div className="flex items-center gap-2 min-w-0">
          {job && <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" aria-hidden="true" />}
          <span className="flex-1 min-w-0 truncate">
            {job ? (
              <>
                {job.refresh ? 'Refreshing the map' : 'Mapping'} · <Elapsed from={job.startedAt} />
              </>
            ) : status.map ? (
              <>
                <span className="font-semibold">{status.map.tables} tables mapped</span>
                <span className={fresh?.fresh ? 'text-good' : 'text-warn-strong'}> · {fresh?.fresh ? 'up to date' : 'behind the code'}</span>
              </>
            ) : status.repos === 0 ? (
              <span className="text-ink-muted">No repos linked yet</span>
            ) : (
              <span className="text-ink-muted">Not mapped yet · a first map takes a few minutes to about 20</span>
            )}
          </span>
          {open}
        </div>
        {job?.ready && <p className="text-[11px] text-good leading-snug">{job.ready}.</p>}
        {error && <p role="alert" className="text-[11px] text-bad-strong">{error}</p>}
      </div>
    );
  }

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
            {job.steps.length === 0 && <li>Finding which files name each table</li>}
          </ul>
          {job.ready && <p className="text-[11px] text-good leading-snug">{job.ready}. Seeds can use what is mapped now.</p>}
          <p className="text-[10.5px] text-ink-faint leading-snug">
            A quick scan finds the files that name each table; claude reads those, with Read, Grep and Glob only. It keeps going if
            you close this, and each part is saved as it finishes.
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
          {status.map.unmapped > 0 && (
            <p className="text-[11px] text-ink-muted leading-snug">
              {status.map.unmapped} table{status.map.unmapped === 1 ? '' : 's'} not mapped, mostly ones no code names.{' '}
              <button className="text-accent hover:underline" onClick={() => void m.build(connectionId, false, true)}>
                Map them too
              </button>
            </p>
          )}
          {fresh?.fresh ? (
            <p className="text-[11px] text-good">Up to date with the code and the schemas.</p>
          ) : (
            <p className="text-[11px] text-warn-strong leading-snug">
              {behindText(fresh) || 'Behind'}
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
            No map yet. Mapping reads each linked repo once and writes down what the code knows about every table it names, so a
            seed plans from it in seconds instead of reading the code each time. The schema this connection uses is mapped first.
            It takes from a few minutes to about 20 for a large database read from many repos.
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
