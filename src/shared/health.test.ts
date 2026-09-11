import { describe, expect, it } from 'vitest';
import {
  emptyHealth,
  formatBytes,
  formatDuration,
  killSupport,
  readings,
  seqScanOffenders,
  unusedIndexSummary,
  type HealthSnapshot,
  type Session,
} from './health';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: '1',
    user: 'app',
    application: null,
    clientAddress: null,
    database: 'app',
    state: 'active',
    waitEvent: null,
    query: 'select 1',
    seconds: 1,
    isSelf: false,
    blockedBy: [],
    ...patch,
  };
}

function health(patch: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { ...emptyHealth('postgres'), ...patch };
}

const find = (h: HealthSnapshot, key: string) => readings(h).find((r) => r.key === key);

describe('readings', () => {
  it('says nothing about a measure the server withheld', () => {
    // Rendering 0% where the answer is "this server would not tell me" is a
    // wrong reading, which is worse than a missing one.
    expect(find(health(), 'cache')).toBeUndefined();
    expect(find(health(), 'connections')).toBeUndefined();
  });

  it('escalates as connections fill', () => {
    expect(find(health({ connections: { used: 10, max: 100 } }), 'connections')?.tone).toBe('good');
    expect(find(health({ connections: { used: 75, max: 100 } }), 'connections')?.tone).toBe('watch');
    expect(find(health({ connections: { used: 95, max: 100 } }), 'connections')?.tone).toBe('bad');
  });

  it('does not guess a tone with no ceiling to compare against', () => {
    const r = find(health({ connections: { used: 40, max: null } }), 'connections');
    expect(r?.tone).toBe('unknown');
    expect(r?.value).toBe('40');
  });

  it('reads a cache ratio the way a DBA does', () => {
    expect(find(health({ cacheHitRatio: 0.995 }), 'cache')?.tone).toBe('good');
    expect(find(health({ cacheHitRatio: 0.96 }), 'cache')?.tone).toBe('watch');
    expect(find(health({ cacheHitRatio: 0.8 }), 'cache')?.tone).toBe('bad');
  });

  it('only counts an idle transaction once it has been idle a while', () => {
    // Every session is briefly idle in transaction; flagging that would
    // make the reading meaningless.
    const brief = health({ sessions: [session({ state: 'idle in transaction', seconds: 2 })] });
    expect(find(brief, 'idle-in-txn')?.value).toBe('0');
    const stuck = health({ sessions: [session({ state: 'idle in transaction', seconds: 900 })] });
    expect(find(stuck, 'idle-in-txn')).toMatchObject({ value: '1', tone: 'bad' });
  });

  it('names blocked sessions and who holds the lock', () => {
    const h = health({
      sessions: [session({ id: '2', blockedBy: ['9'] }), session({ id: '3', blockedBy: ['9'] })],
    });
    expect(find(h, 'blocked')).toMatchObject({ value: '2', tone: 'bad' });
    expect(find(h, 'blocked')?.note).toMatch(/1 other session/);
  });

  it('ignores our own connection when reporting the longest statement', () => {
    // overdb's own session is always the one that has been open longest.
    const h = health({
      sessions: [session({ isSelf: true, seconds: 9999 }), session({ seconds: 3 })],
    });
    expect(find(h, 'longest')?.tone).toBe('good');
  });

  it('reads a high rollback rate as something erroring in a loop', () => {
    const h = health({ transactions: { committed: 80, rolledBack: 20 } });
    expect(find(h, 'rollbacks')).toMatchObject({ value: '20.0%', tone: 'bad' });
  });

  it('is quiet about replicas that are keeping up', () => {
    const keeping = health({ replication: [{ client: 'r1', state: 'streaming', lagBytes: 1024 }] });
    expect(find(keeping, 'replication')?.tone).toBe('good');
    const behind = health({ replication: [{ client: 'r1', state: 'streaming', lagBytes: 2 ** 30 }] });
    expect(find(behind, 'replication')?.tone).toBe('watch');
    expect(find(behind, 'replication')?.note).toMatch(/reading the past/);
  });
});

describe('unusedIndexSummary', () => {
  const index = (patch: Partial<HealthSnapshot['unusedIndexes'][number]> = {}) => ({
    schema: 'public', table: 't', index: 'i', scans: 0, bytes: 1024 * 1024, unique: false, ...patch,
  });

  it('never tells you to drop anything', () => {
    // The counter covers the window since stats were reset. An index with
    // no scans might be the one the nightly job needs.
    const text = unusedIndexSummary(health({ unusedIndexes: [index()] })) ?? '';
    expect(text).toMatch(/check before dropping/);
    expect(text).not.toMatch(/drop index/i);
  });

  it('leaves unique indexes out — they are constraints, not optimisations', () => {
    expect(unusedIndexSummary(health({ unusedIndexes: [index({ unique: true })] }))).toBeNull();
  });

  it('is silent when there is nothing to say', () => {
    expect(unusedIndexSummary(health())).toBeNull();
  });
});

describe('seqScanOffenders', () => {
  const scan = (patch: Partial<HealthSnapshot['sequentialScans'][number]>) => ({
    schema: 'public', table: 't', sequentialScans: 10, sequentialRowsRead: 1000,
    indexScans: 0, estimatedRows: 100_000, ...patch,
  });

  it('ignores small tables, where a scan is the right plan', () => {
    expect(seqScanOffenders(health({ sequentialScans: [scan({ estimatedRows: 40 })] }))).toEqual([]);
  });

  it('ranks by rows read, not by scan count', () => {
    // A hundred scans of a thousand rows costs less than one scan of ten
    // million, and ranking by count puts the wrong table first.
    const out = seqScanOffenders(
      health({
        sequentialScans: [
          scan({ table: 'many_small', sequentialScans: 5000, sequentialRowsRead: 50_000 }),
          scan({ table: 'one_huge', sequentialScans: 2, sequentialRowsRead: 10_000_000 }),
        ],
      }),
    );
    expect(out.map((s) => s.table)).toEqual(['one_huge', 'many_small']);
  });
});

describe('formatBytes', () => {
  it('keeps a digit of precision where it matters', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });
});

describe('formatDuration', () => {
  it('reads at the resolution the number deserves', () => {
    expect(formatDuration(0.25)).toBe('250 ms');
    expect(formatDuration(4.2)).toBe('4.2 s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3900)).toBe('1h 5m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });
});

describe('killSupport', () => {
  it('says plainly that SQLite has nothing to kill', () => {
    expect(killSupport('sqlite')).toMatchObject({ cancel: false, terminate: false });
    expect(killSupport('sqlite').note).toMatch(/no server/);
  });

  it('offers both verbs where both exist', () => {
    expect(killSupport('postgres')).toMatchObject({ cancel: true, terminate: true, note: null });
    expect(killSupport('mysql')).toMatchObject({ cancel: true, terminate: true });
  });
});
