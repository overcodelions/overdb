import { create } from 'zustand';
import type { Cell, ColumnMeta, Engine, MainToRendererEvent } from '@shared/types';
import { classify, splitStatements } from '@shared/sqlGuard';
import { isSortable, wrapWithOrderBy, type SortDirection } from '@shared/orderBy';

export type TabStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

/// One tab per statement in the batch. A three-statement script produces
/// three tabs, which is the only honest way to show it — collapsing them
/// into "the last result" silently discards two answers.
export interface ResultTab {
  runId: string | null;
  index: number;
  sql: string;
  kind: ReturnType<typeof classify>;
  status: TabStatus;
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  error: string | null;
  durationMs: number | null;
  /// Sorting re-asks the server, so the tab remembers what it asked for.
  sort: { column: string; direction: SortDirection } | null;
}

interface QueryState {
  connectionId: string | null;
  tabs: ResultTab[];
  active: number;
  running: boolean;

  run(connectionId: string, sql: string, engine: Engine): Promise<void>;
  cancel(): Promise<void>;
  setActive(index: number): void;
  /// Cycles a column asc -> desc -> unsorted and re-runs that statement.
  sortBy(index: number, column: string, engine: Engine): Promise<void>;
  ingest(event: MainToRendererEvent): void;
  reset(): void;
}

/// Resolvers for the statement currently in flight, so the batch can run
/// strictly in order — a later statement may depend on an earlier one.
const settle = new Map<string, () => void>();
/// Set the moment a cancel is requested, so the batch loop stops before
/// starting the next statement. Without it, cancelling statement two of five
/// simply moved on to statement three.
let cancelledBatch = false;

function blankTab(index: number, sql: string): ResultTab {
  return {
    runId: null, index, sql, kind: classify(sql), status: 'pending',
    columns: [], rows: [], rowCount: 0, truncated: false, error: null, durationMs: null, sort: null,
  };
}

export const useQuery = create<QueryState>((set, get) => ({
  connectionId: null,
  tabs: [],
  active: 0,
  running: false,

  async run(connectionId, sql, engine) {
    const statements = splitStatements(sql, engine);
    if (statements.length === 0) return;

    cancelledBatch = false;
    set({
      connectionId,
      tabs: statements.map((s, i) => blankTab(i, s.sql)),
      active: 0,
      running: true,
    });

    if (!(await window.overdb.invoke('conn:isOpen', connectionId))) {
      const opened = await window.overdb.invoke('conn:open', connectionId);
      if (!opened.ok) {
        set((st) => ({
          running: false,
          tabs: st.tabs.map((t, i) =>
            i === 0 ? { ...t, status: 'error', error: opened.error ?? 'Could not connect.' } : t,
          ),
        }));
        return;
      }
    }

    for (const [i, statement] of statements.entries()) {
      if (cancelledBatch) {
        set((st) => ({
          tabs: st.tabs.map((t, j) =>
            j >= i && t.status === 'pending' ? { ...t, status: 'cancelled' } : t,
          ),
        }));
        break;
      }
      // Stop the batch at the first failure. Running statement three after
      // two blew up is how you get a confusing half-applied script.
      if (get().tabs[i - 1]?.status === 'error') {
        set((st) => ({
          tabs: st.tabs.map((t, j) =>
            j >= i ? { ...t, status: 'error', error: 'Skipped — an earlier statement failed.' } : t,
          ),
        }));
        break;
      }

      const started = Date.now();
      let runId: string;
      try {
        ({ runId } = await window.overdb.invoke('query:run', {
          connectionId, sql: statement.sql, origin: 'editor',
        }));
      } catch (err) {
        set((st) => ({
          tabs: st.tabs.map((t, j) =>
            j === i ? { ...t, status: 'error', error: err instanceof Error ? err.message : String(err) } : t,
          ),
        }));
        continue;
      }

      set((st) => ({
        active: i,
        tabs: st.tabs.map((t, j) => (j === i ? { ...t, runId, status: 'running' } : t)),
      }));

      await new Promise<void>((resolve) => settle.set(runId, resolve));
      settle.delete(runId);

      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === i && t.durationMs === null ? { ...t, durationMs: Date.now() - started } : t,
        ),
      }));
    }

    set({ running: false });
    // Land on the first tab that failed, if any — the error is the thing
    // you need to see, not the last successful result.
    const failed = get().tabs.findIndex((t) => t.status === 'error');
    if (failed >= 0) set({ active: failed });
  },

  async cancel() {
    const { connectionId, tabs } = get();
    if (!connectionId) return;
    // Flag first, then ask the server: the flag is what stops the batch
    // moving on, and it must be set even if the cancel round-trip is slow.
    cancelledBatch = true;
    const inFlight = tabs.find((t) => t.status === 'running');
    set((st) => ({
      tabs: st.tabs.map((t) => (t.status === 'running' ? { ...t, status: 'cancelled' } : t)),
    }));
    if (inFlight?.runId) {
      await window.overdb.invoke('query:cancel', { connectionId, runId: inFlight.runId });
      // The host may never send a terminal event for a killed statement, so
      // release the batch loop ourselves rather than hanging on it.
      settle.get(inFlight.runId)?.();
    }
  },

  setActive(active) {
    set({ active });
  },

  async sortBy(index, column, engine) {
    const { connectionId, tabs } = get();
    const tab = tabs[index];
    if (!connectionId || !tab || !isSortable(tab.kind) || get().running) return;

    // asc -> desc -> back to the statement as written. The third state
    // matters: without it there is no way to undo a sort short of re-running
    // by hand, and the unsorted order is sometimes the meaningful one.
    const next: SortDirection | null =
      tab.sort?.column !== column ? 'asc' : tab.sort.direction === 'asc' ? 'desc' : null;

    const sql = next ? wrapWithOrderBy(tab.sql, column, next, engine) : tab.sql;
    const started = Date.now();

    set((st) => ({
      running: true,
      tabs: st.tabs.map((t, j) =>
        j === index
          ? { ...t, status: 'running', rows: [], rowCount: 0, error: null,
              sort: next ? { column, direction: next } : null }
          : t,
      ),
    }));

    try {
      const { runId } = await window.overdb.invoke('query:run', {
        connectionId, sql, origin: 'editor',
      });
      set((st) => ({ tabs: st.tabs.map((t, j) => (j === index ? { ...t, runId } : t)) }));
      await new Promise<void>((resolve) => settle.set(runId, resolve));
      settle.delete(runId);
      set((st) => ({
        tabs: st.tabs.map((t, j) => (j === index ? { ...t, durationMs: Date.now() - started } : t)),
      }));
    } catch (err) {
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === index
            ? { ...t, status: 'error', error: err instanceof Error ? err.message : String(err) }
            : t,
        ),
      }));
    } finally {
      set({ running: false });
    }
  },

  ingest(event) {
    if (!('runId' in event)) return;
    const { connectionId, tabs } = get();
    const idx = tabs.findIndex((t) => t.runId === event.runId);
    if (idx < 0) return;

    if (event.kind === 'query:chunk') {
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === idx
            ? { ...t, columns: event.columns ?? t.columns, rows: t.rows.concat(event.rows) }
            : t,
        ),
      }));
      // Acking is what applies backpressure: the host holds at two unacked
      // chunks, so a fast server cannot outrun this render.
      if (connectionId) {
        void window.overdb.invoke('query:ack', {
          connectionId, runId: event.runId, seq: event.seq,
        });
      }
      return;
    }

    if (event.kind === 'query:done') {
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === idx && t.status !== 'cancelled'
            ? { ...t, status: 'done', rowCount: event.rowCount, truncated: event.truncated }
            : t,
        ),
      }));
    } else if (event.kind === 'query:error') {
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === idx ? { ...t, status: 'error', error: event.message } : t,
        ),
      }));
    }
    settle.get(event.runId)?.();
  },

  reset() {
    set({ tabs: [], active: 0, running: false });
  },
}));

/// Installed once from App. Returns the unsubscribe.
export function subscribeToMainEvents(): () => void {
  return window.overdb.onMainEvent((event) => useQuery.getState().ingest(event));
}
