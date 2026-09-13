import { create } from 'zustand';
import type { Cell, ColumnMeta, Engine, MainToRendererEvent } from '@shared/types';
import { classify, splitStatements } from '@shared/sqlGuard';
import { isSortable, type SortDirection } from '@shared/orderBy';
import { deriveStatement, withFilter, type GridFilter } from '@shared/gridView';
import { withPartiqlCondition, type PartiqlFilterOp } from '@shared/dynamo';
import { sortRows } from '@shared/sortRows';
import { previewUpdate } from '@shared/rowEdit';
import { bindFor, paramSlots, previewBound, resolveParams, unfilledParams } from '@shared/params';
import { useStore } from './store';
import { useFanout } from './fanoutStore';

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
  /// Rows a write changed, when the engine reports it. Distinct from
  /// rowCount, which counts rows RETURNED — zero for every write.
  affectedRows: number | null;
  /// Sorting re-asks the server, so the tab remembers what it asked for.
  /// `local` means it did not: DynamoDB cannot sort, so those rows were
  /// ordered here, and the UI has to say that what was sorted is the rows
  /// that came back rather than the table.
  sort: { column: string; direction: SortDirection; local?: boolean } | null;
  /// The rows as they arrived, kept only while a local sort is applied, so
  /// clicking back to unsorted restores the order the server sent.
  sourceRows?: Cell[][] | null;
  /// Column filters, applied by RE-ASKING the server rather than by hiding
  /// rows: the grid holds at most the row cap, so filtering what is in hand
  /// answers a narrower question than the one being asked, and says nothing
  /// about the difference. See src/shared/gridView.ts.
  filters: GridFilter[];
  /// What the filters were last applied to. DynamoDB has no subquery to wrap
  /// in, so its filters are edited into the statement itself — and the
  /// statement they were edited into is the one to go back to when a filter
  /// is removed.
  baseSql?: string;
}

/// One line of the activity log. Separate from the result tabs on purpose:
/// tabs are wiped by the next run, and "did that actually do anything" is
/// asked precisely about the run that just disappeared.
export interface LogEntry {
  id: string;
  at: number;
  connectionId: string;
  schema: string | null;
  sql: string;
  status: TabStatus;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
  /// Whether it ran outside the read-only envelope — the difference between
  /// a statement that could change something and one the server refused.
  write: boolean;
  /// The server-side run this line is, while it is still running.
  ///
  /// Kept on the log entry and not just on the result tab because a
  /// statement can still be going on a connection you have since switched
  /// away from — and until this was here, the log could SHOW you that and
  /// give you no way to stop it.
  runId: string | null;
}

/// Enough for a session's work without holding a script's worth of SQL
/// forever.
const LOG_LIMIT = 300;

/// The activity log's slot in the same `active` index the result tabs use.
/// Negative, like the plan's -1, so it cannot collide with a statement.
export const LOG_TAB = -2;

/// Per-statement server cost, in the same index. Like the log, it is a
/// standing view rather than the result of anything you ran, so running a
/// statement must not steal focus from it — which is why the two are the
/// only values `active` is preserved across a run (see setTabs below).
export const SLOW_TAB = -3;

/// The schema diagram, in the same index. Standing for the same reason the
/// other two are: it is a property of the connection, not an answer to the
/// statement you just ran.
export const ERD_TAB = -4;

/// The live health pane, same index again. The slow-query tab is what this
/// server REMEMBERS; this one is what it is doing — different questions,
/// and both standing views rather than answers to a statement.
export const HEALTH_TAB = -5;

/// Durable statement history and saved queries. Sits beside the session
/// log rather than replacing it: the log is what is happening now, with a
/// Cancel next to it, and this is what happened at all.
///
/// Deliberately NOT standing, unlike the four above. The others are things
/// you keep open while you work — a live log, what the server is doing,
/// what it remembers, the shape of the schema — and a run that yanked you
/// off one would break the thing it is for. History is not watched, it is
/// searched: you go there to find a statement, press Open, and run it, and
/// at that point history has done its job. Leaving focus here sent you to
/// the result of your own Run by way of clicking a tab.
export const HISTORY_TAB = -6;

/// The standing tabs — log, slow queries, health and the diagram — which a
/// run must not pull focus away from. Returns null for anything else,
/// meaning "this is a result tab, move it".
function standing(active: number): number | null {
  return active === LOG_TAB || active === SLOW_TAB || active === ERD_TAB || active === HEALTH_TAB
    ? active
    : null;
}

interface QueryState {
  connectionId: string | null;
  tabs: ResultTab[];
  active: number;
  running: boolean;
  /// Oldest first, the way a terminal reads.
  log: LogEntry[];

  run(connectionId: string, sql: string, engine: Engine): Promise<void>;
  cancel(): Promise<void>;
  /// Cancel one line of the log, whichever connection it belongs to.
  cancelLogEntry(id: string): Promise<void>;
  setActive(index: number): void;
  /// Cycles a column asc -> desc -> unsorted and re-runs that statement.
  sortBy(index: number, column: string, engine: Engine): Promise<void>;
  /// Sets or clears one column's filter and re-runs that statement.
  filterBy(index: number, filter: GridFilter | null, column: string, engine: Engine): Promise<void>;
  /// Runs one parameterised write that belongs to no tab — an inline cell
  /// edit — then refreshes the tab it was made from. Returns what happened
  /// rather than throwing: the grid says it in place.
  runEdit(
    index: number,
    edit: { sql: string; params: unknown[] },
    engine: Engine,
  ): Promise<{ ok: boolean; affectedRows: number | null; error: string | null }>;
  /// Re-runs one tab with the filters and sort the grid is showing.
  applyView(
    index: number,
    patch: { filters?: GridFilter[]; sort?: ResultTab['sort'] },
    engine: Engine,
  ): Promise<void>;
  ingest(event: MainToRendererEvent): void;
  clearLog(): void;
  reset(): void;
}

/// Resolvers for the statement currently in flight, so the batch can run
/// strictly in order — a later statement may depend on an earlier one.
const settle = new Map<string, () => void>();
/// Outcomes of statements that belong to no tab — inline edits. Read once
/// by the caller that started them, then dropped.
const offTab = new Map<string, { affectedRows: number | null; error: string | null }>();
/// Set the moment a cancel is requested, so the batch loop stops before
/// starting the next statement. Without it, cancelling statement two of five
/// simply moved on to statement three.
let cancelledBatch = false;

/// Fill a statement's placeholders from the value library, for THIS
/// connection.
///
/// Every path that sends SQL to a server goes through here, which is what
/// makes a value a value: `:clientName` becomes `$1` and the text travels
/// beside it, so a name with a quote in it is a name with a quote in it.
///
/// A slot with nothing behind it is refused rather than bound as NULL. `=
/// NULL` matches nothing, and an empty grid that looks like an answer is
/// the worst thing this feature could produce.
function bindStatement(
  connectionId: string,
  sql: string,
  engine: Engine,
): { sql: string; params?: unknown[]; error?: string } {
  const slots = paramSlots(sql, engine);
  if (slots.length === 0) return { sql };

  const app = useStore.getState();
  const conn = app.connections.find((c) => c.id === connectionId);
  const target = { connectionId, env: conn?.env };
  const unfilled = unfilledParams(resolveParams(slots, app.params, target));
  if (unfilled.length > 0) {
    const names = unfilled.map((u) => u.label).join(', ');
    return {
      sql,
      error: `This statement still needs a value for ${names}. Click the amber chip in the statement to fill it in.`,
    };
  }
  try {
    return bindFor(sql, engine, app.params, target);
  } catch (err) {
    return { sql, error: err instanceof Error ? err.message : String(err) };
  }
}

function blankTab(index: number, sql: string): ResultTab {
  return {
    runId: null, index, sql, kind: classify(sql), status: 'pending',
    columns: [], rows: [], rowCount: 0, affectedRows: null, truncated: false,
    error: null, durationMs: null, sort: null, filters: [],
  };
}

export const useQuery = create<QueryState>((set, get) => ({
  connectionId: null,
  tabs: [],
  active: 0,
  running: false,
  log: [],

  async run(connectionId, sql, engine) {
    const statements = splitStatements(sql, engine);
    if (statements.length === 0) return;

    cancelledBatch = false;
    set({
      connectionId,
      tabs: statements.map((s, i) => blankTab(i, s.sql)),
      // Watching the log is a deliberate act — running something is not a
      // reason to yank you back to a grid you were not looking at.
      active: standing(get().active) ?? 0,
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

    // Then the schema the tab in front expects, before the first statement
    // rather than after it. The preference is normally applied at the tail
    // of loadSchemaList, which sits behind a full introspect — so on a
    // fresh launch Run beat it, statement one ran on whatever database the
    // session came up on, and only a second run was on the right one.
    // Costs nothing when the session is already there.
    const bufferKey = useStore.getState().activeBuffer[connectionId];
    if (bufferKey) {
      await useStore.getState().applyBufferSchema(connectionId, bufferKey);
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
      const logId = crypto.randomUUID();
      set((st) => ({
        log: [
          ...st.log,
          {
            id: logId,
            at: started,
            connectionId,
            schema: useStore.getState().activeSchema[connectionId] ?? null,
            sql: statement.sql,
            status: 'running' as TabStatus,
            rowCount: null,
            durationMs: null,
            error: null,
            write: false,
            runId: null,
          },
        ].slice(-LOG_LIMIT),
      }));

      const bound = bindStatement(connectionId, statement.sql, engine);
      if (bound.error) {
        const message = bound.error;
        set((st) => ({
          tabs: st.tabs.map((t, j) => (j === i ? { ...t, status: 'error', error: message } : t)),
          log: st.log.map((l) =>
            l.id === logId
              ? { ...l, status: 'error' as TabStatus, error: message, durationMs: 0 }
              : l,
          ),
        }));
        continue;
      }

      let runId: string;
      let write = false;
      try {
        const accepted = await window.overdb.invoke('query:run', {
          connectionId, sql: bound.sql, params: bound.params, origin: 'editor',
        });
        runId = accepted.runId;
        write = Boolean(accepted.write);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((st) => ({
          tabs: st.tabs.map((t, j) => (j === i ? { ...t, status: 'error', error: message } : t)),
          log: st.log.map((l) =>
            l.id === logId
              ? { ...l, status: 'error' as TabStatus, error: message, durationMs: Date.now() - started }
              : l,
          ),
        }));
        continue;
      }

      set((st) => ({
        active: standing(st.active) ?? i,
        tabs: st.tabs.map((t, j) => (j === i ? { ...t, runId, status: 'running' } : t)),
        log: st.log.map((l) =>
          l.id === logId
            ? {
                ...l,
                write,
                runId,
                // With its values in it. The log answers "what did that
                // just ask"; a row of question marks does not. The durable
                // history below keeps the statement AS WRITTEN, because
                // that is the one worth running again.
                sql: bound.params?.length
                  ? previewBound(bound.sql, bound.params as Cell[], engine)
                  : l.sql,
              }
            : l,
        ),
      }));

      await new Promise<void>((resolve) => settle.set(runId, resolve));
      settle.delete(runId);

      // Into the durable history, once the statement has an outcome. The
      // session log above is wiped by quitting; this is what answers "what
      // was that query I ran on Tuesday". Main decides what is worth
      // keeping (src/shared/history.ts) and does the fold.
      const settled = get().tabs[i];
      void useStore.getState().recordRun({
        connectionId,
        connectionName:
          useStore.getState().connections.find((c) => c.id === connectionId)?.name ?? 'connection',
        schema: useStore.getState().activeSchema[connectionId] ?? null,
        sql: statement.sql,
        at: started,
        ok: settled?.status === 'done',
        rowCount: settled?.affectedRows ?? settled?.rowCount ?? null,
        durationMs: settled?.durationMs ?? Date.now() - started,
        error: settled?.error ?? null,
        write,
      });

      set((st) => {
        const tab = st.tabs[i];
        const durationMs = tab?.durationMs ?? Date.now() - started;
        return {
          tabs: st.tabs.map((t, j) =>
            j === i && t.durationMs === null ? { ...t, durationMs: Date.now() - started } : t,
          ),
          log: st.log.map((l) =>
            l.id === logId
              ? {
                  ...l,
                  status: tab?.status ?? ('done' as TabStatus),
                  // A cancelled statement never reports a rowCount, but the
                  // rows that got here before the cancel are the whole
                  // reason to look at the log line.
                  rowCount:
                    tab?.status === 'cancelled'
                      ? tab.rows.length
                      : tab?.affectedRows ?? tab?.rowCount ?? null,
                  durationMs,
                  error: tab?.error ?? null,
                }
              : l,
          ),
        };
      });
    }

    set({ running: false });

    // A statement can move the session out from under the picker — `USE
    // other_db;` typed as SQL does exactly that, and so does a reconnect
    // mid-batch. Asking once per batch is cheap and keeps the header
    // honest instead of leaving it to be discovered by a confusing error.
    void useStore.getState().syncSchema(connectionId);

    // Land on the first tab that failed, if any — the error is the thing
    // you need to see, not the last successful result.
    const failed = get().tabs.findIndex((t) => t.status === 'error');
    if (failed >= 0 && standing(get().active) === null) set({ active: failed });
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

  /// Stop a statement named by its log line.
  ///
  /// The header's Cancel only ever knew about the pane in front of you. A
  /// long statement on a connection you have switched away from kept
  /// running, visibly, with nothing to press — which is the state the log
  /// exists to make visible and could not act on.
  async cancelLogEntry(id) {
    const entry = get().log.find((l) => l.id === id);
    if (!entry || entry.status !== 'running' || !entry.runId) return;

    // If it is the statement THIS pane is running, go through the normal
    // cancel: that also stops the batch from starting the next statement,
    // which cancelling the run alone would not.
    const mine = get().connectionId === entry.connectionId;
    const inFlight = get().tabs.find((t) => t.runId === entry.runId);
    if (mine && inFlight) return get().cancel();

    set((st) => ({
      log: st.log.map((l) => (l.id === id ? { ...l, status: 'cancelled' as TabStatus } : l)),
    }));
    await window.overdb.invoke('query:cancel', {
      connectionId: entry.connectionId,
      runId: entry.runId,
    });
    // A killed statement may never produce a terminal event, so anything
    // waiting on this run is released here rather than left hanging.
    settle.get(entry.runId)?.();
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

    // DynamoDB has no ORDER BY worth the name and no subquery to wrap the
    // statement in, so re-asking is not on the table — the alternative to
    // sorting these rows here is not sorting at all. The tab records that it
    // was local; the status bar says so.
    if (engine === 'dynamodb') {
      const col = tab.columns.findIndex((c) => c.name === column);
      if (col < 0) return;
      const base = tab.sourceRows ?? tab.rows;
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === index
            ? {
                ...t,
                rows: next ? sortRows(base, col, next, t.columns[col]?.kind) : base,
                sourceRows: next ? base : null,
                sort: next ? { column, direction: next, local: true } : null,
              }
            : t,
        ),
      }));
      return;
    }

    await get().applyView(index, { sort: next ? { column, direction: next } : null }, engine);
  },

  async filterBy(index, filter, column, engine) {
    const tab = get().tabs[index];
    if (!tab) return;
    await get().applyView(index, { filters: withFilter(tab.filters, filter ?? { column, op: '=', value: '' }) }, engine);
  },

  /// Re-ask the server for this tab, with whatever the grid is now showing.
  ///
  /// One path for sorting and filtering, because they are the same act: the
  /// statement the user wrote is never edited — it goes inside a derived
  /// table (or, on DynamoDB, gains a condition) and that is what runs. The
  /// tab keeps the original, so removing every filter goes back to exactly
  /// what was typed.
  async runEdit(index, edit, engine) {
    const { connectionId } = get();
    if (!connectionId || get().running) {
      return { ok: false, affectedRows: null, error: 'Something else is running.' };
    }

    const started = Date.now();
    const logId = crypto.randomUUID();
    set((st) => ({
      running: true,
      log: [
        ...st.log,
        {
          id: logId,
          at: started,
          connectionId,
          schema: useStore.getState().activeSchema[connectionId] ?? null,
          // Logged with its values shown: the log answers "what did that
          // click actually do", and a row of question marks does not.
          sql: previewUpdate(edit.sql, edit.params as Cell[], engine),
          status: 'running' as TabStatus,
          rowCount: null,
          durationMs: null,
          error: null,
          write: true,
          runId: null,
        },
      ].slice(-LOG_LIMIT),
    }));

    let outcome = { affectedRows: null as number | null, error: null as string | null };
    try {
      const { runId } = await window.overdb.invoke('query:run', {
        connectionId, sql: edit.sql, params: edit.params, origin: 'editor',
      });
      set((st) => ({ log: st.log.map((l) => (l.id === logId ? { ...l, runId } : l)) }));
      await new Promise<void>((resolve) => settle.set(runId, resolve));
      settle.delete(runId);
      outcome = offTab.get(runId) ?? outcome;
      offTab.delete(runId);
    } catch (err) {
      outcome = { affectedRows: null, error: err instanceof Error ? err.message : String(err) };
    }

    set((st) => ({
      running: false,
      log: st.log.map((l) =>
        l.id === logId
          ? {
              ...l,
              status: outcome.error ? ('error' as TabStatus) : ('done' as TabStatus),
              rowCount: outcome.affectedRows,
              durationMs: Date.now() - started,
              error: outcome.error,
            }
          : l,
      ),
    }));

    // Re-read rather than patching the cell in place: a trigger, a default or
    // a check constraint may have stored something else, and showing what you
    // typed would be a claim overdb cannot make.
    if (!outcome.error) await get().applyView(index, {}, engine);
    return { ok: !outcome.error, ...outcome };
  },

  async applyView(index, patch, engine) {
    const { connectionId, tabs } = get();
    const tab = tabs[index];
    if (!connectionId || !tab || !isSortable(tab.kind) || get().running) return;

    const filters = patch.filters ?? tab.filters;
    const sort = patch.sort !== undefined ? patch.sort : tab.sort;

    const sql =
      engine === 'dynamodb'
        ? filters.reduce(
            (acc, f) =>
              withPartiqlCondition(
                acc,
                { attribute: f.column, op: f.op as PartiqlFilterOp, value: f.value },
                f.column,
              ),
            tab.sql,
          )
        : deriveStatement(tab.sql, { filters, sort: sort && !sort.local ? sort : null }, engine);

    const started = Date.now();
    set((st) => ({
      running: true,
      tabs: st.tabs.map((t, j) =>
        j === index
          ? {
              ...t,
              status: 'running',
              rows: [],
              rowCount: 0,
              error: null,
              filters,
              sort,
              // A local sort belongs to rows that no longer exist; the fresh
              // ones arrive in the server's order.
              sourceRows: null,
            }
          : t,
      ),
    }));

    // The tab keeps the statement AS WRITTEN, placeholders and all, so a
    // sort or a filter re-binds from the library rather than freezing the
    // values that happened to be in the boxes on the first run.
    const bound = bindStatement(connectionId, sql, engine);
    if (bound.error) {
      const message = bound.error;
      set((st) => ({
        tabs: st.tabs.map((t, j) => (j === index ? { ...t, status: 'error', error: message } : t)),
        running: false,
      }));
      return;
    }

    try {
      const { runId } = await window.overdb.invoke('query:run', {
        connectionId, sql: bound.sql, params: bound.params, origin: 'editor',
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

  clearLog() {
    set({ log: [] });
  },

  ingest(event) {
    if (!('runId' in event)) return;
    // A fan-out's runs belong to the other store. Without this they fall
    // through to the off-tab path below, which parks a resolution nobody
    // will ever collect — one stale entry per member per run, for as long
    // as the window is open.
    if (useFanout.getState().runs.some((r) => r.runId === event.runId)) return;
    const { connectionId, tabs } = get();
    const idx = tabs.findIndex((t) => t.runId === event.runId);
    if (idx < 0) {
      // A statement no tab owns — an inline edit, which reports through its
      // own path. It still has to release whoever is waiting on it, or the
      // edit hangs forever on a promise nothing will settle.
      if (event.kind === 'query:done') {
        offTab.set(event.runId, { affectedRows: event.affectedRows ?? null, error: null });
      } else if (event.kind === 'query:error') {
        offTab.set(event.runId, { affectedRows: null, error: event.message });
      } else {
        return;
      }
      settle.get(event.runId)?.();
      return;
    }

    if (event.kind === 'query:chunk') {
      // Rows that arrive after a cancel are dropped, not appended: a
      // cancelled statement whose grid keeps growing is telling you the
      // cancel did not take. What already arrived stays — it is real, and
      // the status bar says how much of the answer it is.
      //
      // KNOWN OPEN ISSUE (RRW-chunk-concat-quadratic): `concat` copies the
      // whole accumulated array on every chunk, which is quadratic in the
      // number of chunks. A prior attempt at this file replaced it with an
      // in-place push into the previous Zustand state array, which is the
      // same total cost while also mutating state out from under anything
      // still holding the old `rows` reference — a worse bug than the one
      // it replaced, so it was reverted. This is now bounded, not fixed:
      // the 100,000-row cap on `rowLimit` (Sheets.tsx) puts a ceiling of
      // roughly 200 chunks / ~10M element copies on the damage. A real fix
      // needs to accumulate into a ref/buffer outside the store and swap
      // the reference into state on a throttled cadence, which is a bigger
      // change than this pass makes.
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === idx && t.status !== 'cancelled'
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
            ? {
                ...t,
                status: 'done',
                rowCount: event.rowCount,
                // What a write changed, when the engine says so. `0 rows`
                // for a DELETE that removed one is worse than silence.
                affectedRows: event.affectedRows ?? null,
                truncated: event.truncated,
              }
            : t,
        ),
      }));
    } else if (event.kind === 'query:error') {
      // A cancel is usually reported by the server as an error — Postgres
      // says "canceling statement due to user request" — and showing a red
      // failure for something you did on purpose is a lie about what
      // happened.
      set((st) => ({
        tabs: st.tabs.map((t, j) =>
          j === idx && t.status !== 'cancelled'
            ? { ...t, status: 'error', error: event.message }
            : t,
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
  return window.overdb.onMainEvent((event) => {
    // Connection lifecycle is app state, not query state — it goes to the
    // main store so the sidebar can render it.
    if (event.kind === 'conn:state') {
      useStore.getState().setConnState(event.connectionId, event.state);
      return;
    }
    if (event.kind === 'txn:state') {
      useStore.getState().setTxnState(event.connectionId, {
        open: event.open, statements: event.statements, expiresAt: event.expiresAt,
      });
      return;
    }
    // Both stores see every run event and each ignores the runIds it does
    // not own. The alternative — routing by which pane is on screen — gets
    // it wrong the moment a fan-out is still finishing while you click into
    // a single connection.
    useQuery.getState().ingest(event);
    useFanout.getState().ingest(event);
  });
}
