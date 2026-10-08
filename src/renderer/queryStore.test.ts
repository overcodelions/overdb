import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToRendererEvent } from '@shared/types';

// The store calls main through window.overdb. Each statement is accepted
// with the next runId, and its outcome is fed in by the test through ingest.
const invoke = vi.fn();
let nextRun = 0;
vi.stubGlobal('window', { overdb: { invoke, onMainEvent: () => () => {} } });

const { useQuery } = await import('./queryStore');
const { useStore } = await import('./store');

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'conn:isOpen') return true;
    if (channel === 'query:run') return { runId: `run-${++nextRun}`, write: false };
    return undefined;
  });
  vi.spyOn(useStore.getState(), 'recordRun').mockResolvedValue(undefined as never);
  vi.spyOn(useStore.getState(), 'syncSchema').mockResolvedValue(undefined as never);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const send = (event: MainToRendererEvent) => useQuery.getState().ingest(event);

async function runAndFinish(connectionId: string, sql: string, rows: unknown[][]) {
  const done = useQuery.getState().run(connectionId, sql, 'postgres');
  await tick();
  const runId = useQuery.getState().tabs[0].runId!;
  send({ kind: 'query:chunk', runId, seq: 0, columns: [{ name: 'n' }] as never, rows: rows as never });
  send({ kind: 'query:done', runId, rowCount: rows.length, affectedRows: null, truncated: false });
  await done;
}

describe('results per selection', () => {
  it('brings back what you ran on a connection after visiting another', async () => {
    useQuery.getState().reset('connection:alpha');
    await runAndFinish('alpha', 'select 1', [[1]]);

    useQuery.getState().reset('connection:beta');
    expect(useQuery.getState().tabs).toEqual([]);
    await runAndFinish('beta', 'select 2', [[2]]);

    useQuery.getState().reset('connection:alpha');
    const back = useQuery.getState();
    expect(back.connectionId).toBe('alpha');
    expect(back.tabs[0].sql).toBe('select 1');
    expect(back.tabs[0].rows).toEqual([[1]]);

    useQuery.getState().reset('connection:beta');
    expect(useQuery.getState().tabs[0].rows).toEqual([[2]]);
  });

  it('keeps filling, and acking, a statement still streaming on a connection you left', async () => {
    useQuery.getState().reset('connection:gamma');
    const done = useQuery.getState().run('gamma', 'select slow', 'postgres');
    await tick();
    const runId = useQuery.getState().tabs[0].runId!;

    useQuery.getState().reset('connection:delta');
    send({ kind: 'query:chunk', runId, seq: 0, columns: [{ name: 'n' }] as never, rows: [[7]] as never });
    expect(invoke).toHaveBeenCalledWith('query:ack', { connectionId: 'gamma', runId, seq: 0 });
    // Nothing leaks into the pane on screen.
    expect(useQuery.getState().tabs).toEqual([]);

    send({ kind: 'query:done', runId, rowCount: 1, affectedRows: null, truncated: false });
    await done;
    expect(useQuery.getState().running).toBe(false);

    useQuery.getState().reset('connection:gamma');
    const back = useQuery.getState();
    expect(back.tabs[0]).toMatchObject({ status: 'done', rows: [[7]] });
    expect(back.running).toBe(false);
  });
});
