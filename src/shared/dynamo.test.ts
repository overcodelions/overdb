import { describe, expect, it } from 'vitest';
import {
  analyzePartiql,
  buildQuery,
  keyAttributes,
  literal,
  attributeValue,
  buildItemUpdate,
  dynamoEditTarget,
  filterSql,
  resolveTarget,
  withPartiqlCondition,
  explainDynamoError,
  orderByProblem,
  prepareStatement,
  equalityAttributes,
  parseTarget,
  statementKind,
  type DynamoTableShape,
} from './dynamo';

const orders: DynamoTableShape = {
  name: 'orders',
  keys: { partitionKey: 'customer_id', sortKey: 'created_at' },
  itemCount: 12_400_000,
  sizeBytes: 43_000_000_000,
  indexes: [
    {
      name: 'by_status',
      keys: { partitionKey: 'status', sortKey: 'created_at' },
      type: 'gsi',
      projection: 'ALL',
    },
    {
      name: 'by_email',
      keys: { partitionKey: 'email' },
      type: 'gsi',
      projection: 'KEYS_ONLY',
    },
  ],
};

describe('parseTarget', () => {
  it('reads a quoted table and index', () => {
    expect(parseTarget('SELECT * FROM "orders"."by_status" WHERE status = \'open\'')).toEqual({
      table: 'orders',
      index: 'by_status',
    });
  });

  it('reads a bare table name', () => {
    expect(parseTarget('SELECT * FROM orders WHERE x = 1')).toEqual({
      table: 'orders',
      index: null,
    });
  });

  it('reads a quoted table with no index', () => {
    expect(parseTarget('SELECT * FROM "orders" WHERE x = 1').index).toBeNull();
  });
});

describe('statementKind', () => {
  it('sees past a leading comment', () => {
    expect(statementKind('-- find them\nSELECT * FROM "orders"')).toBe('select');
  });

  it('names writes', () => {
    expect(statementKind("UPDATE \"orders\" SET x = 1 WHERE customer_id = 'c'")).toBe('update');
    expect(statementKind('DELETE FROM "orders" WHERE customer_id = \'c\'')).toBe('delete');
  });
});

describe('equalityAttributes', () => {
  it('collects top-level equality conditions', () => {
    expect([...equalityAttributes("SELECT * FROM \"o\" WHERE a = 'x' AND b = 2")]).toEqual([
      'a',
      'b',
    ]);
  });

  it('ignores non-equality operators, which cannot answer a partition key', () => {
    expect([...equalityAttributes('SELECT * FROM "o" WHERE a > 1')]).toEqual([]);
  });

  it('refuses everything under an OR, which cannot come from one partition', () => {
    expect([...equalityAttributes("SELECT * FROM \"o\" WHERE a = 'x' OR b = 'y'")]).toEqual([]);
  });
});

describe('analyzePartiql', () => {
  it('calls an exact partition-key match a key lookup', () => {
    const a = analyzePartiql(
      "SELECT * FROM \"orders\" WHERE customer_id = 'c-1'",
      orders,
    );
    expect(a.path).toBe('query');
    expect(a.partitionKeyMatched).toBe('customer_id');
    expect(a.warnings).toEqual([]);
  });

  it('reports the sort-key condition that narrows a lookup', () => {
    const a = analyzePartiql(
      "SELECT * FROM \"orders\" WHERE customer_id = 'c-1' AND created_at > '2026-01-01'",
      orders,
    );
    expect(a.path).toBe('query');
    expect(a.sortKeyCondition).toBeTruthy();
  });

  it('a sort key alone is not a lookup — no partition key, no query', () => {
    const a = analyzePartiql(
      "SELECT * FROM \"orders\" WHERE created_at > '2026-01-01'",
      orders,
    );
    expect(a.path).toBe('scan');
  });

  it('names the index that would turn a scan into a lookup', () => {
    // The expensive mistake: this reads exactly like SQL a planner would
    // optimise, and PartiQL will not choose the index.
    const a = analyzePartiql("SELECT * FROM \"orders\" WHERE status = 'open'", orders);
    expect(a.path).toBe('scan');
    expect(a.suggestion?.index).toBe('by_status');
    expect(a.warnings[0].level).toBe('high');
    expect(a.warnings[0].text).toContain('12,400,000 items');
    expect(a.warnings[0].text).toContain('40 GB');
  });

  it('is satisfied once the index is named', () => {
    const a = analyzePartiql(
      "SELECT * FROM \"orders\".\"by_status\" WHERE status = 'open'",
      orders,
    );
    expect(a.path).toBe('query');
    expect(a.index).toBe('by_status');
    expect(a.suggestion).toBeUndefined();
  });

  it('warns that SELECT * on a KEYS_ONLY index doubles the reads', () => {
    const a = analyzePartiql(
      "SELECT * FROM \"orders\".\"by_email\" WHERE email = 'a@b.c'",
      orders,
    );
    expect(a.path).toBe('query');
    expect(a.warnings.some((w) => w.text.includes('KEYS_ONLY'))).toBe(true);
  });

  it('says plainly when the named index does not exist', () => {
    const a = analyzePartiql('SELECT * FROM "orders"."nope" WHERE status = \'open\'', orders);
    expect(a.warnings[0].text).toContain('no index called nope');
  });

  it('says the row cap bounds a scan, and says nothing of the sort on a lookup', () => {
    // PartiQL has no LIMIT clause, so telling anyone to add one was advice
    // that produced "Unsupported clause: LIMIT". The bound is the tab's row
    // cap, sent as the request's Limit.
    const scan = analyzePartiql('SELECT * FROM "orders" WHERE note = \'x\'', orders);
    expect(scan.warnings.some((w) => w.text.includes('row cap'))).toBe(true);
    expect(scan.warnings.some((w) => /\bLIMIT\b/.test(w.text))).toBe(false);
    const lookup = analyzePartiql("SELECT * FROM \"orders\" WHERE customer_id = 'c'", orders);
    expect(lookup.warnings.some((w) => w.text.includes('row cap'))).toBe(false);
  });

  it('classifies writes without pretending they have an access path', () => {
    const a = analyzePartiql("DELETE FROM \"orders\" WHERE customer_id = 'c'", orders);
    expect(a.kind).toBe('delete');
    expect(a.path).toBe('write');
  });

  it('says so rather than guessing when the table is undescribed', () => {
    const a = analyzePartiql('SELECT * FROM "unknown_table"', undefined);
    expect(a.path).toBe('unknown');
    expect(a.warnings[0].text).toContain('unknown_table');
  });
});

describe('prepareStatement', () => {
  it('lifts a written LIMIT into the request', () => {
    // PartiQL has no LIMIT clause at all: sending this verbatim is how you
    // get "Unsupported clause: LIMIT at 5:7:3".
    const p = prepareStatement('SELECT * FROM "orders"\nLIMIT 100;');
    expect(p.statement).toBe('SELECT * FROM "orders"');
    expect(p.limit).toBe(100);
    expect(p.note).toContain('LIMIT 100');
  });

  it('leaves a statement without one alone, semicolon aside', () => {
    const p = prepareStatement('  SELECT * FROM "orders" WHERE customer_id = \'c\';  ');
    expect(p.statement).toBe('SELECT * FROM "orders" WHERE customer_id = \'c\'');
    expect(p.limit).toBeNull();
    expect(p.note).toBeNull();
  });

  it('does not mistake an attribute called limit for the clause', () => {
    const p = prepareStatement('SELECT "limit" FROM "orders"');
    expect(p.limit).toBeNull();
  });
});

describe('orderByProblem', () => {
  it('rejects ordering by an attribute that is nobody\'s sort key', () => {
    const problem = orderByProblem('SELECT * FROM "orders" ORDER BY note DESC', orders);
    expect(problem).toContain('created_at');
    expect(problem).toContain('note');
  });

  it('points at the index that IS sorted that way', () => {
    const problem = orderByProblem(
      'SELECT * FROM "orders"."by_email" WHERE email = \'a@b\' ORDER BY created_at DESC',
      orders,
    );
    // by_email has no sort key; by_status is sorted by created_at.
    expect(problem).toContain('by_status');
  });

  it('says a scan cannot be ordered even by the right attribute', () => {
    const problem = orderByProblem('SELECT * FROM "orders" ORDER BY created_at DESC', orders);
    expect(problem).toContain('customer_id');
  });

  it('accepts the one case DynamoDB allows', () => {
    expect(
      orderByProblem(
        "SELECT * FROM \"orders\" WHERE customer_id = 'c' ORDER BY created_at DESC",
        orders,
      ),
    ).toBeNull();
  });

  it('says nothing about a table it has never described', () => {
    expect(orderByProblem('SELECT * FROM "orders" ORDER BY note DESC', undefined)).toBeNull();
  });
});

describe('explainDynamoError', () => {
  it('adds the rule to an unsupported ORDER BY', () => {
    const out = explainDynamoError('Unsupported clause: ORDER BY at 4:1:1');
    expect(out).toContain('Unsupported clause: ORDER BY at 4:1:1');
    expect(out).toContain('sort key');
  });

  it('leaves an error it has nothing to add to exactly as it was', () => {
    expect(explainDynamoError('Requested resource not found')).toBe('Requested resource not found');
  });
});

const shape = orders; // clientId-style: customer_id / created_at, +by_status, +by_email

describe('resolveTarget', () => {
  it('uses the table when its own partition key is pinned', () => {
    const r = resolveTarget(shape, [{ attribute: 'customer_id', op: '=', value: 'c-1' }]);
    expect(r.index).toBeNull();
    expect(r.path).toBe('query');
    expect(r.why).toContain("table's partition key");
  });

  it('finds the index that makes the condition a lookup', () => {
    // The whole point: the user named an attribute, not an index.
    const r = resolveTarget(shape, [{ attribute: 'status', op: '=', value: 'open' }]);
    expect(r.index).toBe('by_status');
    expect(r.path).toBe('query');
    expect(r.why).toContain('by_status');
  });

  it('prefers the path whose sort key is also named', () => {
    const r = resolveTarget(shape, [
      { attribute: 'status', op: '=', value: 'open' },
      { attribute: 'created_at', op: '>=', value: '2024-01-01' },
    ]);
    expect(r.index).toBe('by_status');
    expect(r.sort?.attribute).toBe('created_at');
  });

  it('treats everything it could not use as a post-read filter', () => {
    const r = resolveTarget(shape, [
      { attribute: 'customer_id', op: '=', value: 'c-1' },
      { attribute: 'note', op: '=', value: 'urgent' },
    ]);
    expect(r.filters.map((f) => f.attribute)).toEqual(['note']);
  });

  it('says which operator broke it when a partition key is compared loosely', () => {
    const r = resolveTarget(shape, [{ attribute: 'status', op: '>', value: 'a' }]);
    expect(r.path).toBe('scan');
    expect(r.why).toContain('exact match');
  });

  it('names the keys that would help when nothing matches', () => {
    const r = resolveTarget(shape, [{ attribute: 'note', op: '=', value: 'x' }]);
    expect(r.path).toBe('scan');
    expect(r.why).toContain('customer_id');
  });

  it('ignores a condition with no value yet, so typing does not thrash', () => {
    const r = resolveTarget(shape, [{ attribute: 'status', op: '=', value: '   ' }]);
    expect(r.path).toBe('scan');
  });

  it('lets the user override the choice, table included', () => {
    const conds = [{ attribute: 'status', op: '=' as const, value: 'open' }];
    expect(resolveTarget(shape, conds, 'by_email').index).toBe('by_email');
    expect(resolveTarget(shape, conds, 'by_email').path).toBe('scan');
    expect(resolveTarget(shape, conds, null).index).toBeNull();
  });

  it('offers every path, table first', () => {
    const r = resolveTarget(shape, []);
    expect(r.paths.map((p) => p.index)).toEqual([null, 'by_status', 'by_email']);
  });
});

describe('buildQuery', () => {
  it('names the chosen index in FROM and writes the key conditions', () => {
    const { sql } = buildQuery(shape, {
      conditions: [
        { attribute: 'status', op: '=', value: 'open' },
        { attribute: 'created_at', op: '>=', value: '2024-01-01' },
      ],
      newestFirst: true,
    });
    expect(sql).toBe(
      'SELECT * FROM "orders"."by_status"\n' +
        'WHERE "status" = \'open\'\n' +
        '  AND "created_at" >= \'2024-01-01\'\n' +
        'ORDER BY "created_at" DESC;',
    );
  });

  it('writes a bare scan when nothing pins a partition, and no ORDER BY', () => {
    // ORDER BY on a scan is rejected outright, so writing one would produce a
    // statement that cannot run rather than a slow one.
    const { sql } = buildQuery(shape, { newestFirst: true });
    expect(sql).toBe('SELECT * FROM "orders";');
  });

  it('writes BETWEEN when an upper bound is given', () => {
    const { sql } = buildQuery(shape, {
      conditions: [
        { attribute: 'customer_id', op: '=', value: 'c-1' },
        { attribute: 'created_at', op: '>=', value: '2024-01-01', upper: '2024-02-01' },
      ],
    });
    expect(sql).toContain('"created_at" BETWEEN \'2024-01-01\' AND \'2024-02-01\'');
  });

  it('writes begins_with as the function it is', () => {
    const { sql } = buildQuery(shape, {
      conditions: [
        { attribute: 'customer_id', op: '=', value: 'c-1' },
        { attribute: 'created_at', op: 'begins_with', value: '2024-' },
      ],
    });
    expect(sql).toContain('begins_with("created_at", \'2024-\')');
  });

  it('keeps a non-key filter, which costs nothing to add and saves no reads', () => {
    const { sql } = buildQuery(shape, {
      conditions: [
        { attribute: 'customer_id', op: '=', value: 'c-1' },
        { attribute: 'note', op: '=', value: 'urgent' },
      ],
    });
    expect(sql).toContain('"note" = \'urgent\'');
  });

  it('quotes what needs quoting and leaves numbers alone', () => {
    expect(literal('42')).toBe('42');
    expect(literal('-1.5')).toBe('-1.5');
    expect(literal("o'brien")).toBe("'o''brien'");
    expect(literal('2024-01-01')).toBe("'2024-01-01'");
  });

  it('produces statements its own analyzer agrees with', () => {
    // The two halves of this module have to agree: a statement the builder
    // presents as a lookup must not light up the scan warning in the bar,
    // and its ORDER BY must survive the check that rejected the last one.
    const { sql } = buildQuery(shape, {
      conditions: [{ attribute: 'status', op: '=', value: 'open' }],
      newestFirst: true,
    });
    expect(analyzePartiql(sql, shape).path).toBe('query');
    expect(orderByProblem(sql, shape)).toBeNull();
  });
});

describe('keyAttributes', () => {
  it('lists every key attribute once, saying what each one is', () => {
    expect(keyAttributes(shape)).toEqual([
      { name: 'customer_id', role: 'table partition key', partition: true },
      { name: 'created_at', role: 'table sort key', partition: false },
      { name: 'status', role: 'by_status partition key', partition: true },
      { name: 'email', role: 'by_email partition key', partition: true },
    ]);
  });
});

describe('withPartiqlCondition', () => {
  it('adds a WHERE to a statement that has none', () => {
    expect(
      withPartiqlCondition('SELECT * FROM "orders";', {
        attribute: 'status',
        op: '=',
        value: 'open',
      }),
    ).toBe('SELECT * FROM "orders"\nWHERE "status" = \'open\';');
  });

  it('keeps ORDER BY last, where PartiQL requires it', () => {
    expect(
      withPartiqlCondition(
        'SELECT * FROM "orders"."by_status"\nWHERE "status" = \'open\'\nORDER BY "created_at" DESC;',
        { attribute: 'note', op: '=', value: 'urgent' },
      ),
    ).toBe(
      'SELECT * FROM "orders"."by_status"\n' +
        'WHERE "status" = \'open\'\n' +
        '  AND "note" = \'urgent\'\n' +
        'ORDER BY "created_at" DESC;',
    );
  });

  it('replaces an existing condition on the same attribute', () => {
    // Otherwise changing a filter ANDs a contradiction onto the old one and
    // the grid goes empty for no visible reason.
    const once = withPartiqlCondition('SELECT * FROM "orders";', {
      attribute: 'status',
      op: '=',
      value: 'open',
    });
    expect(
      withPartiqlCondition(once, { attribute: 'status', op: '=', value: 'closed' }),
    ).toBe('SELECT * FROM "orders"\nWHERE "status" = \'closed\';');
  });

  it('removes a condition when the filter is cleared', () => {
    const once = 'SELECT * FROM "orders"\nWHERE "status" = \'open\';';
    expect(withPartiqlCondition(once, null, 'status')).toBe('SELECT * FROM "orders";');
  });

  it('leaves an OR clause whole rather than half-understanding it', () => {
    const or = 'SELECT * FROM "orders" WHERE "a" = 1 OR "b" = 2;';
    const out = withPartiqlCondition(or, { attribute: 'note', op: '=', value: 'x' });
    expect(out).toContain('"a" = 1 OR "b" = 2');
    expect(out).toContain('AND "note" = \'x\'');
  });

  it('produces a statement the analyzer still understands', () => {
    const out = withPartiqlCondition('SELECT * FROM "orders";', {
      attribute: 'customer_id',
      op: '=',
      value: 'c-1',
    });
    expect(analyzePartiql(out, orders).path).toBe('query');
  });
});

describe('filterSql', () => {
  it('uses PartiQL spellings, not SQL ones', () => {
    // <> rather than !=, and IS MISSING rather than IS NULL: on DynamoDB an
    // attribute is usually absent from the item, not present and null.
    expect(filterSql({ attribute: 'note', op: '!=', value: 'x' })).toBe('"note" <> \'x\'');
    expect(filterSql({ attribute: 'note', op: 'is null' })).toBe('"note" IS MISSING');
    expect(filterSql({ attribute: 'note', op: 'contains', value: 'urgent' })).toBe(
      'contains("note", \'urgent\')',
    );
    expect(filterSql({ attribute: 'note', op: 'starts', value: 'ur' })).toBe(
      'begins_with("note", \'ur\')',
    );
  });
});

describe('dynamoEditTarget', () => {
  const columns = [
    { name: 'customer_id' },
    { name: 'created_at' },
    { name: 'note' },
  ];

  it('accepts a non-key attribute when the full key is in the result', () => {
    const check = dynamoEditTarget(columns, 'SELECT * FROM "orders"', orders, 2);
    expect(check).toEqual({
      ok: true,
      target: {
        table: 'orders',
        attribute: 'note',
        keys: [
          { attribute: 'customer_id', index: 0 },
          { attribute: 'created_at', index: 1 },
        ],
      },
    });
  });

  it('refuses when the sort key was projected away', () => {
    const check = dynamoEditTarget(
      [{ name: 'customer_id' }, { name: 'note' }],
      'SELECT * FROM "orders"',
      orders,
      1,
    );
    expect(check.ok === false && check.reason).toContain('created_at');
  });

  it('refuses to change a key, which would be a different item', () => {
    const check = dynamoEditTarget(columns, 'SELECT * FROM "orders"', orders, 0);
    expect(check.ok === false && check.reason).toContain('different item');
  });

  it('refuses rows that came from an index', () => {
    const check = dynamoEditTarget(columns, 'SELECT * FROM "orders"."by_status"', orders, 2);
    expect(check.ok === false && check.reason).toContain('by_status');
  });
});

describe('attributeValue', () => {
  it('keeps a number a number and a string a string', () => {
    // `1` and `'1'` are different values under the same key on DynamoDB, and
    // writing the wrong one silently stores the wrong type.
    expect(attributeValue({ text: '1', kind: 'decimal' })).toEqual({ N: '1' });
    expect(attributeValue({ text: '1', kind: 'text' })).toEqual({ S: '1' });
    expect(attributeValue({ text: 'true', kind: 'bool' })).toEqual({ BOOL: true });
    expect(attributeValue({ text: null, kind: 'text' })).toEqual({ NULL: true });
  });

  it('does not send a word as a number', () => {
    expect(attributeValue({ text: 'abc', kind: 'decimal' })).toEqual({ S: 'abc' });
  });
});

describe('buildItemUpdate', () => {
  it('addresses the item by its whole key, with values as parameters', () => {
    const target = {
      table: 'orders',
      attribute: 'note',
      keys: [
        { attribute: 'customer_id', index: 0 },
        { attribute: 'created_at', index: 1 },
      ],
    };
    const out = buildItemUpdate(target, { text: 'urgent', kind: 'text' }, [
      { text: 'c-1', kind: 'text' },
      { text: '2024-01-01', kind: 'text' },
    ]);
    expect(out.sql).toBe(
      'UPDATE "orders" SET "note" = ? WHERE "customer_id" = ? AND "created_at" = ?',
    );
    expect(out.params).toEqual([{ S: 'urgent' }, { S: 'c-1' }, { S: '2024-01-01' }]);
    expect(out.preview).toBe(
      "UPDATE \"orders\" SET \"note\" = 'urgent' WHERE \"customer_id\" = 'c-1' AND \"created_at\" = '2024-01-01'",
    );
  });
});
