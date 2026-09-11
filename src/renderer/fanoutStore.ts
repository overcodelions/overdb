import { create } from 'zustand';
import type { EnvSet, MainToRendererEvent } from '@shared/types';
import { classify, splitStatements } from '@shared/sqlGuard';
import { bindFor, paramSlots, resolveParams, unfilledParams } from '@shared/params';
import { blankRun, fanoutRefusal, type MemberRun } from '@shared/fanout';
import { parsePlan } from '@shared/plan';
import type { MemberPlan } from '@shared/planDiff';
import { useStore } from './store';

/// Running one statement across every member of an environment set.
///
/// THIS ORCHESTRATES, IT DOES NOT EXECUTE. Every member goes through the
/// same `query:run` the editor uses — one execute channel, and the write
/// gate, the row cap and the cancel path all stay exactly where they are.
/// A `fanout:run` in main would have meant a second execute channel and a
/// second copy of all of it, which is how the two drift apart.
///
/// Nothing aborts the batch. A member that cannot connect is a member that
/// cannot connect: the other four still have answers, and a partial result
/// you can read beats an exception that hides them.

/// How many members run at once.
///
/// They are different servers, so this is not about the database — it is
/// about the row cap: every concurrent run can hold a grid in memory, and
/// twelve environments answering at once is twelve grids arriving together.
const CONCURRENCY = 4;

interface FanoutState {
  envSetId: string | null;
  sql: string;
  runs: MemberRun[];
  running: boolean;
  /// Which member's grid is on screen. Null shows the comparison instead.
  focused: string | null;
  /// Why the statement was not run at all, when it was refused outright.
  refusal: string | null;
  /// Each member's plan for the statement, once asked for. Kept apart from
  /// `runs` because explaining is not running: it can be asked before a
  /// statement has ever been executed, and it stays valid when the results
  /// are thrown away.
  plans: MemberPlan[];
  explaining: boolean;
  /// A statement handed over from a single connection's editor, waiting for
  /// the fan-out pane to pick it up.
  ///
  /// A handoff rather than a direct call because the two panes are never
  /// mounted at the same time: pressing "Run on a set" from a connection
  /// selects the set, which unmounts the connection's pane and mounts the
  /// set's. The statement has to survive that gap, and `nonce` is what
  /// makes running the same statement twice in a row a second event rather
  /// than a no-op.
  handoff: { envSetId: string; sql: string; nonce: number } | null;
  /// What is in the set's editor right now.
  ///
  /// In the store rather than in the pane, because React remounts the pane
  /// — StrictMode does it on every mount in development — and local state
  /// does not survive that. A handoff arriving on the first pass would set
  /// local state the remount then threw away, leaving the statement running
  /// with an empty editor above it. Distinct from `sql`, which is the
  /// statement that actually RAN.
  editorSql: string;
  setEditorSql(text: string): void;
  handOff(envSetId: string, sql: string): void;
  clearHandoff(): void;

  run(envSet: EnvSet, sql: string): Promise<void>;
  explain(envSet: EnvSet, sql: string): Promise<void>;
  cancel(): Promise<void>;
  focus(connectionId: string | null): void;
  ingest(event: MainToRendererEvent): void;
  reset(): void;
}

/// Resolvers for runs in flight, keyed by runId — the same shape the
/// editor's store uses, for the same reason: a run finishes on an event, and
/// the orchestrator has to await it.
const settle = new Map<string, () => void>();
let cancelled = false;

export const useFanout = create<FanoutState>((set, get) => ({
  envSetId: null,
  sql: '',
  runs: [],
  running: false,
  focused: null,
  refusal: null,
  plans: [],
  explaining: false,
  handoff: null,
  editorSql: '',

  setEditorSql(text) {
    set({ editorSql: text });
  },

  handOff(envSetId, sql) {
    // The editor text is set HERE, not when the pane picks the handoff up.
    //
    // FanoutPane mounts with `editorSql` as its document, and SqlEditor is
    // mount-once by design — `value` is the initial doc and later changes
    // flow outward, never back in. Setting the text from the pane's own
    // effect therefore happens one tick too late: the statement reaches the
    // store, the fan-out runs it, and the editor above the results sits
    // empty. Writing it before the pane exists is what puts it on screen.
    set((st) => ({
      editorSql: sql,
      handoff: { envSetId, sql, nonce: (st.handoff?.nonce ?? 0) + 1 },
    }));
  },

  clearHandoff() {
    set({ handoff: null });
  },

  async run(envSet, sql) {
    const connections = useStore.getState().connections;
    const members = envSet.memberIds
      .map((id) => connections.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (!members.length) return;

    // Classified against the baseline's engine, or the first member's: the
    // statement is one string and the engines may differ, and guessing per
    // member would mean the same text is a write on one and a read on
    // another. Whichever way that resolved, it would be surprising.
    const engine =
      members.find((m) => m.id === envSet.baselineId)?.engine ?? members[0].engine;
    const statements = splitStatements(sql, engine);
    if (!statements.length) return;

    const refusal = fanoutRefusal(statements.map((s) => classify(s.sql)));
    if (refusal) {
      set({ envSetId: envSet.id, sql, refusal, runs: [], running: false, focused: null });
      return;
    }

    cancelled = false;
    set({
      envSetId: envSet.id,
      sql: statements[0].sql,
      refusal: null,
      running: true,
      // Plans belong to the statement they were asked about. Keeping them
      // across a new run would show you how the LAST query was planned
      // beside this one's results.
      plans: [],
      // The baseline first, always. It is the thing everything else is read
      // against, and hunting for it in member order is a small tax paid on
      // every single comparison.
      runs: [...members]
        .sort((a, b) => Number(b.id === envSet.baselineId) - Number(a.id === envSet.baselineId))
        .map((m) => blankRun(m.id, m.engine, m.variant)),
      focused: null,
    });

    const queue = get().runs.map((r) => r.connectionId);
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        if (cancelled) {
          patch(set, id, { status: 'blocked', error: 'Cancelled before it started.' });
          continue;
        }
        await runOne(set, get, id, statements[0].sql, envSet.memberSchemas?.[id]);
      }
    });
    await Promise.all(workers);

    set({ running: false });
  },

  /// Ask every member how it would run the statement.
  ///
  /// A separate action from running it, and a separate channel:
  /// `query:explain` plans a statement, it does not execute one. So this
  /// needs none of run()'s refusals — explaining a write is harmless, and
  /// refusing to explain one would withhold the answer to "why is this
  /// migration slow on prod".
  async explain(envSet, sql) {
    const connections = useStore.getState().connections;
    const members = envSet.memberIds
      .map((id) => connections.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (!members.length) return;

    const engine = members.find((m) => m.id === envSet.baselineId)?.engine ?? members[0].engine;
    const statements = splitStatements(sql, engine);
    if (!statements.length) return;
    const statement = statements[0].sql.trim().replace(/;\s*$/, '');

    set({
      envSetId: envSet.id,
      explaining: true,
      plans: [...members]
        .sort((a, b) => Number(b.id === envSet.baselineId) - Number(a.id === envSet.baselineId))
        .map((m) => ({ connectionId: m.id, engine: m.engine, rows: [], error: null })),
    });

    // Sequential rather than fanned out: an EXPLAIN is cheap and this is a
    // background curiosity, not the thing you are waiting on. Four at once
    // buys nothing and wakes four connections.
    for (const member of members) {
      const bound = bindForMember(member.id, statement);
      if (bound.error) {
        set((st) => ({
          plans: st.plans.map((p) =>
            p.connectionId === member.id ? { ...p, error: bound.error ?? null } : p,
          ),
        }));
        continue;
      }
      try {
        const result = await window.overdb.invoke('query:explain', {
          connectionId: member.id,
          sql: bound.sql,
          params: bound.params,
          analyze: false,
        });
        const rows = parsePlan(member.engine, result.format, result.plan);
        set((st) => ({
          plans: st.plans.map((p) => (p.connectionId === member.id ? { ...p, rows } : p)),
        }));
      } catch (err) {
        set((st) => ({
          plans: st.plans.map((p) =>
            p.connectionId === member.id ? { ...p, error: message(err) } : p,
          ),
        }));
      }
    }

    set({ explaining: false });
  },

  async cancel() {
    cancelled = true;
    const inFlight = get().runs.filter((r) => r.status === 'running' && r.runId);
    set((st) => ({
      runs: st.runs.map((r) =>
        r.status === 'running' || r.status === 'connecting' || r.status === 'pending'
          ? { ...r, status: 'cancelled' }
          : r,
      ),
    }));
    await Promise.all(
      inFlight.map(async (r) => {
        await window.overdb.invoke('query:cancel', {
          connectionId: r.connectionId,
          runId: r.runId as string,
        });
        // A killed statement may never produce a terminal event, so release
        // the worker rather than leaving the whole fan-out hanging on it.
        settle.get(r.runId as string)?.();
      }),
    );
  },

  focus(connectionId) {
    set({ focused: connectionId });
  },

  ingest(event) {
    if (!('runId' in event)) return;
    const run = get().runs.find((r) => r.runId === event.runId);
    if (!run) return;

    if (event.kind === 'query:chunk') {
      set((st) => ({
        runs: st.runs.map((r) =>
          r.runId === event.runId && r.status !== 'cancelled'
            ? { ...r, columns: event.columns ?? r.columns, rows: r.rows.concat(event.rows) }
            : r,
        ),
      }));
      // Acking is what applies backpressure — without it a fast server can
      // outrun this render, and with four of them running at once that is
      // four times as easy to do.
      void window.overdb.invoke('query:ack', {
        connectionId: run.connectionId,
        runId: event.runId,
        seq: event.seq,
      });
      return;
    }

    if (event.kind === 'query:done') {
      set((st) => ({
        runs: st.runs.map((r) =>
          r.runId === event.runId && r.status !== 'cancelled'
            ? {
                ...r,
                status: 'done',
                rowCount: event.rowCount,
                affectedRows: event.affectedRows ?? null,
                truncated: event.truncated,
              }
            : r,
        ),
      }));
    } else if (event.kind === 'query:error') {
      set((st) => ({
        runs: st.runs.map((r) =>
          r.runId === event.runId && r.status !== 'cancelled'
            ? { ...r, status: 'error', error: event.message }
            : r,
        ),
      }));
    }
    settle.get(event.runId)?.();
  },

  reset() {
    set({
      runs: [], running: false, focused: null, refusal: null, sql: '',
      plans: [], explaining: false,
      // The editor goes too: a statement written against one set is rarely
      // what you meant to ask a different one, and leaving it there under
      // the new set's name is the kind of wrong that gets run.
      editorSql: '',
    });
  },
}));

type Set = (fn: (state: FanoutState) => Partial<FanoutState>) => void;
type Get = () => FanoutState;

function patch(set: Set, connectionId: string, next: Partial<MemberRun>): void {
  set((st) => ({
    runs: st.runs.map((r) => (r.connectionId === connectionId ? { ...r, ...next } : r)),
  }));
}

/// Fill the statement's placeholders for ONE member.
///
/// This is the reason placeholder values are layered by environment rather
/// than typed into a box next to the editor. The same statement goes to
/// four connections, and each one binds the value that belongs to where it
/// is running: local's client id locally, prod's on prod. Nobody edits the
/// SQL between members, so what is compared is genuinely one question.
function bindForMember(
  connectionId: string,
  sql: string,
): { sql: string; params?: unknown[]; error?: string } {
  const app = useStore.getState();
  const conn = app.connections.find((c) => c.id === connectionId);
  if (!conn) return { sql, error: 'That connection no longer exists.' };
  const slots = paramSlots(sql, conn.engine);
  if (slots.length === 0) return { sql };

  const target = { connectionId, env: conn.env };
  const unfilled = unfilledParams(resolveParams(slots, app.params, target));
  if (unfilled.length > 0) {
    return {
      sql,
      error: `No value for ${unfilled.map((u) => u.label).join(', ')} on this connection.`,
    };
  }
  try {
    return bindFor(sql, conn.engine, app.params, target);
  } catch (err) {
    return { sql, error: message(err) };
  }
}

/// One member, start to finish. Every failure lands on that member and
/// nowhere else — this function never throws.
async function runOne(
  set: Set,
  get: Get,
  connectionId: string,
  sql: string,
  wantSchema: string | undefined,
): Promise<void> {
  const started = Date.now();
  patch(set, connectionId, { status: 'connecting' });

  try {
    if (!(await window.overdb.invoke('conn:isOpen', connectionId))) {
      const opened = await window.overdb.invoke('conn:open', connectionId);
      if (!opened.ok) {
        patch(set, connectionId, {
          status: 'error',
          error: opened.error ?? 'Could not connect.',
          durationMs: Date.now() - started,
        });
        return;
      }
    }
  } catch (err) {
    patch(set, connectionId, {
      status: 'error',
      error: message(err),
      durationMs: Date.now() - started,
    });
    return;
  }

  if (cancelled) {
    patch(set, connectionId, { status: 'cancelled' });
    return;
  }

  // Point the session at the schema this member holds the database under.
  // The same statement means different things on connections whose current
  // schema differs, and "it worked locally" is exactly how that gets
  // discovered — by reading an answer from the wrong database.
  if (wantSchema) {
    const store = useStore.getState();
    if (store.activeSchema[connectionId] !== wantSchema) {
      // Never out from under an open transaction. The statements already in
      // it ran against the schema it started on, and moving the session to
      // satisfy a fan-out is how you commit against tables nobody looked
      // at — the same rule the editor's tab switching follows.
      if (store.txnState[connectionId]?.open) {
        patch(set, connectionId, {
          status: 'blocked',
          error: `A transaction is open on this connection, so it stays on ${
            store.activeSchema[connectionId] ?? 'its current schema'
          }. Commit or roll back, then run again.`,
          durationMs: Date.now() - started,
        });
        return;
      }
      try {
        await store.switchSchema(connectionId, wantSchema);
      } catch (err) {
        patch(set, connectionId, {
          status: 'error',
          error: `Could not switch to ${wantSchema}: ${message(err)}`,
          durationMs: Date.now() - started,
        });
        return;
      }
      // switchSchema reports failure by leaving the session where it was
      // rather than throwing, and running anyway would answer from the
      // wrong database while claiming to be on this one.
      const now = useStore.getState().activeSchema[connectionId];
      if (now !== wantSchema) {
        patch(set, connectionId, {
          status: 'error',
          error: `Could not switch to ${wantSchema} — the session is on ${now ?? 'an unknown schema'}.`,
          durationMs: Date.now() - started,
        });
        return;
      }
    }
  }

  const bound = bindForMember(connectionId, sql);
  if (bound.error) {
    // Blocked rather than errored: nothing was asked of the server, and a
    // member missing one value must not read as a database that disagreed
    // with the baseline.
    patch(set, connectionId, {
      status: 'blocked',
      error: bound.error,
      durationMs: Date.now() - started,
    });
    return;
  }

  let runId: string;
  try {
    const accepted = await window.overdb.invoke('query:run', {
      connectionId, sql: bound.sql, params: bound.params, origin: 'editor',
    });
    runId = accepted.runId;
  } catch (err) {
    patch(set, connectionId, {
      status: 'error',
      error: message(err),
      durationMs: Date.now() - started,
    });
    return;
  }

  patch(set, connectionId, { status: 'running', runId });
  await new Promise<void>((resolve) => settle.set(runId, resolve));
  settle.delete(runId);

  const now = get().runs.find((r) => r.connectionId === connectionId);
  if (now?.durationMs === null) patch(set, connectionId, { durationMs: Date.now() - started });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
