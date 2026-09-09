import { describe, expect, it } from 'vitest';
import { parsePlan } from './plan';

describe('MySQL / MariaDB plans', () => {
  const joined = JSON.stringify({
    query_block: {
      select_id: 1,
      nested_loop: [
        { table: { table_name: 'c', access_type: 'ALL', rows: 1200, filtered: 3.2,
                   attached_condition: "c.client_name like '%hp%'" } },
        { table: { table_name: 'pw', access_type: 'ref', key: 'idx_client', rows: 42, filtered: 100 } },
      ],
    },
  });

  it('flattens a nested_loop join into one row per table, in order', () => {
    const rows = parsePlan('mysql', 'json', joined);
    expect(rows.map((r) => r.title)).toEqual(['c', 'pw']);
    expect(rows[0].access).toBe('ALL');
    expect(rows[1].key).toBe('idx_client');
  });

  it('flags a full scan with no index as the thing to look at', () => {
    const [first, second] = parsePlan('mysql', 'json', joined);
    expect(first.warn).toMatch(/full table scan/i);
    expect(second.warn).toBeUndefined();
  });

  it('flags a condition that discards nearly everything read', () => {
    // 3.2% surviving a scan of 1200+ rows is the shape of a leading-wildcard
    // LIKE, and it is exactly what the user should see first.
    const rows = parsePlan('mysql', 'json', JSON.stringify({
      query_block: { table: { table_name: 't', access_type: 'ref', key: 'k', rows: 50000, filtered: 3.2 } },
    }));
    expect(rows[0].warn).toMatch(/3.2% of rows/);
  });

  it('keeps a message-only plan rather than returning nothing', () => {
    const rows = parsePlan('mysql', 'json', JSON.stringify({
      query_block: { table: { message: 'Impossible WHERE' } },
    }));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('Postgres plans', () => {
  const analyzed = JSON.stringify([
    {
      Plan: {
        'Node Type': 'Nested Loop', 'Plan Rows': 12, 'Actual Rows': 840000,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 12, 'Actual Rows': 840000 },
          { 'Node Type': 'Index Scan', 'Relation Name': 'customers', 'Index Name': 'customers_pkey',
            'Plan Rows': 1, 'Actual Rows': 1 },
        ],
      },
    },
  ]);

  it('walks the tree depth-first with depths', () => {
    const rows = parsePlan('postgres', 'json', analyzed);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(rows[1].title).toBe('Seq Scan on orders');
  });

  it('flags an estimate that is orders of magnitude out', () => {
    // Expecting 12 and getting 840k is the single commonest cause of a bad
    // plan, and it is invisible without ANALYZE.
    const rows = parsePlan('postgres', 'json', analyzed);
    expect(rows[0].warn).toMatch(/estimate off/i);
    expect(rows[2].warn).toBeUndefined();
  });
});

describe('SQLite and fallbacks', () => {
  it('keeps EXPLAIN QUERY PLAN lines as they are', () => {
    const rows = parsePlan('sqlite', 'text', 'SCAN orders\nSEARCH customers USING INDEX pk');
    expect(rows).toHaveLength(2);
    expect(rows[0].warn).toMatch(/full table scan/i);
    expect(rows[1].warn).toBeUndefined();
  });

  it('shows unparseable JSON verbatim rather than swallowing it', () => {
    const rows = parsePlan('mysql', 'json', 'not json at all');
    expect(rows[0].title).toBe('not json at all');
  });
});
