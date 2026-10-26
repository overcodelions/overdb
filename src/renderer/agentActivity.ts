import { useEffect } from 'react';
import { create } from 'zustand';
import type { AgentActivity, AgentClient } from '@shared/types';

/// What agents are doing, as `overdb serve --mcp` leaves it on disk
/// (src/main/agentActivity.ts). The chip, the rail and the Agents sheet all
/// want it, so one poll serves them: it runs while anything is watching,
/// and faster while something is open that shows the log itself.

const LIMIT = 300;

interface AgentActivityState {
  clients: AgentClient[];
  activity: AgentActivity[];
  command: string[];
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  clients: [],
  activity: [],
  command: [],
  loaded: false,
  async refresh() {
    const r = await window.overdb.invoke('agents:activity', { limit: LIMIT });
    set({ ...r, loaded: true });
  },
}));

const watchers = new Map<symbol, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let every = 0;

function schedule(): void {
  const want = watchers.size ? Math.min(...watchers.values()) : 0;
  if (want === every) return;
  if (timer) clearInterval(timer);
  timer = null;
  every = want;
  if (!want) return;
  const refresh = useAgentActivityStore.getState().refresh;
  void refresh();
  timer = setInterval(() => void refresh(), want);
}

/// Subscribe, polling at least every `ms` while mounted.
export function useAgentActivity(ms = 10_000): AgentActivityState {
  useEffect(() => {
    const id = Symbol('agents');
    watchers.set(id, ms);
    schedule();
    return () => {
      watchers.delete(id);
      schedule();
    };
  }, [ms]);
  return useAgentActivityStore();
}

export function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/// The client's name as people say it.
export function clientLabel(c: { client?: string }): string {
  const n = c.client;
  if (!n) return 'An MCP client';
  if (/claude[-_ ]?code/i.test(n)) return 'Claude Code';
  if (/cursor/i.test(n)) return 'Cursor';
  if (/overcli/i.test(n)) return 'overcli';
  return n;
}

/// `~` for the home folder: where the agent works, said briefly.
export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/// One line on what a call was: the statement, the question, or the tool.
export function activityText(a: AgentActivity): string {
  if (a.sql) return a.sql.replace(/\s+/g, ' ').trim();
  if (a.question) return `“${a.question}”`;
  return a.tool.replace(/_/g, ' ');
}

/// How a call went, briefly: rows and time, or why it failed.
export function activityOutcome(a: AgentActivity): string {
  if (!a.ok) return a.error?.startsWith('overdb only runs reads') ? 'Refused · write' : 'Failed';
  if (a.truncated) return `Capped at ${a.rowCount ?? '?'} rows · ${a.ms} ms`;
  if (typeof a.rowCount === 'number') return `${a.rowCount} row${a.rowCount === 1 ? '' : 's'} · ${a.ms} ms`;
  return `${a.ms} ms`;
}
