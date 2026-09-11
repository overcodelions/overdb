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

describe('nested loops', () => {
  it('multiplies the inner side by the rows the outer side produces', () => {
    // MySQL reports rows PER SCAN. The join order is the array order, so the
    // second table runs once per row surviving the first — which is where a
    // bad join's cost actually lives.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          nested_loop: [
            { table: { table_name: 'partner', access_type: 'ALL', rows_examined_per_scan: 1000, filtered: 10 } },
            { table: { table_name: 'client', access_type: 'eq_ref', key: 'PRIMARY', rows_examined_per_scan: 1, filtered: 100 } },
          ],
        },
      }),
    );
    expect(rows[0].loops).toBeUndefined();
    expect(rows[1].loops).toBe(100);
  });
});

describe('MariaDB and materialisation', () => {
  it('reads MariaDB’s block-nl-join, which spells the same join differently', () => {
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          nested_loop: [
            { table: { table_name: 'partner', rows_examined_per_scan: 500, filtered: 100 } },
            { 'block-nl-join': { table: { table_name: 'client', rows_examined_per_scan: 2 } } },
          ],
        },
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(['partner', 'client']);
    expect(rows[1].loops).toBe(500);
  });

  it('marks a materialized subquery as built once rather than looped', () => {
    // The counterpart to a loop: a scan inside a materialisation is read
    // once and reused, so it is not the disaster it looks like.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          table: {
            table_name: 'partner',
            rows_examined_per_scan: 100,
            materialized_from_subquery: {
              query_block: { table: { table_name: 'custom_activity', rows_examined_per_scan: 4148 } },
            },
          },
        },
      }),
    );
    expect(rows[1].title).toBe('custom_activity');
    expect(rows[1].materialized).toBe(true);
    expect(rows[1].loops).toBeUndefined();
  });
});

describe('work after the join', () => {
  // This shipped broken: the parser's catch-all descended into filesort and
  // temporary_table without emitting a step, so a query whose real cost was
  // materialising 665,170 rows and sorting them drew as two table scans and
  // a result — with no sign anything had been left out.
  const mariadb = JSON.stringify({
    query_block: {
      select_id: 1,
      filesort: {
        sort_key: 'count(pw.`id`) desc',
        temporary_table: {
          nested_loop: [
            { table: { table_name: 'p', access_type: 'ALL', rows: 66517, filtered: 100 } },
            {
              table: {
                table_name: 'pw',
                access_type: 'ref',
                key: 'IDX_PARTNERID',
                rows: 10,
                filtered: 100,
                using_index: true,
              },
            },
          ],
        },
      },
    },
  });

  it('emits the passes MariaDB nests around the join', () => {
    expect(parsePlan('mysql', 'json', mariadb).map((r) => r.title)).toEqual([
      'p',
      'pw',
      'temporary table',
      'sort',
    ]);
  });

  it('puts them after the join, because that is when they run', () => {
    // The JSON nests them outside-in — the sort wraps the temporary table
    // wraps the join — and the join happens first.
    const rows = parsePlan('mysql', 'json', mariadb);
    expect(rows.findIndex((r) => r.stage === 'temporary')).toBeGreaterThan(
      rows.findIndex((r) => r.title === 'pw'),
    );
    expect(rows.findIndex((r) => r.stage === 'sort')).toBeGreaterThan(
      rows.findIndex((r) => r.stage === 'temporary'),
    );
  });

  it('sizes them by what the join produced, not by either table', () => {
    // 66,517 rows times 10 each. That product is the number the sort is
    // actually moving, and it appears nowhere in the plan's own fields.
    const stages = parsePlan('mysql', 'json', mariadb).filter((r) => r.stage);
    expect(stages.map((r) => r.rows)).toEqual([665170, 665170]);
  });

  it('names what the sort is ordering by', () => {
    const sort = parsePlan('mysql', 'json', mariadb).find((r) => r.stage === 'sort');
    expect(sort?.condition).toBe('count(pw.`id`) desc');
  });

  it('says a blocking pass blocks', () => {
    const stages = parsePlan('mysql', 'json', mariadb).filter((r) => r.stage);
    expect(stages.every((r) => r.warn !== undefined)).toBe(true);
    expect(stages[1].warn).toMatch(/Nothing is returned until all 665,170/);
  });

  it('reads MySQL 8 spelling of the same work', () => {
    // Same operations, different JSON: named steps carrying booleans
    // instead of nested containers.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          ordering_operation: {
            using_filesort: true,
            grouping_operation: {
              using_temporary_table: true,
              using_filesort: false,
              nested_loop: [
                { table: { table_name: 'p', access_type: 'ALL', rows: 66517, filtered: 100 } },
                { table: { table_name: 'pw', access_type: 'ref', key: 'K', rows: 10, filtered: 100 } },
              ],
            },
          },
        },
      }),
    );
    // One step per operation, not one per boolean. A grouping done through
    // a temporary table is a single pass described two ways, and drawing it
    // as "temporary table" then "group" put two nodes in the river for one
    // pass — which reads as the rows being written out and then grouped
    // separately.
    expect(rows.map((r) => r.title)).toEqual(['p', 'pw', 'group', 'sort']);
    expect(rows.find((r) => r.title === 'group')?.extra).toBe(
      'rows collapsed into groups, in a temporary table',
    );
  });

  it('does not call a pass blocking when an index already ordered it', () => {
    // using_filesort false and no temporary table means the index came
    // back grouped. There is nothing to wait for, and no step to draw.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          grouping_operation: {
            using_temporary_table: false,
            using_filesort: false,
            table: { table_name: 'p', access_type: 'ref', key: 'IDX_CLIENT', rows: 40000 },
          },
        },
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(['p']);
  });

  it('sizes a pass from the join, not from a subquery hanging off it', () => {
    // The multiplier used to be read off the last row pushed, which after a
    // join element carrying a subquery is the SUBQUERY's row. On a real
    // plan that turned a join producing 143 rows into one producing
    // 594,737, and every step after it inherited the error.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          duplicates_removal: {
            using_temporary_table: true,
            using_filesort: false,
            nested_loop: [
              { table: { table_name: 'p', access_type: 'ref', key: 'K', rows: 28616, filtered: 0.5 } },
              {
                table: {
                  table_name: 'act',
                  access_type: 'eq_ref',
                  key: '<auto_distinct_key>',
                  rows: 1,
                  filtered: 100,
                  materialized_from_subquery: {
                    query_block: {
                      table: { table_name: 'workflow_activation', access_type: 'ALL', rows: 26443 },
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    );
    expect(rows.find((r) => r.stage === 'distinct')?.rows).toBe(143);
  });

  it('does not charge a materialized subquery the driving step\'s repeat count', () => {
    // It is built ONCE and probed many times — which is what `materialized`
    // has always meant, and the loop multiplier overwrote it anyway,
    // reporting a table read once as read 143 times.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          nested_loop: [
            { table: { table_name: 'p', access_type: 'ref', key: 'K', rows: 28616, filtered: 0.5 } },
            {
              table: {
                table_name: 'act',
                access_type: 'eq_ref',
                key: 'K2',
                rows: 1,
                materialized_from_subquery: {
                  query_block: {
                    table: { table_name: 'workflow_activation', access_type: 'ALL', rows: 26443 },
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(rows.find((r) => r.title === 'act')?.loops).toBe(143);
    expect(rows.find((r) => r.title === 'workflow_activation')?.loops).toBeUndefined();
  });

  it('invents no step for an ordering an index already satisfied', () => {
    // using_filesort false means the index came back in order. There is no
    // work here to draw, and drawing one would invent a cost.
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: {
          ordering_operation: {
            using_filesort: false,
            table: { table_name: 'p', access_type: 'ref', key: 'IDX_CDATE', rows: 12, filtered: 100 },
          },
        },
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(['p']);
  });

  it('marks a covering index as covering', () => {
    const pw = parsePlan('mysql', 'json', mariadb).find((r) => r.title === 'pw');
    expect(pw?.covering).toBe(true);
  });

  it('leaves a plan with no such work exactly as it was', () => {
    const rows = parsePlan(
      'mysql',
      'json',
      JSON.stringify({
        query_block: { table: { table_name: 'p', access_type: 'const', key: 'PRIMARY', rows: 1 } },
      }),
    );
    expect(rows).toEqual([{ depth: 0, title: 'p', access: 'const', key: 'PRIMARY', rows: 1, warn: undefined }]);
  });
});
