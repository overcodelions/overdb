import { describe, expect, it } from 'vitest';
import {
  classifyMysqlProbeError,
  digestTruncated,
  classifyPgProbeError,
  deltaStats,
  isRetryable,
  scanRatio,
  sortStats,
  type StatementStat,
} from './slowQueries';
import { mysqlCanTruncateDigests } from '../db/adapters/mysql';

function stat(p: Partial<StatementStat> & { digest: string }): StatementStat {
  return {
    sql: 'select 1',
    redacted: false,
    truncated: false,
    calls: 1,
    totalMs: 1,
    meanMs: 1,
    maxMs: null,
    rowsReturned: null,
    rowsExamined: null,
    noIndexUsed: null,
    extra: {},
    ...p,
  };
}

describe('classifyPgProbeError', () => {
  const ctx = { variant: 'postgres' as const, available: false, user: 'app' };

  it('sends a missing view to CREATE EXTENSION when the extension is available', () => {
    const r = classifyPgProbeError({ code: '42P01' }, { ...ctx, available: true });
    expect(r.code).toBe('not-installed');
    expect(r).toHaveProperty('ddl', 'CREATE EXTENSION pg_stat_statements');
  });

  it('sends a missing view to shared_preload_libraries when it is NOT available', () => {
    // The distinction that matters: one is a statement away, the other
    // needs a restart, and telling a user to run CREATE EXTENSION on a
    // server that cannot load the library wastes their afternoon.
    const r = classifyPgProbeError({ code: '42P01' }, { ...ctx, available: false });
    expect(r.code).toBe('needs-restart');
    expect(r).toHaveProperty('parameter', 'shared_preload_libraries');
  });

  it('marks Aurora as managed, so the UI does not offer a knob nobody here can turn', () => {
    const r = classifyPgProbeError({ code: '42P01' }, { ...ctx, variant: 'aurora-postgres' });
    expect(r).toMatchObject({ code: 'needs-restart', managed: true });
  });

  it('turns a privilege error into the GRANT a DBA would run, naming the real user', () => {
    const r = classifyPgProbeError({ code: '42501', message: 'permission denied' }, ctx);
    expect(r).toMatchObject({
      code: 'permission-denied',
      grant: 'GRANT pg_read_all_stats TO app',
    });
  });

  it('treats an installed-but-not-preloaded extension as needing a restart', () => {
    expect(classifyPgProbeError({ code: '55000' }, ctx).code).toBe('needs-restart');
  });

  it('keeps the server message for anything unrecognised rather than swallowing it', () => {
    const r = classifyPgProbeError({ code: 'XX999', message: 'internal error' }, ctx);
    expect(r).toMatchObject({ code: 'probe-failed', serverMessage: 'internal error' });
  });
});

describe('classifyMysqlProbeError', () => {
  const ctx = { variant: 'mysql' as const, user: 'app' };

  it('turns 1142 into a performance_schema GRANT', () => {
    const r = classifyMysqlProbeError({ errno: 1142, message: 'denied' }, ctx);
    expect(r).toMatchObject({
      code: 'permission-denied',
      grant: "GRANT SELECT ON performance_schema.* TO 'app'@'%'",
    });
  });

  it('treats a missing table as unsupported, not as something to configure', () => {
    // 1146 means the performance schema was compiled out. No parameter
    // brings it back, so offering a fix would be a lie.
    expect(classifyMysqlProbeError({ errno: 1146 }, ctx).code).toBe('unsupported');
  });
});

describe('isRetryable', () => {
  it('offers a retry for privileges, which can change inside a live session', () => {
    expect(
      isRetryable({ code: 'permission-denied', detail: '', grant: '', serverMessage: '' }),
    ).toBe(true);
  });

  it('offers no retry for a restart or an engine that will never have this', () => {
    expect(
      isRetryable({ code: 'needs-restart', detail: '', parameter: 'x', managed: true }),
    ).toBe(false);
    expect(isRetryable({ code: 'unsupported', detail: '', engine: 'sqlite' })).toBe(false);
  });
});

describe('deltaStats', () => {
  it('reports only what happened in the window, and recomputes the mean from it', () => {
    const before = [stat({ digest: 'a', calls: 100, totalMs: 1000 })];
    const after = [stat({ digest: 'a', calls: 110, totalMs: 1200 })];
    expect(deltaStats(before, after)).toEqual([
      expect.objectContaining({ digest: 'a', calls: 10, totalMs: 200, meanMs: 20 }),
    ]);
  });

  it('drops statements that have not run since the baseline', () => {
    const s = [stat({ digest: 'a', calls: 100, totalMs: 1000 })];
    expect(deltaStats(s, s)).toEqual([]);
  });

  it('keeps a statement that is new since the baseline, whole', () => {
    const after = [stat({ digest: 'b', calls: 4, totalMs: 40 })];
    expect(deltaStats([], after)).toEqual([expect.objectContaining({ digest: 'b', calls: 4 })]);
  });

  it('drops a statement whose counters went backwards', () => {
    // A server restart, someone else calling reset, or the digest being
    // evicted and re-entered. A negative delta is not a number to render.
    const before = [stat({ digest: 'a', calls: 100, totalMs: 1000 })];
    const after = [stat({ digest: 'a', calls: 3, totalMs: 30 })];
    expect(deltaStats(before, after)).toEqual([]);
  });

  it('drops max, which is a high-water mark and cannot be subtracted', () => {
    const before = [stat({ digest: 'a', calls: 1, totalMs: 10, maxMs: 900 })];
    const after = [stat({ digest: 'a', calls: 2, totalMs: 20, maxMs: 900 })];
    expect(deltaStats(before, after)[0].maxMs).toBeNull();
  });

  it('keeps a null counter null rather than turning it into zero', () => {
    const before = [stat({ digest: 'a', calls: 1, totalMs: 1, rowsExamined: null })];
    const after = [stat({ digest: 'a', calls: 2, totalMs: 2, rowsExamined: null })];
    expect(deltaStats(before, after)[0].rowsExamined).toBeNull();
  });
});

describe('sortStats', () => {
  const rows = [
    stat({ digest: 'a', calls: 1, totalMs: 900, meanMs: 900 }),
    stat({ digest: 'b', calls: 500, totalMs: 500, meanMs: 1 }),
  ];

  it('orders by the axis asked for, because the three find different problems', () => {
    expect(sortStats(rows, 'total').map((r) => r.digest)).toEqual(['a', 'b']);
    expect(sortStats(rows, 'mean').map((r) => r.digest)).toEqual(['a', 'b']);
    expect(sortStats(rows, 'calls').map((r) => r.digest)).toEqual(['b', 'a']);
  });

  it('does not mutate what it was given', () => {
    sortStats(rows, 'calls');
    expect(rows.map((r) => r.digest)).toEqual(['a', 'b']);
  });
});

describe('scanRatio', () => {
  it('finds the missing index', () => {
    expect(scanRatio(stat({ digest: 'a', calls: 50, rowsExamined: 50_000, rowsReturned: 50 }))).toBe(
      1000,
    );
  });

  it('says nothing on too few calls to mean anything', () => {
    expect(scanRatio(stat({ digest: 'a', calls: 2, rowsExamined: 2000, rowsReturned: 2 }))).toBeNull();
  });

  it('says nothing where the engine does not count examined rows', () => {
    expect(scanRatio(stat({ digest: 'a', calls: 99, rowsExamined: null, rowsReturned: 5 }))).toBeNull();
  });

  it('says nothing for a statement that returns no rows, rather than dividing by zero', () => {
    expect(scanRatio(stat({ digest: 'a', calls: 99, rowsExamined: 500, rowsReturned: 0 }))).toBeNull();
  });
});

describe('mysqlCanTruncateDigests', () => {
  it('accepts DROP at global scope', () => {
    expect(
      mysqlCanTruncateDigests(["GRANT SELECT, INSERT, DROP ON *.* TO `app`@`%`"]),
    ).toBe(true);
  });

  it('accepts ALL PRIVILEGES, which includes DROP', () => {
    expect(mysqlCanTruncateDigests(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`'])).toBe(true);
  });

  it('accepts DROP granted on performance_schema itself', () => {
    expect(
      mysqlCanTruncateDigests(['GRANT SELECT, DROP ON `performance_schema`.* TO `app`@`%`']),
    ).toBe(true);
  });

  it('refuses SELECT alone, which is enough to read and not to truncate', () => {
    expect(mysqlCanTruncateDigests(['GRANT SELECT ON *.* TO `app`@`%`'])).toBe(false);
  });

  it('refuses DROP on some other schema', () => {
    expect(mysqlCanTruncateDigests(['GRANT ALL PRIVILEGES ON `shop`.* TO `app`@`%`'])).toBe(false);
  });

  it('refuses when there is nothing parseable, rather than guessing yes', () => {
    // An unsure parse must say no: a Reset button that errors is worse
    // than an absent one.
    expect(mysqlCanTruncateDigests(['GRANT `some_role`@`%` TO `app`@`%`'])).toBe(false);
    expect(mysqlCanTruncateDigests([])).toBe(false);
  });
});

describe('digestTruncated', () => {
  it('spots the marker MySQL appends when it ran out of digest length', () => {
    expect(digestTruncated('SELECT `a` FROM `t` JOIN `u` ON ...')).toBe(true);
  });

  it('does not mistake a collapsed value list for a lost tail', () => {
    // `IN (...)` is normalization, not truncation: MySQL always writes a
    // value list that way, however short the statement is.
    expect(digestTruncated('SELECT ? FROM `t` WHERE `id` IN (...)')).toBe(false);
  });

  it('ignores trailing whitespace, which the server sometimes leaves', () => {
    expect(digestTruncated('SELECT ? FROM `t` WHERE ...  \n')).toBe(true);
  });

  it('is false for an ordinary complete digest', () => {
    expect(digestTruncated('SELECT ? FROM `t`')).toBe(false);
  });
});
