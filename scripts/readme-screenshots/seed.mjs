// Builds a fictional sandbox for README screenshots:
//   home/acme/data/*.sqlite   the acme-shop database in local, staging and prod,
//                             drifted apart on purpose, as SQLite files
//   userData/overdb.json      connections, environment sets, editor buffers
//   userData/agents/          an agent that is "connected" and the calls it made
//
// Every network connection here points at a host under `.example`, which
// never resolves, and the capture never opens one: they exist so the sidebar
// shows the engine tiles. Only the SQLite files are ever queried.
//
// Usage: node seed.mjs <workDir> <userDataDir> [dark|light] [agentPid]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [ROOT, USERDATA, THEME = 'dark', AGENT_PID = String(process.ppid)] = process.argv.slice(2);
const HOME = path.join(ROOT, 'home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const realHome = fs.realpathSync(HOME);
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });

// ------------------------------------------------------------- databases

const ENVS = ['local', 'staging', 'prod'];
const SIZE = {
  local: { customers: 18, orders: 60 },
  staging: { customers: 80, orders: 400 },
  prod: { customers: 240, orders: 1600 },
};

const ACCOUNTS = [
  [1, 'Acme Retail', 'retail'],
  [2, 'Acme Internal (test)', 'internal'],
  [3, 'Acme Wholesale', 'wholesale'],
  [4, 'Acme Outlet', 'retail'],
];

const FIRST = ['Ada', 'Bruno', 'Chloe', 'Dmitri', 'Elena', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonah', 'Kemi', 'Liam', 'Mara', 'Noor', 'Otto', 'Priya'];
const LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Novak', 'Haddad', 'Reyes', 'Brandt', 'Sato', 'Costa', 'Ibsen', 'Quinn'];
const REGIONS = ['NA', 'EU', 'APAC', 'LATAM'];
const STATUSES = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'shipped', 'pending', 'refunded'];
const PRODUCTS = [
  ['ANV-100', 'Anvil, 100 lb', 18900],
  ['RKT-SKT', 'Rocket skates', 42500],
  ['MAG-XL', 'Giant magnet', 7900],
  ['SPR-SHO', 'Spring-loaded shoes', 12900],
  ['TNT-12', 'Dehydrated boulders (12)', 3400],
  ['TUN-KIT', 'Instant tunnel kit', 15900],
  ['PNT-HOLE', 'Portable hole', 9900],
  ['EAR-QK', 'Earthquake pills', 2400],
  ['GLU-SUP', 'Super glue, 1 gal', 1800],
  ['KIT-JET', 'Jet-propelled unicycle', 64900],
];

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(file, env) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL,
      created_at TEXT NOT NULL${env === 'local' ? ",\n      loyalty_tier TEXT NOT NULL DEFAULT 'none'" : ''}
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
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
    CREATE TABLE shipments (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      carrier TEXT NOT NULL,
      shipped_at TEXT NOT NULL
    );
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE INDEX idx_customers_account ON customers(account_id);
  `);
  // staging never got this index; local and prod have it.
  if (env !== 'staging') db.exec('CREATE INDEX idx_orders_created_at ON orders(created_at);');
  // local is ahead: a coupons table still in review.
  if (env === 'local') {
    db.exec(`
      CREATE TABLE coupons (
        code TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        percent_off INTEGER NOT NULL,
        expires_at TEXT
      );
    `);
  }

  const rand = prng({ local: 5, staging: 17, prod: 29 }[env]);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const day = (offset) => new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  db.exec('BEGIN');
  const addAccount = db.prepare('INSERT INTO accounts VALUES (?, ?, ?)');
  for (const a of ACCOUNTS) addAccount.run(...a);
  if (env === 'local') db.exec("INSERT INTO coupons VALUES ('WELCOME10', 1, 10, NULL), ('MESA25', 3, 25, '2026-12-31')");
  const addProduct = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?)');
  PRODUCTS.forEach(([sku, name, cents], i) => {
    // A price change that reached prod and local but not staging.
    addProduct.run(i + 1, sku, name, sku === 'RKT-SKT' && env === 'staging' ? 39900 : cents);
  });

  const { customers, orders } = SIZE[env];
  const addCustomer = db.prepare(
    env === 'local'
      ? 'INSERT INTO customers (id, account_id, name, email, region, created_at, loyalty_tier) VALUES (?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO customers (id, account_id, name, email, region, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const customerAccount = [];
  for (let id = 1; id <= customers; id++) {
    const first = FIRST[(id * 7) % FIRST.length];
    const last = LAST[(id * 5) % LAST.length];
    const account = pick([1, 1, 1, 3, 3, 4, 2]);
    customerAccount[id] = account;
    const args = [id, account, `${first} ${last}`, `${first}.${last}${id}@example.com`.toLowerCase(), pick(REGIONS), day(Math.floor(rand() * 150))];
    if (env === 'local') args.push(pick(['none', 'none', 'silver', 'gold']));
    addCustomer.run(...args);
  }

  const addOrder = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?)');
  const addShipment = db.prepare('INSERT INTO shipments (order_id, carrier, shipped_at) VALUES (?, ?, ?)');
  const price = db.prepare('SELECT price_cents FROM products WHERE id = ?');
  for (let id = 1; id <= orders; id++) {
    const chosen = new Set();
    const lines = 1 + Math.floor(rand() * 3);
    while (chosen.size < lines) chosen.add(1 + Math.floor(rand() * PRODUCTS.length));
    let total = 0;
    const items = [];
    for (const productId of chosen) {
      const qty = 1 + Math.floor(rand() * 3);
      const cents = Number(price.get(productId).price_cents);
      total += qty * cents;
      items.push([productId, qty, cents]);
    }
    const customer = 1 + Math.floor(rand() * customers);
    const status = pick(STATUSES);
    const at = 30 + Math.floor(rand() * 270);
    addOrder.run(id, customerAccount[customer], customer, status, total, day(at));
    for (const [p, q, c] of items) addItem.run(id, p, q, c);
    if (status === 'shipped') addShipment.run(id, pick(['UPS', 'DHL', 'FedEx', 'Pony Express']), day(at + 1 + Math.floor(rand() * 4)));
  }
  db.exec('COMMIT');
  db.close();
}

const dataDir = path.join(realHome, 'acme', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const files = {};
for (const env of ENVS) {
  files[env] = path.join(dataDir, `acme-shop-${env}.sqlite`);
  build(files[env], env);
}

// ------------------------------------------------------------- the store

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const shop = Object.fromEntries(
  ENVS.map((env) => [
    env,
    {
      id: uuid(),
      name: `acme-shop · ${env}`,
      engine: 'sqlite',
      variant: 'sqlite',
      env,
      file: files[env],
      secretSource: 'none',
      ...(env === 'local' ? { writesEnabled: true } : {}),
      ...(env !== 'local' ? { mcpExposed: true } : {}),
      ...(env === 'prod' ? { pinned: true } : {}),
    },
  ]),
);

// Never opened by the capture; `.example` never resolves.
const net = (name, env, engine, variant, extra) => ({ id: uuid(), name, env, engine, variant, secretSource: 'none', ...extra });
const others = [
  net('billing · local', 'local', 'postgres', 'postgres', { host: 'billing.local.acme.example', port: 5432, database: 'billing', user: 'dev' }),
  net('billing · staging', 'staging', 'postgres', 'aurora-postgres', { host: 'billing.staging.acme.example', port: 5432, database: 'billing', user: 'readonly', ssl: 'require' }),
  net('billing · prod', 'prod', 'postgres', 'aurora-postgres', { host: 'billing.prod.acme.example', port: 5432, database: 'billing', user: 'readonly', ssl: 'require', pinned: true }),
  net('inventory · dev', 'dev', 'mysql', 'mariadb', { host: 'inventory.dev.acme.example', port: 3306, database: 'inventory', user: 'dev' }),
  net('inventory · prod', 'prod', 'mysql', 'aurora-mysql', { host: 'inventory.prod.acme.example', port: 3306, database: 'inventory', user: 'readonly', ssl: 'require' }),
  net('ledger · sandbox', 'sandbox', 'postgres', 'cockroach', { host: 'ledger.sandbox.acme.example', port: 26257, database: 'ledger', user: 'dev', ssl: 'require' }),
  net('events · prod', 'prod', 'dynamodb', 'dynamodb', { region: 'us-east-1', tableFilter: 'prod-*' }),
  net('warehouse', 'prod', 'postgres', 'redshift', { host: 'warehouse.acme.example', port: 5439, database: 'analytics', user: 'analyst', ssl: 'require' }),
  net('metrics · staging', 'staging', 'postgres', 'timescale', { host: 'metrics.staging.acme.example', port: 5432, database: 'metrics', user: 'readonly' }),
  net('cms · dev', 'dev', 'mysql', 'mysql', { host: 'cms.dev.acme.example', port: 3306, database: 'cms', user: 'dev' }),
];

const shopSet = {
  id: uuid(),
  name: 'acme-shop',
  memberIds: ENVS.map((e) => shop[e].id),
  baselineId: shop.prod.id,
  pinned: true,
  createdAt: '2026-09-02T14:00:00.000Z',
  agentContext: {
    tenant: { schema: 'main', table: 'accounts', column: 'id' },
    caveats: { shared: ['main.products'], excluded: ['2'] },
    notes: 'Amounts are in cents.\nAccount 2 is the internal test account; leave it out of totals.',
  },
};
const billingSet = {
  id: uuid(),
  name: 'billing',
  memberIds: [others[0].id, others[1].id, others[2].id],
  baselineId: others[2].id,
  createdAt: '2026-09-10T09:30:00.000Z',
};

const HERO_SQL = `-- Revenue by account and region, last 90 days
SELECT a.name AS account,
       c.region,
       COUNT(*) AS orders,
       SUM(o.total_cents) / 100.0 AS revenue,
       ROUND(AVG(o.total_cents) / 100.0, 2) AS avg_order
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN accounts a ON a.id = o.account_id
WHERE o.status IN ('paid', 'shipped')
  AND a.kind <> 'internal'
GROUP BY a.name, c.region
ORDER BY revenue DESC;
`;

const SET_SQL = `-- Same question, every environment
SELECT p.sku, p.name, p.price_cents,
       SUM(i.quantity) AS units
FROM products p
JOIN order_items i ON i.product_id = p.id
GROUP BY p.id
ORDER BY units DESC
LIMIT 8;
`;

const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();

const store = {
  connections: [...ENVS.map((e) => shop[e]), ...others],
  groups: [],
  envSets: [shopSet, billingSet],
  settings: {
    theme: THEME,
    uiScale: 1,
    sidebarVisible: true,
    sidebarWidth: 290,
    editorHeight: 300,
    rowLimit: 10000,
    aiTool: null,
    aiModel: { claude: '', codex: '', gemini: '' },
    aiFastModel: { claude: 'haiku', codex: '', gemini: '' },
    aiMapModel: 'sonnet',
    slowQueryMs: 1000,
    formatStyle: 'default',
    panesFull: true,
    dismissedHints: [],
    mapLocation: 'overdb',
  },
  buffers: {
    [shop.prod.id]: HERO_SQL,
    [shop.staging.id]: SET_SQL,
    [shop.local.id]: 'SELECT code, percent_off, expires_at FROM coupons;\n',
    [shopSet.id]: SET_SQL,
  },
  bufferState: { active: {}, schema: {} },
  askThreads: {},
  history: [],
  savedQueries: [],
  params: [],
};
fs.writeFileSync(path.join(USERDATA, 'overdb.json'), JSON.stringify(store, null, 2));

// ------------------------------------------------------------- agents

const agents = path.join(USERDATA, 'agents');
fs.mkdirSync(path.join(agents, 'clients'), { recursive: true });
const pid = Number(AGENT_PID);
// Presence is checked by pid; the capture passes its own, which outlives the app.
fs.writeFileSync(
  path.join(agents, 'clients', `${pid}.json`),
  JSON.stringify({ pid, client: 'claude-code', version: '2.4.1', cwd: path.join(realHome, 'code', 'acme-storefront'), since: iso(38) }),
);
const calls = [
  { at: iso(36), tool: 'list_connections', connection: '', ok: true, ms: 3 },
  { at: iso(35), tool: 'describe_database', connection: 'acme-shop · staging', ok: true, ms: 41, question: 'which customers ordered more than ten times last month?' },
  { at: iso(35), tool: 'describe_table', connection: 'acme-shop · staging', ok: true, ms: 12 },
  {
    at: iso(34), tool: 'query', connection: 'acme-shop · staging', ok: true, ms: 18, rowCount: 7,
    sql: "SELECT c.name, COUNT(*) AS orders FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.account_id <> 2 AND o.created_at >= '2026-10-01' GROUP BY c.id HAVING COUNT(*) > 10 ORDER BY orders DESC",
  },
  { at: iso(21), tool: 'list_tables', connection: 'acme-shop · prod', ok: true, ms: 9 },
  {
    at: iso(20), tool: 'query', connection: 'acme-shop · prod', ok: false, ms: 2,
    sql: "UPDATE orders SET status = 'shipped' WHERE id = 1042",
    error: 'Refused: agents can only read. This statement writes.',
  },
  {
    at: iso(19), tool: 'query', connection: 'acme-shop · prod', ok: true, ms: 27, rowCount: 100, truncated: true,
    sql: "SELECT o.id, o.status, o.total_cents, s.carrier FROM orders o LEFT JOIN shipments s ON s.order_id = o.id WHERE o.status = 'paid' AND o.account_id <> 2",
  },
  { at: iso(6), tool: 'describe_database', connection: 'acme-shop · prod', ok: true, ms: 38, question: 'why are refunds up this week?' },
  {
    at: iso(5), tool: 'query', connection: 'acme-shop · prod', ok: true, ms: 22, rowCount: 4,
    sql: "SELECT a.name, COUNT(*) AS refunds FROM orders o JOIN accounts a ON a.id = o.account_id WHERE o.status = 'refunded' AND o.account_id <> 2 GROUP BY a.name",
  },
];
fs.writeFileSync(
  path.join(agents, 'activity.jsonl'),
  calls.map((c) => JSON.stringify({ ...c, pid, client: 'claude-code' })).join('\n') + '\n',
);

fs.writeFileSync(path.join(ROOT, 'seed-ids.json'), JSON.stringify({ home: realHome, shop: Object.fromEntries(ENVS.map((e) => [e, shop[e].id])), shopSet: shopSet.id }, null, 2));
console.log('seeded', realHome);
