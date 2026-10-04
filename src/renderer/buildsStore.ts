import { create } from 'zustand';
import type { BuildProgress } from '@shared/baselineBuild';
import type { BaselineRecord } from '@shared/instances';

// Base builds that keep going after their sheet is closed. A build runs in
// main, in its own process, whatever the window does; all the sheet ever
// owned was the decision to cancel it when it closed. "Keep going in the
// background" hands the build to this store instead, and a small pill
// (BuildPill.tsx) follows it to the end.

export interface BackgroundBuild {
  jobId: string;
  connectionId: string;
  name: string;
  /// A copy of a shared server, as opposed to a base of your own.
  remote: boolean;
  startedAt: number;
  last: BuildProgress | null;
  done: BaselineRecord | null;
  error: string | null;
  log: string | null;
}

interface BuildsState {
  jobs: BackgroundBuild[];
  add(job: Omit<BackgroundBuild, 'done' | 'error' | 'log'>): void;
  progress(jobId: string, p: BuildProgress): void;
  finish(jobId: string, res: { ok: true; baseline: BaselineRecord } | { ok: false; error: string; log?: string }): void;
  dismiss(jobId: string): void;
}

export const useBuilds = create<BuildsState>((set, get) => ({
  jobs: [],
  add(job) {
    set({ jobs: [...get().jobs.filter((j) => j.jobId !== job.jobId), { ...job, done: null, error: null, log: null }] });
  },
  progress(jobId, p) {
    if (!get().jobs.some((j) => j.jobId === jobId)) return;
    set({ jobs: get().jobs.map((j) => (j.jobId === jobId ? { ...j, last: p } : j)) });
  },
  finish(jobId, res) {
    if (!get().jobs.some((j) => j.jobId === jobId)) return;
    set({
      jobs: get().jobs.map((j) =>
        j.jobId !== jobId ? j : res.ok ? { ...j, done: res.baseline } : { ...j, error: res.error, log: res.log ?? null },
      ),
    });
  },
  dismiss(jobId) {
    set({ jobs: get().jobs.filter((j) => j.jobId !== jobId) });
  },
}));

/// A build for this connection still running in the background.
export function runningFor(connectionId: string | null): BackgroundBuild | undefined {
  return useBuilds.getState().jobs.find((j) => j.connectionId === connectionId && !j.done && !j.error);
}
