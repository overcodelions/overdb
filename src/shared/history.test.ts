import { describe, expect, it } from 'vitest';
import {
  ago,
  clockTime,
  groupByDay,
  HISTORY_LIMIT,
  historyKey,
  normalizeSql,
  oneLine,
  recordRun,
  searchHistory,
  searchSaved,
  suggestName,
  worthRecording,
  type HistoryEntry,
  type RunRecord,
  type SavedQuery,
} from './history';

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    connectionId: 'c1',
    connectionName: 'local',
    schema: 'public',
    sql: 'select * from users where id = 1',
    at: 1_000,
    ok: true,
    rowCount: 1,
    durationMs: 4,
    error: null,
    write: false,
    ...patch,
  };
}

describe('normalizeSql', () => {
  it('reads two spellings of one statement as one', () => {
    expect(normalizeSql('select 1;')).toBe(normalizeSql('  select   1  '));
  });

  it('keeps two genuinely different statements apart', () => {
    expect(historyKey('c1', 'select 1')).not.toBe(historyKey('c1', 'select 2'));
  });

  it('keeps the same statement on two servers apart', () => {
    // "which server was that" is most of the value of an entry.
    expect(historyKey('c1', 'select 1')).not.toBe(historyKey('c2', 'select 1'));
  });
});

describe('recordRun', () => {
  it('rolls a re-run into one entry with a count', () => {
    // Forty entries for one statement is a history nobody scrolls.
    let history: HistoryEntry[] = [];
    history = recordRun(history, run({ at: 1 }));
    history = recordRun(history, run({ at: 2 }));
    history = recordRun(history, run({ at: 3 }));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ runs: 3, at: 3 });
  });

  it('moves a re-run back to the top', () => {
    let history: HistoryEntry[] = [];
    history = recordRun(history, run({ sql: 'select 1 from a', at: 1 }));
    history = recordRun(history, run({ sql: 'select 2 from b', at: 2 }));
    history = recordRun(history, run({ sql: 'select 1 from a', at: 3 }));
    expect(history[0].sql).toBe('select 1 from a');
  });

  it('reports the LAST outcome, not a summary of all of them', () => {
    // An entry that is failing now must not be hidden by its history of
    // success.
    let history = recordRun([], run({ at: 1 }));
    history = recordRun(history, run({ at: 2, ok: false, error: 'relation does not exist' }));
    expect(history[0]).toMatchObject({ ok: false, error: 'relation does not exist', runs: 2 });
  });

  it('ignores an empty statement', () => {
    expect(recordRun([], run({ sql: '   ' }))).toEqual([]);
  });

  it('trims to the cap, oldest first', () => {
    let history: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      history = recordRun(history, run({ sql: `select ${i} from t`, at: i }));
    }
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].sql).toBe(`select ${HISTORY_LIMIT + 4} from t`);
  });
});

describe('worthRecording', () => {
  it('keeps a statement someone wrote', () => {
    expect(worthRecording('select * from users where id = 1')).toBe(true);
  });

  it('drops the grid’s own re-query wrapper', () => {
    // The user wrote the inside of it, and the inside is already recorded.
    expect(worthRecording('select * from (select * from users) overdb_view limit 100')).toBe(false);
  });

  it('drops something too short to be worth finding again', () => {
    // The line sits between these two: one is a connection check, the
    // other is a statement someone typed on purpose.
    expect(worthRecording('select 1')).toBe(false);
    expect(worthRecording('show tables')).toBe(true);
  });
});

describe('searchHistory', () => {
  const history: HistoryEntry[] = [
    { ...recordRun([], run({ sql: 'select * from orders' }))[0] },
    { ...recordRun([], run({ sql: 'delete from carts where stale', write: true, ok: false, error: 'x', connectionId: 'c2', connectionName: 'prod' }))[0] },
  ];

  it('matches every word, in any order', () => {
    expect(searchHistory(history, { query: 'orders select' })).toHaveLength(1);
    expect(searchHistory(history, { query: 'orders nothing' })).toHaveLength(0);
  });

  it('searches the connection name too', () => {
    expect(searchHistory(history, { query: 'prod' })[0].sql).toMatch(/delete/);
  });

  it('narrows to one connection', () => {
    expect(searchHistory(history, { connectionId: 'c2' })).toHaveLength(1);
  });

  it('finds what failed and what wrote', () => {
    expect(searchHistory(history, { failedOnly: true })).toHaveLength(1);
    expect(searchHistory(history, { writesOnly: true })).toHaveLength(1);
  });
});

describe('searchSaved', () => {
  const saved: SavedQuery[] = [
    { id: '1', name: 'stuck jobs', sql: 'select * from jobs', connectionId: null, createdAt: 0, updatedAt: 0, tags: ['ops'] },
  ];

  it('searches the name, the text and the tags', () => {
    expect(searchSaved(saved, 'stuck')).toHaveLength(1);
    expect(searchSaved(saved, 'jobs')).toHaveLength(1);
    expect(searchSaved(saved, 'ops')).toHaveLength(1);
    expect(searchSaved(saved, 'invoices')).toHaveLength(0);
  });
});

describe('oneLine', () => {
  it('flattens and clips', () => {
    expect(oneLine('select\n  *\nfrom users')).toBe('select * from users');
    expect(oneLine('select * from users', 10)).toBe('select * …');
  });
});

describe('suggestName', () => {
  it('names a statement after what it does and to what', () => {
    expect(suggestName('select * from public.orders where id = 1')).toBe('select public.orders');
    expect(suggestName('delete from carts where stale')).toBe('delete carts');
    expect(suggestName('update users set x = 1')).toBe('update users');
  });

  it('strips the quoting around a name', () => {
    expect(suggestName('select * from "my table"')).toBe('select my');
  });

  it('falls back to the text rather than to Untitled', () => {
    // A list of five things called Untitled is a list of nothing.
    expect(suggestName('show processlist')).toBe('show processlist');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  it('reads at the resolution the gap deserves', () => {
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(ago(now - 5 * 86400_000, now)).toBe('5d ago');
    expect(ago(now - 200 * 86400_000, now)).toBe('2026-02-22');
  });
});

describe('clockTime', () => {
  it('is a fixed-width clock, so it reads down as a column', () => {
    const at = new Date(2026, 8, 10, 9, 5).getTime();
    expect(clockTime(at)).toBe('09:05');
  });
});

describe('groupByDay', () => {
  const now = new Date(2026, 8, 10, 12, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0).getTime();

  const entry = (ms: number): HistoryEntry =>
    recordRun([], run({ sql: `select ${ms} from t`, at: ms }))[0];

  it('names today and yesterday in the reader\'s own timezone', () => {
    const days = groupByDay([entry(at(10, 11)), entry(at(9, 18))], now);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday']);
  });

  it('dates anything older', () => {
    const days = groupByDay([entry(at(3, 9))], now);
    expect(days[0].label).not.toBe('Today');
    expect(days[0].label).toMatch(/Sep/);
  });

  it('keeps the newest day first and its entries in order', () => {
    const days = groupByDay([entry(at(10, 17)), entry(at(10, 9)), entry(at(8, 9))], now);
    expect(days).toHaveLength(2);
    expect(days[0].entries).toHaveLength(2);
    expect(days[0].entries[0].at).toBeGreaterThan(days[0].entries[1].at);
  });

  it('does not start a second group for an entry that arrives out of order', () => {
    const days = groupByDay([entry(at(10, 17)), entry(at(9, 12)), entry(at(10, 8))], now);
    expect(days.map((d) => d.entries.length)).toEqual([2, 1]);
  });

  it('has nothing to say about an empty history', () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
