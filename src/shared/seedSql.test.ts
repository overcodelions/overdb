import { describe, expect, it } from 'vitest';

import type { SchemaSnapshot, TableInfo } from './types';
import {
  bareTicketKey,
  checkSeedScript,
  countTuples,
  insertOrder,
  parseInvestigation,
  parseScript,
  seedIdStart,
} from './seedSql';

function table(name: string, columns: string[], parents: string[] = []): TableInfo {
  return {
    name,
    kind: 'table',
    columns: columns.map((c, i) => ({ name: c, ordinal: i, typeName: 'text', nullable: true, defaultExpr: null })),
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: parents.map((p) => ({ name: `${name}_${p}`, columns: [`${p}_id`], refSchema: null, refTable: p, refColumns: ['id'] })),
  };
}

const customers = table('customers', ['id', 'name', 'email', 'loyalty_tier']);
const orders = table('orders', ['id', 'customer_id', 'status', 'total_cents'], ['customers']);
const items = table('order_items', ['order_id', 'product_id', 'quantity'], ['orders', 'products']);
const products = table('products', ['id', 'sku', 'price_cents']);

const snapshot: SchemaSnapshot = {
  engine: 'sqlite',
  serverVersion: '3.45',
  capturedAt: '2026-09-28',
  schemas: [{ name: 'main', tables: [customers, orders, items, products] }],
};

const SEED = `-- SHOP-418
INSERT INTO customers (id, name, email, loyalty_tier) VALUES
  (900001, 'Gia (Gold)', 'gia@seed.overdb.test', 'gold'),
  (900002, 'Sam O''Silver', 'sam@seed.overdb.test', 'silver');
INSERT INTO orders (id, customer_id, status, total_cents) VALUES (900001, 900001, 'paid', 5000);
INSERT INTO order_items (order_id, product_id, quantity) VALUES (900001, 1, 2);`;

const TEARDOWN = `DELETE FROM order_items WHERE order_id >= 900001;
DELETE FROM orders WHERE id >= 900001;
DELETE FROM customers WHERE email LIKE '%@seed.overdb.test';`;

const VERIFY = `SELECT o.id, c.loyalty_tier FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id >= 900001`;

describe('parseInvestigation', () => {
  const answer = `Here is what I found.
\`\`\`json
{"findings":[{"source":"code","text":"Tier is none, silver or gold","ref":"src/tier.ts:4"},{"source":"schema","text":"email is unique"}],
 "plan":{"summary":"Three customers","groups":[{"table":"customers","rows":[{"label":"Gia Gold","detail":"gold"}]}],
 "assumptions":["paid is enough"],"note":"Reuses 2 products"},
 "marker":"ids from 900001"}
\`\`\``;

  it('reads the fenced JSON around prose', () => {
    const r = parseInvestigation(answer);
    if ('error' in r) throw new Error(r.error);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toEqual({ source: 'code', text: 'Tier is none, silver or gold', ref: 'src/tier.ts:4' });
    expect(r.plan.groups[0].rows[0]).toEqual({ label: 'Gia Gold', detail: 'gold' });
    expect(r.plan.assumptions).toEqual(['paid is enough']);
    expect(r.marker).toBe('ids from 900001');
  });

  it('refuses a plan with nothing to insert, or no JSON at all', () => {
    expect(parseInvestigation('{"plan":{"groups":[]}}')).toHaveProperty('error');
    expect(parseInvestigation('I could not find the schema.')).toHaveProperty('error');
    expect(parseInvestigation('```json\n{not json}\n```')).toHaveProperty('error');
  });
});

describe('parseScript', () => {
  it('finds the three blocks by label', () => {
    const r = parseScript(`\`\`\`sql verify\n${VERIFY}\n\`\`\`\n\`\`\`sql seed\n${SEED}\n\`\`\`\n\`\`\`sql teardown\n${TEARDOWN}\n\`\`\``);
    if ('error' in r) throw new Error(r.error);
    expect(r.seed).toContain('INSERT INTO customers');
    expect(r.teardown.startsWith('DELETE')).toBe(true);
    expect(r.verify.startsWith('SELECT')).toBe(true);
  });

  it('falls back to order when the labels are missing', () => {
    const r = parseScript(`\`\`\`sql\n${SEED}\n\`\`\`\n\`\`\`sql\n${TEARDOWN}\n\`\`\`\n\`\`\`sql\n${VERIFY}\n\`\`\``);
    expect('error' in r ? r.error : r.teardown).toContain('DELETE FROM order_items');
  });

  it('says what is missing', () => {
    expect(parseScript('```sql seed\nINSERT INTO t VALUES (1);\n```')).toEqual({
      error: 'The model did not return a teardown script.',
    });
  });
});

describe('countTuples', () => {
  it('counts top-level groups, ignoring parentheses inside strings and calls', () => {
    expect(countTuples(`(1, 'a (b)'), (2, lower('X')), (3, 'it''s')`)).toBe(3);
    expect(countTuples(`(1, 'a\\'b)')`)).toBe(1);
  });
});

describe('checkSeedScript', () => {
  it('passes a well-formed script and counts rows per table', () => {
    const r = checkSeedScript({ seed: SEED, teardown: TEARDOWN, verify: VERIFY }, snapshot, 'sqlite');
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.perTable).toEqual([
      { table: 'customers', rows: 2 },
      { table: 'orders', rows: 1 },
      { table: 'order_items', rows: 1 },
    ]);
    expect(r.deletes).toHaveLength(3);
    expect(r.verify).toBe(VERIFY);
  });

  it('refuses anything in the seed that is not an INSERT', () => {
    const r = checkSeedScript({ seed: `${SEED}\nUPDATE customers SET name = 'x';`, teardown: TEARDOWN, verify: '' }, snapshot, 'sqlite');
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Only INSERT/);
  });

  it('refuses an upsert that would overwrite existing rows', () => {
    const seed = `INSERT INTO customers (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = excluded.name;`;
    expect(checkSeedScript({ seed, teardown: TEARDOWN, verify: '' }, snapshot, 'sqlite').problems[0]).toMatch(/updates existing rows/);
  });

  it('names unknown tables and columns', () => {
    const seed = `INSERT INTO customers (id, nickname) VALUES (1, 'x'); INSERT INTO coupons (code) VALUES ('A');`;
    const r = checkSeedScript({ seed, teardown: TEARDOWN, verify: '' }, snapshot, 'sqlite');
    expect(r.problems).toEqual(['customers has no column nickname.', 'There is no table coupons.']);
  });

  it('catches a child inserted before its parent', () => {
    const seed = `INSERT INTO orders (id, customer_id) VALUES (1, 1); INSERT INTO customers (id) VALUES (1);`;
    expect(checkSeedScript({ seed, teardown: TEARDOWN, verify: '' }, snapshot, 'sqlite').problems).toEqual([
      'orders is inserted before its parent customers.',
    ]);
  });

  it('accepts quoted and schema-qualified names', () => {
    const seed = `INSERT INTO "main"."customers" ("id", "email") VALUES (1, 'a');`;
    expect(checkSeedScript({ seed, teardown: TEARDOWN, verify: '' }, snapshot, 'sqlite').ok).toBe(true);
  });

  it('requires every teardown statement to be a DELETE with a WHERE, children first', () => {
    const unbounded = checkSeedScript({ seed: SEED, teardown: 'DELETE FROM customers;', verify: '' }, snapshot, 'sqlite');
    expect(unbounded.problems).toEqual(['The teardown may only hold DELETE … WHERE statements.']);

    const backwards = `DELETE FROM customers WHERE id >= 900001; DELETE FROM orders WHERE id >= 900001;`;
    expect(checkSeedScript({ seed: SEED, teardown: backwards, verify: '' }, snapshot, 'sqlite').problems).toEqual([
      'The teardown deletes customers before rows that point at it.',
    ]);
  });

  it('only accepts a single read as the verify query', () => {
    const r = checkSeedScript({ seed: SEED, teardown: TEARDOWN, verify: `DELETE FROM orders WHERE id = 1` }, snapshot, 'sqlite');
    expect(r.problems).toEqual(['The verify query must be a single SELECT.']);
    expect(r.verify).toBeNull();
  });
});

describe('insertOrder', () => {
  it('puts parents before children', () => {
    const order = insertOrder([items, orders, customers, products]);
    expect(order.indexOf('customers')).toBeLessThan(order.indexOf('orders'));
    expect(order.indexOf('orders')).toBeLessThan(order.indexOf('order_items'));
    expect(order.indexOf('products')).toBeLessThan(order.indexOf('order_items'));
  });

  it('survives a cycle', () => {
    const a = table('a', ['id'], ['b']);
    const b = table('b', ['id'], ['a']);
    expect(insertOrder([a, b]).sort()).toEqual(['a', 'b']);
  });
});

describe('seedIdStart', () => {
  it('starts at 900001 on a small database', () => {
    expect(seedIdStart([240, null, 12])).toBe(900_001);
    expect(seedIdStart([])).toBe(900_001);
  });

  it('moves above a larger id space to a round number', () => {
    expect(seedIdStart([95_000])).toBe(1_000_001);
    expect(seedIdStart([4_200_000])).toBe(100_000_001);
  });
});

describe('bareTicketKey', () => {
  it('spots a ticket key with nothing to go on', () => {
    expect(bareTicketKey('Review SHOP-418 - help me seed my local db with data')).toBe('SHOP-418');
    expect(bareTicketKey('PROJ-12')).toBe('PROJ-12');
  });

  it('stays quiet when the need says what it wants', () => {
    expect(
      bareTicketKey('SHOP-418 — Gold-tier customers get free shipping on orders of $50.00 or more. Check the boundary at exactly $50.00 and just under it.'),
    ).toBeNull();
    expect(bareTicketKey('three customers, one on each loyalty tier')).toBeNull();
  });
});
