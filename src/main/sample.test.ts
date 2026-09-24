import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSample } from './sample';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-sample-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function read<T>(file: string, sql: string): T[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const columns = (file: string, table: string) =>
  read<{ name: string }>(file, `PRAGMA table_info(${table})`).map((c) => c.name);
const indexes = (file: string) =>
  read<{ name: string }>(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").map(
    (r) => r.name,
  );

describe('createSample', () => {
  it('builds three copies that drift the way the welcome screen says they do', () => {
    const files = createSample(dir);

    // local is ahead: a column and a table still in review.
    expect(columns(files.local, 'customers')).toContain('loyalty_tier');
    expect(columns(files.prod, 'customers')).not.toContain('loyalty_tier');
    expect(read(files.local, "SELECT name FROM sqlite_master WHERE name = 'coupons'")).toHaveLength(1);
    expect(read(files.prod, "SELECT name FROM sqlite_master WHERE name = 'coupons'")).toHaveLength(0);

    // staging is behind: a missing index and an old price.
    expect(indexes(files.prod)).toContain('idx_orders_created_at');
    expect(indexes(files.staging)).not.toContain('idx_orders_created_at');
    const lamp = (f: string) =>
      read<{ price_cents: number }>(f, "SELECT price_cents FROM products WHERE sku = 'LAMP-05'")[0].price_cents;
    expect(lamp(files.staging)).not.toBe(lamp(files.prod));
  });

  it('is the same on every run, and replaces an earlier copy rather than adding to it', () => {
    const count = (f: string) => read<{ n: number }>(f, 'SELECT count(*) AS n FROM orders')[0].n;
    const total = (f: string) => read<{ t: number }>(f, 'SELECT sum(total_cents) AS t FROM orders')[0].t;

    const first = createSample(dir);
    const before = { n: count(first.prod), t: total(first.prod) };
    const second = createSample(dir);
    expect({ n: count(second.prod), t: total(second.prod) }).toEqual(before);
    expect(before.n).toBe(1000);
  });

  it('keeps every order total equal to its lines', () => {
    const files = createSample(dir);
    const off = read(
      files.prod,
      `SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id
       GROUP BY o.id HAVING sum(i.quantity * i.price_cents) <> o.total_cents`,
    );
    expect(off).toEqual([]);
  });
});
