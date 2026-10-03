import { create } from 'zustand';
import type { AiTool, Cell, ColumnMeta, MainToRendererEvent, SeedSize, SeedStep } from '@shared/types';
import type { SeedGate } from '@shared/seedGate';
import type { SeedInvestigation, SeedScript, SeedScriptCheck } from '@shared/seedSql';
import { ensureTerminated } from '@shared/formatSql';
import { suggestionBlock } from '@shared/suggestion';
import { useStore } from './store';

// Seed for a ticket: describe → investigate → plan → SQL → run.
//
// The model's part ends at the SQL step. Running is this store sending the
// script, statement by statement, through the one execute channel with
// origin 'seed' — which main holds to the seed gate and always wraps in a
// transaction — so what landed can be read back and looked at before it is
// committed. Closing the sheet with that transaction open rolls it back.

export type SeedPhase = 'describe' | 'investigate' | 'plan' | 'sql' | 'run';

export interface SeedInsertResult {
  table: string;
  expected: number;
  affected: number | null;
}

export interface SeedRun {
  status: 'running' | 'open' | 'ending' | 'failed' | 'committed' | 'rolledBack' | 'expired';
  inserted: SeedInsertResult[];
  verify: { columns: ColumnMeta[]; rows: Cell[][]; error: string | null } | null;
  error: string | null;
}

interface Outcome {
  affected: number | null;
  error: string | null;
  columns: ColumnMeta[];
  rows: Cell[][];
}

/// Rows kept from the verify query. It reads back a seed, not a table.
const VERIFY_ROWS = 200;

interface SeedState {
  connectionId: string | null;
  phase: SeedPhase;
  need: string;
  size: SeedSize;
  readRepo: boolean;

  checking: boolean;
  gate: SeedGate | null;
  gateError: string | null;
  repo: string | null;
  /// The schema the session is on, every schema the seed could cover, and
  /// the ones it covers besides its own.
  schema: string | null;
  schemas: string[];
  alsoSchemas: string[];
  /// There is a database map to plan from.
  hasMap: boolean;
  tools: Record<AiTool, boolean> | null;
  tool: AiTool | null;

  jobId: string | null;
  busy: 'investigate' | 'revise' | 'write' | null;
  startedAt: number | null;
  steps: SeedStep[];
  error: string | null;

  investigation: SeedInvestigation | null;
  readCode: boolean;
  /// Indexes of the plan's assumptions the person has confirmed.
  confirmed: number[];

  script: SeedScript | null;
  check: SeedScriptCheck | null;
  /// Problems from a script that failed the checks twice, for the SQL step.
  problems: string[];

  run: SeedRun | null;
  saveQueries: boolean;

  open(connectionId: string): Promise<void>;
  recheck(): Promise<void>;
  /// Leave the flow. Stops a model in flight and rolls back an open seed.
  close(): Promise<void>;
  setNeed(need: string): void;
  setSize(size: SeedSize): void;
  setReadRepo(on: boolean): void;
  setAlsoSchemas(schemas: string[]): void;
  /// The map was made or changed: plan from it, and stop reading the code
  /// by default.
  mapChanged(): Promise<void>;
  setTool(tool: AiTool): void;
  setPhase(phase: SeedPhase): void;
  setSaveQueries(on: boolean): void;
  confirm(index: number): void;
  investigate(): Promise<void>;
  revise(instruction: string): Promise<void>;
  stop(): void;
  writeSql(): Promise<void>;
  runSeed(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /// The seed and the teardown as two editor tabs, instead of running here.
  openInEditor(): void;
  /// Main says the transaction closed — the idle rollback, usually.
  txnClosed(): void;
  owns(runId: string): boolean;
  ingest(event: MainToRendererEvent): void;
}

const INITIAL = {
  connectionId: null,
  phase: 'describe' as SeedPhase,
  need: '',
  size: 'minimal' as SeedSize,
  readRepo: true,
  checking: false,
  gate: null,
  gateError: null,
  repo: null,
  schema: null as string | null,
  schemas: [] as string[],
  alsoSchemas: [] as string[],
  hasMap: false,
  tools: null,
  tool: null,
  jobId: null,
  busy: null,
  startedAt: null,
  steps: [],
  error: null,
  investigation: null,
  readCode: false,
  confirmed: [],
  script: null,
  check: null,
  problems: [],
  run: null,
  saveQueries: true,
};

// Run bookkeeping lives outside the state: nothing renders from it.
const owned = new Set<string>();
const waiting = new Map<string, (o: Outcome) => void>();
const partial = new Map<string, Outcome>();
/// While the seed is sending statements, a run's events can beat `query:run`
/// back to the window. They are held here until the runId is known.
let sending = 0;
const early = new Map<string, { outcome: Outcome; done: boolean }>();

function outcomeFor(runId: string): Outcome {
  let o = partial.get(runId);
  if (!o) {
    o = { affected: null, error: null, columns: [], rows: [] };
    partial.set(runId, o);
  }
  return o;
}

async function send(connectionId: string, sql: string): Promise<Outcome> {
  sending += 1;
  try {
    const { runId } = await window.overdb.invoke('query:run', { connectionId, sql, origin: 'seed' });
    owned.add(runId);
    const before = early.get(runId);
    early.delete(runId);
    if (before) partial.set(runId, before.outcome);
    if (before?.done) {
      partial.delete(runId);
      return before.outcome;
    }
    return await new Promise<Outcome>((resolve) => waiting.set(runId, resolve));
  } catch (err) {
    return { affected: null, error: err instanceof Error ? err.message : String(err), columns: [], rows: [] };
  } finally {
    sending -= 1;
    if (sending === 0) early.clear();
  }
}

/// End the seed's transaction. Straight to main rather than through the
/// store's endTransaction, because the sheet needs to know whether a commit
/// actually landed — a toast is not an answer it can act on.
async function endSeed(connectionId: string, action: 'commit' | 'rollback'): Promise<{ ok: boolean; error?: string }> {
  const res = await window.overdb.invoke(action === 'commit' ? 'txn:commit' : 'txn:rollback', connectionId);
  useStore.getState().setTxnState(connectionId, { open: false, statements: 0, expiresAt: null });
  return res;
}

/// A name for the saved queries, from the need's first line.
function title(need: string): string {
  const first = need.trim().split('\n')[0]?.trim() ?? '';
  const short = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return short || 'Seed';
}

export const useSeed = create<SeedState>((set, get) => ({
  ...INITIAL,

  async open(connectionId) {
    set({ ...INITIAL, connectionId, checking: true });
    const [check, tools] = await Promise.all([
      window.overdb.invoke('seed:check', connectionId),
      window.overdb.invoke('ai:detect'),
    ]);
    if (get().connectionId !== connectionId) return;
    const preferred = useStore.getState().settings.aiTool;
    const tool =
      (preferred && tools[preferred] ? preferred : null) ??
      (['claude', 'codex', 'gemini'] as AiTool[]).find((t) => tools[t]) ??
      null;
    set({
      checking: false,
      gate: check.gate,
      gateError: check.error ?? null,
      repo: check.repo,
      schema: check.schema ?? null,
      schemas: check.schemas ?? [],
      tools,
      tool,
    });
    await get().mapChanged();
  },

  async recheck() {
    const { connectionId } = get();
    if (!connectionId) return;
    set({ checking: true });
    const check = await window.overdb.invoke('seed:check', connectionId);
    if (get().connectionId !== connectionId) return;
    set({ checking: false, gate: check.gate, gateError: check.error ?? null, repo: check.repo, schema: check.schema ?? null, schemas: check.schemas ?? [] });
  },

  async close() {
    const { jobId, run, connectionId } = get();
    if (jobId) void window.overdb.invoke('seed:cancel', jobId);
    if (run?.status === 'open' && connectionId) {
      await endSeed(connectionId, 'rollback');
      useStore.getState().toast('Closed without committing — the seed was rolled back.');
    }
    set({ ...INITIAL });
  },

  setNeed: (need) => set({ need }),
  setSize: (size) => set({ size }),
  setReadRepo: (readRepo) => set({ readRepo }),
  setAlsoSchemas: (alsoSchemas) => set({ alsoSchemas }),
  async mapChanged() {
    const { connectionId } = get();
    if (!connectionId) return;
    const res = await window.overdb.invoke('map:status', connectionId).catch(() => null);
    if (get().connectionId !== connectionId) return;
    const hasMap = !!(res?.ok && res.status?.map);
    // With a map, reading the code is the slow extra, not the default.
    set(hasMap !== get().hasMap ? { hasMap, readRepo: !hasMap } : { hasMap });
  },
  setTool: (tool) => set({ tool }),
  setPhase: (phase) => set({ phase, error: null }),
  setSaveQueries: (saveQueries) => set({ saveQueries }),
  confirm: (index) => set((st) => ({ confirmed: [...new Set([...st.confirmed, index])] })),

  async investigate() {
    const { connectionId, tool, need, size, readRepo } = get();
    if (!connectionId || !tool || !need.trim()) return;
    const jobId = crypto.randomUUID();
    set({
      phase: 'investigate', jobId, busy: 'investigate', startedAt: Date.now(), steps: [], error: null,
      investigation: null, script: null, check: null, problems: [], confirmed: [],
    });
    const res = await window.overdb.invoke('seed:investigate', {
      jobId, connectionId, tool, need, size, readRepo, alsoSchemas: get().alsoSchemas, useMap: true,
    });
    if (get().jobId !== jobId) return;
    if (!res.ok) {
      set({ busy: null, jobId: null, error: res.error });
      return;
    }
    set({ busy: null, jobId: null, investigation: res.investigation, readCode: res.readCode, phase: 'plan' });
  },

  async revise(instruction) {
    const { connectionId, tool, need, size, investigation } = get();
    if (!connectionId || !tool || !investigation || !instruction.trim()) return;
    const jobId = crypto.randomUUID();
    set({ jobId, busy: 'revise', startedAt: Date.now(), error: null });
    const res = await window.overdb.invoke('seed:investigate', {
      jobId, connectionId, tool, need, size, readRepo: false, alsoSchemas: get().alsoSchemas,
      revise: { previous: investigation, instruction },
    });
    if (get().jobId !== jobId) return;
    if (!res.ok) {
      set({ busy: null, jobId: null, error: res.error });
      return;
    }
    // A revised plan keeps what the code said; only the plan is new.
    set({ busy: null, jobId: null, investigation: res.investigation, confirmed: [], script: null, check: null });
  },

  stop() {
    const { jobId, busy } = get();
    if (jobId) void window.overdb.invoke('seed:cancel', jobId);
    set({
      jobId: null,
      busy: null,
      error: null,
      phase: busy === 'investigate' ? 'describe' : get().phase,
    });
  },

  async writeSql() {
    const { connectionId, tool, need, investigation } = get();
    if (!connectionId || !tool || !investigation) return;
    const jobId = crypto.randomUUID();
    set({ jobId, busy: 'write', startedAt: Date.now(), error: null, problems: [] });
    const res = await window.overdb.invoke('seed:write', { jobId, connectionId, tool, need, investigation, alsoSchemas: get().alsoSchemas });
    if (get().jobId !== jobId) return;
    if (!res.ok) {
      set({ busy: null, jobId: null, error: res.error, problems: res.check?.problems ?? [] });
      return;
    }
    set({ busy: null, jobId: null, script: res.script, check: res.check, phase: 'sql', run: null });
  },

  async runSeed() {
    const { connectionId, check } = get();
    if (!connectionId || !check) return;
    const store = useStore.getState();
    // Joining a transaction someone opened in the editor would commit or
    // roll back their work along with the seed.
    if (store.txnState[connectionId]?.open) {
      set({ error: 'A transaction is already open on this connection. Commit or roll it back first.' });
      return;
    }
    set({
      phase: 'run',
      error: null,
      run: {
        status: 'running',
        inserted: check.inserts.map((i) => ({ table: i.table, expected: i.rows, affected: null })),
        verify: null,
        error: null,
      },
    });

    for (let i = 0; i < check.inserts.length; i++) {
      const outcome = await send(connectionId, check.inserts[i].sql);
      set((st) => ({
        run: st.run && {
          ...st.run,
          inserted: st.run.inserted.map((r, j) => (j === i ? { ...r, affected: outcome.affected } : r)),
        },
      }));
      if (outcome.error) {
        // Half a seed is worse than none: what did land goes too.
        await endSeed(connectionId, 'rollback');
        set((st) => ({
          run: st.run && {
            ...st.run,
            status: 'failed',
            error: `The insert into ${check.inserts[i].table} failed: ${outcome.error}. Everything was rolled back.`,
          },
        }));
        return;
      }
    }

    let verify: SeedRun['verify'] = null;
    if (check.verify) {
      const outcome = await send(connectionId, check.verify);
      verify = { columns: outcome.columns, rows: outcome.rows.slice(0, VERIFY_ROWS), error: outcome.error };
    }
    set((st) => ({ run: st.run && { ...st.run, status: 'open', verify } }));
  },

  async commit() {
    const { connectionId, script, need, saveQueries } = get();
    if (!connectionId) return;
    set((st) => ({ run: st.run && { ...st.run, status: 'ending' } }));
    const res = await endSeed(connectionId, 'commit');
    if (!res.ok) {
      // A commit that failed rolled back; the transaction is gone either way.
      set((st) => ({
        run: st.run && { ...st.run, status: 'failed', error: `The commit failed: ${res.error ?? 'unknown error'}. Nothing was kept.` },
      }));
      return;
    }
    set((st) => ({ run: st.run && { ...st.run, status: 'committed' } }));
    if (saveQueries && script) {
      const name = title(need);
      const store = useStore.getState();
      await store.saveQuery({ name: `${name} · seed`, sql: script.seed, connectionId, tags: ['seed'] });
      await store.saveQuery({ name: `${name} · teardown`, sql: script.teardown, connectionId, tags: ['seed', 'teardown'] });
    }
  },

  async rollback() {
    const { connectionId } = get();
    if (!connectionId) return;
    set((st) => ({ run: st.run && { ...st.run, status: 'ending' } }));
    await endSeed(connectionId, 'rollback');
    set((st) => ({ run: st.run && { ...st.run, status: 'rolledBack' } }));
  },

  openInEditor() {
    const { connectionId, script, need } = get();
    if (!connectionId || !script) return;
    const store = useStore.getState();
    const name = title(need);
    const teardown = store.newBuffer(connectionId);
    store.setBuffer(teardown, suggestionBlock(ensureTerminated(script.teardown), `Seed teardown · ${name}`));
    const seed = store.newBuffer(connectionId);
    store.setBuffer(seed, suggestionBlock(ensureTerminated(script.seed), `Seed · ${name}`));
    store.setSheet(null);
    set({ ...INITIAL });
  },

  txnClosed() {
    set((st) => (st.run?.status === 'open' ? { run: { ...st.run, status: 'expired' } } : {}));
  },

  owns: (runId) => owned.has(runId),

  ingest(event) {
    if (!('runId' in event)) return;
    const { runId } = event;
    const mine = owned.has(runId);
    // Not ours, and not possibly ours: nothing of the seed's is in flight.
    if (!mine && sending === 0) return;
    if (!mine) {
      // Possibly ours, arriving before `query:run` returned. Held, and the
      // chunk acked so the host does not stall waiting for a window that
      // does not yet know it owns the run.
      const held = early.get(runId) ?? { outcome: { affected: null, error: null, columns: [], rows: [] }, done: false };
      early.set(runId, held);
      if (event.kind === 'query:chunk') {
        held.outcome.columns = event.columns ?? held.outcome.columns;
        held.outcome.rows = held.outcome.rows.concat(event.rows).slice(0, VERIFY_ROWS);
        const connectionId = get().connectionId;
        if (connectionId) void window.overdb.invoke('query:ack', { connectionId, runId, seq: event.seq });
      } else if (event.kind === 'query:done') {
        held.outcome.affected = event.affectedRows ?? null;
        held.done = true;
      } else if (event.kind === 'query:error') {
        held.outcome.error = event.message;
        held.done = true;
      }
      return;
    }

    const o = outcomeFor(runId);
    if (event.kind === 'query:chunk') {
      o.columns = event.columns ?? o.columns;
      if (o.rows.length < VERIFY_ROWS) o.rows = o.rows.concat(event.rows).slice(0, VERIFY_ROWS);
      const connectionId = get().connectionId;
      if (connectionId) void window.overdb.invoke('query:ack', { connectionId, runId, seq: event.seq });
      return;
    }
    if (event.kind === 'query:done') o.affected = event.affectedRows ?? null;
    else if (event.kind === 'query:error') o.error = event.message;
    else return;
    partial.delete(runId);
    waiting.get(runId)?.(o);
    waiting.delete(runId);
  },
}));
