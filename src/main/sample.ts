// The sample: one small shop database in three environments.
//
// A first run with nothing to point at is a form asking for a host and a
// password, and the thing overdb is actually FOR — the same query across
// local, staging and prod, and what drifted between them — cannot be seen
// until someone has set up three connections and an environment set. The
// sample is that setup, already done, on files that never leave the machine.
//
// The three copies differ the way real ones do, so every comparison has
// something to find:
//   - prod is the baseline and the largest
//   - staging is behind: it never got the index on orders.created_at, and a
//     price change has not reached it
//   - local is ahead: a `loyalty_tier` column and a `coupons` table that are
//     still in review
//
// Deterministic, so the drift and the counts are the same on every machine
// and a screenshot in an issue means the same thing to whoever reads it.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SAMPLE_ENVS, sampleFileName, type SampleEnv } from '../shared/sample';

/// How much of the shop each copy holds. Small enough to build in well under
/// a second, big enough that a GROUP BY says something.
const SIZE: Record<SampleEnv, { customers: number; orders: number }> = {
  local: { customers: 12, orders: 40 },
  staging: { customers: 60, orders: 250 },
  prod: { customers: 200, orders: 1000 },
};

const PREFIX = ['Blue', 'North', 'Oak', 'Pine', 'River', 'Stone', 'Sun', 'Harbor', 'Maple', 'Copper'];
const SUFFIX = ['Bakery', 'Books', 'Cycles', 'Garden', 'Labs', 'Outfitters', 'Studio', 'Supply'];
const REGIONS = ['EU', 'NA', 'APAC'];
const STATUSES = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'pending', 'refunded'];

const PRODUCTS: Array<[sku: string, name: string, cents: number]> = [
  ['MUG-01', 'Enamel mug', 1800],
  ['TOTE-02', 'Canvas tote', 2400],
  ['NOTE-03', 'Dot-grid notebook', 1200],
  ['PEN-04', 'Brass pen', 4500],
  ['LAMP-05', 'Desk lamp', 8900],
  ['PLANT-06', 'Snake plant', 3200],
  ['CLOCK-07', 'Wall clock', 5600],
  ['RUG-08', 'Wool rug', 21000],
];

/// Where the files live, named so a glance at the folder says what they are.
export function sampleFile(dir: string, env: SampleEnv): string {
  return path.join(dir, sampleFileName(env));
}

/// Build all three copies, replacing any from an earlier run. Returns the
/// path of each.
export function createSample(dir: string): Record<SampleEnv, string> {
  fs.mkdirSync(dir, { recursive: true });
  const out = {} as Record<SampleEnv, string>;
  for (const env of SAMPLE_ENVS) {
    const file = sampleFile(dir, env);
    for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      fs.rmSync(f, { force: true });
    }
    build(file, env);
    out[env] = file;
  }
  return out;
}

function build(file: string, env: SampleEnv): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        region TEXT NOT NULL,
        created_at TEXT NOT NULL${env === 'local' ? ",\n        loyalty_tier TEXT NOT NULL DEFAULT 'none'" : ''}
      );
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        price_cents INTEGER NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        status TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE order_items (
        order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        PRIMARY KEY (order_id, product_id)
      );
      CREATE INDEX idx_orders_customer ON orders(customer_id);
    `);
    if (env !== 'staging') db.exec('CREATE INDEX idx_orders_created_at ON orders(created_at);');
    if (env === 'local') {
      db.exec(`
        CREATE TABLE coupons (
          code TEXT PRIMARY KEY,
          percent_off INTEGER NOT NULL,
          expires_at TEXT
        );
        INSERT INTO coupons VALUES ('WELCOME10', 10, NULL), ('SPRING25', 25, '2026-06-01');
      `);
    }

    const rand = prng(env === 'local' ? 7 : env === 'staging' ? 11 : 13);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const day = (offset: number) =>
      new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

    db.exec('BEGIN');
    const addProduct = db.prepare('INSERT INTO products (id, sku, name, price_cents) VALUES (?, ?, ?, ?)');
    PRODUCTS.forEach(([sku, name, cents], i) => {
      // The price change that has reached prod and local but not staging.
      const price = sku === 'LAMP-05' && env === 'staging' ? 7900 : cents;
      addProduct.run(i + 1, sku, name, price);
    });

    const { customers, orders } = SIZE[env];
    const addCustomer = db.prepare(
      env === 'local'
        ? 'INSERT INTO customers (id, name, email, region, created_at, loyalty_tier) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO customers (id, name, email, region, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (let id = 1; id <= customers; id++) {
      const name = `${PREFIX[(id - 1) % PREFIX.length]} ${SUFFIX[Math.floor((id - 1) / PREFIX.length) % SUFFIX.length]}`;
      const email = `hello+${id}@${name.toLowerCase().replace(/\s+/g, '')}.example`;
      const args: Array<string | number> = [id, name, email, pick(REGIONS), day(Math.floor(rand() * 120))];
      if (env === 'local') args.push(pick(['none', 'none', 'silver', 'gold']));
      addCustomer.run(...args);
    }

    const addOrder = db.prepare(
      'INSERT INTO orders (id, customer_id, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const addItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES (?, ?, ?, ?)',
    );
    const priceOf = db.prepare('SELECT price_cents FROM products WHERE id = ?');
    for (let id = 1; id <= orders; id++) {
      const lines = 1 + Math.floor(rand() * 3);
      const chosen = new Set<number>();
      while (chosen.size < lines) chosen.add(1 + Math.floor(rand() * PRODUCTS.length));
      let total = 0;
      const items: Array<[number, number, number]> = [];
      for (const productId of chosen) {
        const qty = 1 + Math.floor(rand() * 3);
        const cents = Number((priceOf.get(productId) as { price_cents: number }).price_cents);
        total += qty * cents;
        items.push([productId, qty, cents]);
      }
      addOrder.run(id, 1 + Math.floor(rand() * customers), pick(STATUSES), total, day(30 + Math.floor(rand() * 240)));
      for (const [productId, qty, cents] of items) addItem.run(id, productId, qty, cents);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/// mulberry32: a few lines, no dependency, and the same sequence everywhere.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
