import { describe, expect, it } from 'vitest';

import type { Connection, EnvSet } from './types';
import {
  HANDOFF_MAX_BYTES,
  buildHandoff,
  linkedRepos,
  planSummary,
  repoLinkOwner,
  slowStatSummary,
  statementTitle,
} from './overcliHandoff';
import type { StatementStat } from './slowQueries';

const stamp = { id: 'h1', now: 1000 };
const base = {
  kind: 'slow-query' as const,
  title: 'Slow query on orders',
  summary: 's',
  repoHints: ['/work/acme'],
};

describe('buildHandoff', () => {
  it('stamps the fields overcli needs', () => {
    const r = buildHandoff(base, stamp);
    if (!r.ok) throw new Error(r.error);
    expect(r.handoff).toEqual({ v: 1, id: 'h1', from: 'overdb', ...base, evidence: undefined, createdAt: 1000 });
  });

  it('refuses unknown kinds, empty titles, and no repo', () => {
    expect(buildHandoff({ ...base, kind: 'nuke' as never }, stamp).ok).toBe(false);
    expect(buildHandoff({ ...base, title: '  ' }, stamp).ok).toBe(false);
    expect(buildHandoff({ ...base, repoHints: [''] }, stamp).ok).toBe(false);
  });

  it('clips long evidence so the file stays under overcli’s limit', () => {
    const huge = 'x'.repeat(40_000);
    const r = buildHandoff({ ...base, summary: huge, evidence: { sql: huge, plan: huge, error: huge } }, stamp);
    if (!r.ok) throw new Error(r.error);
    expect(Buffer.byteLength(r.json)).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    expect(r.handoff.evidence?.sql?.endsWith('…')).toBe(true);
  });

  it('dedupes env names', () => {
    const r = buildHandoff({ ...base, evidence: { envs: ['prod', 'prod', 'staging'] } }, stamp);
    if (!r.ok) throw new Error(r.error);
    expect(r.handoff.evidence?.envs).toEqual(['prod', 'staging']);
  });
});

describe('repo links', () => {
  const conns = [
    { id: 'c1', name: 'orders-prod', repoPaths: ['/own'] },
    { id: 'c2', name: 'loose', repoPaths: ['/loose'] },
  ] as unknown as Connection[];
  const sets = [
    { id: 's-old', name: 'Old', memberIds: ['c1'], archived: true, repoPaths: ['/archived'] },
    { id: 's1', name: 'Orders', memberIds: ['c1'], repoPaths: ['/work/acme-orders'] },
  ] as unknown as EnvSet[];

  it('keeps the link on the env set a connection belongs to', () => {
    const owner = repoLinkOwner('c1', conns, sets);
    expect(owner).toEqual({ kind: 'envSet', id: 's1', name: 'Orders' });
    expect(linkedRepos(owner!, conns, sets)).toEqual(['/work/acme-orders']);
  });

  it('falls back to the connection when it is in no live set', () => {
    const owner = repoLinkOwner('c2', conns, sets);
    expect(owner).toEqual({ kind: 'connection', id: 'c2', name: 'loose' });
    expect(linkedRepos(owner!, conns, sets)).toEqual(['/loose']);
  });

  it('is null for a connection it does not know', () => {
    expect(repoLinkOwner('nope', conns, sets)).toBeNull();
  });
});

describe('planSummary', () => {
  it('lists findings, and marks estimates as estimates', () => {
    const s = planSummary(
      [{ text: 'orders is scanned in full.', estimated: true }],
      { rowCount: 3, durationMs: 812.4 },
    );
    expect(s).toContain('Ran in 812 ms and returned 3 rows.');
    expect(s).toContain('- orders is scanned in full. (estimated');
  });

  it('says so when there is nothing specific', () => {
    expect(planSummary([], null)).toMatch(/nothing specific/);
  });
});

describe('statementTitle', () => {
  it('names the table read', () => {
    expect(statementTitle('SELECT *\n FROM public."orders" o WHERE 1', 'Slow query')).toBe(
      'Slow query on public.orders',
    );
  });

  it('falls back to the opening words', () => {
    expect(statementTitle('vacuum analyze', 'Slow query')).toBe('Slow query: vacuum analyze');
  });
});

describe('slowStatSummary', () => {
  it('reports the server counters and nothing from a real request', () => {
    const stat = {
      digest: 'd', sql: 'select * from orders where id = $1', redacted: false, truncated: false,
      calls: 1200, totalMs: 96000, meanMs: 80, maxMs: 2400.6, rowsReturned: 1200,
      rowsExamined: 4_800_000, noIndexUsed: 1200, extra: { example: 'id = 42' },
    } as unknown as StatementStat;
    const s = slowStatSummary(stat);
    expect(s).toContain('1,200 calls, 80 ms on average');
    expect(s).toContain('4,800,000 rows examined to return 1,200');
    expect(s).toContain('1,200 calls used no index');
    expect(s).not.toContain('42');
  });
});
