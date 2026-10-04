// One connection, one process.
//
// Runs an adapter in isolation and speaks the src/dbhost/protocol wire to
// whoever forked it. Four reasons this is a separate process rather than a
// module in main, roughly in order of importance:
//
//   1. node:sqlite is synchronous. In-process, a slow query freezes the
//      window. Here it freezes only itself.
//   2. Cancellation becomes universal: SQLite has no interrupt, but every
//      engine can be killed.
//   3. A large result's buffer lives outside the main heap, so an OOM or a
//      driver segfault costs one connection rather than the app.
//   4. It imports no electron, so `overdb serve --mcp` can fork this exact
//      file with child_process.fork later. src/db/noElectron.test.ts keeps
//      that true.

import { MysqlAdapter } from '../db/adapters/mysql';
import { DynamoAdapter } from '../db/adapters/dynamodb';
import { PostgresAdapter } from '../db/adapters/postgres';
import type { Engine, Variant } from '../shared/engines';
import { isRedshift } from '../shared/engines';
import { SqliteAdapter } from '../db/adapters/sqlite';
import type { DbAdapter } from '../db/adapter';
import { cleanError } from './cleanError';
import type { BaselineFindValue, BaselineStatsValue, HostRequest, HostResponse, SeedStatsValue } from './protocol';
import { findSql } from '../shared/baseline';
import { quoteIdent } from '../shared/orderBy';

/// Electron's utilityProcess exposes `parentPort`; child_process.fork uses
/// `process.send`. Supporting both is what makes the CLI path free later.
interface Transport {
  send(msg: HostResponse): void;
  onMessage(handler: (msg: HostRequest) => void): void;
}

function transport(): Transport {
  const parentPort = (process as unknown as { parentPort?: {
    postMessage(m: unknown): void;
    on(ev: 'message', cb: (e: { data: unknown }) => void): void;
    start?(): void;
  } }).parentPort;

  if (parentPort) {
    return {
      send: (msg) => parentPort.postMessage(msg),
      onMessage: (handler) => {
        parentPort.on('message', (e) => handler(e.data as HostRequest));
        parentPort.start?.();
      },
    };
  }
  return {
    send: (msg) => process.send?.(msg),
    onMessage: (handler) => process.on('message', (m) => handler(m as HostRequest)),
  };
}

function makeAdapter(engine: Engine): DbAdapter {
  switch (engine) {
    case 'sqlite':
      return new SqliteAdapter();
    case 'mysql':
      return new MysqlAdapter();
    case 'postgres':
      return new PostgresAdapter();
    case 'dynamodb':
      return new DynamoAdapter();
  }
}

const wire = transport();
let adapter: DbAdapter | null = null;
let engine: Engine | null = null;
/// What the server said it was on connecting: Redshift answers as Postgres
/// but keeps its sizes elsewhere.
let variant: Variant | null = null;

/// Table statistics for the seed flow — see SeedStatsValue. One catalog
/// query per engine, because a local copy of production is 900 tables and
/// counting them is minutes of disk for numbers the server already keeps.
async function seedStats(a: DbAdapter, schema: string, countUnknown: boolean, cap: number): Promise<SeedStatsValue> {
  const q = (name: string) => quoteIdent(name, engine ?? 'postgres');
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out: SeedStatsValue = { tables: [], maxId: null };
  const bump = (n: number | null) => {
    if (n !== null) out.maxId = Math.max(out.maxId ?? 0, n);
  };

  if (engine === 'mysql') {
    // MySQL 8 serves these from a cache up to a day old by default; a stale
    // AUTO_INCREMENT would put the seed's ids on top of real ones. MariaDB
    // has no such setting and reads them live.
    await a.query('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined);
    const r = await a.query(
      `SELECT TABLE_NAME, TABLE_ROWS, AUTO_INCREMENT FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [schema],
    );
    for (const [name, rows, auto] of r.rows) {
      out.tables.push({ table: String(name), rows: num(rows), approx: true, capped: false });
      const next = num(auto);
      bump(next === null ? null : next - 1);
    }
  } else if (engine === 'postgres') {
    const r = await a.query(
      `SELECT c.relname, c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
      [schema],
    );
    // -1 is "never analyzed", which is not the same as empty.
    for (const [name, rows] of r.rows) {
      const n = num(rows);
      out.tables.push({ table: String(name), rows: n !== null && n >= 0 ? Math.round(n) : null, approx: true, capped: false });
    }
    const seq = await a
      .query('SELECT max(last_value) FROM pg_sequences WHERE schemaname = $1', [schema])
      .catch(() => null);
    bump(num(seq?.rows[0]?.[0]));
  } else if (engine === 'sqlite') {
    // No statistics to read, but a SQLite file is on this machine and a
    // bounded count of a local file is cheap.
    const r = await a.query(`SELECT name FROM ${q(schema)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    for (const [name] of r.rows) {
      const target = `${q(schema)}.${q(String(name))}`;
      const c = await a.query(`SELECT COUNT(*) FROM (SELECT 1 FROM ${target} LIMIT ${cap + 1}) AS bounded`);
      const n = num(c.rows[0]?.[0]) ?? 0;
      out.tables.push({ table: String(name), rows: Math.min(n, cap), approx: false, capped: n > cap });
      // rowid is the integer primary key where there is one; a WITHOUT
      // ROWID table has neither and is skipped.
      const m = await a.query(`SELECT MAX(rowid) FROM ${target}`).catch(() => null);
      bump(num(m?.rows[0]?.[0]));
    }
    return out;
  }

  // Where the server had no estimate and size decides the gate, a bounded
  // count — stopping at the first table that reaches the cap, because the
  // answer is already no.
  if (countUnknown) {
    for (const t of out.tables) {
      if (t.rows !== null) continue;
      const c = await a.query(`SELECT COUNT(*) FROM (SELECT 1 FROM ${q(schema)}.${q(t.table)} LIMIT ${cap + 1}) AS bounded`);
      const n = num(c.rows[0]?.[0]) ?? 0;
      t.rows = Math.min(n, cap);
      t.approx = false;
      t.capped = n > cap;
      if (t.capped) break;
    }
  }
  return out;
}

/// Sizes for baseline discovery — see the 'baselineStats' request.
async function baselineStats(a: DbAdapter, schemas: string[]): Promise<BaselineStatsValue> {
  if (schemas.length === 0) return [];
  const q = (name: string) => quoteIdent(name, engine ?? 'postgres');
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out: BaselineStatsValue = [];
  /// Tables this user may not read, so nothing is asked of them that would
  /// be refused.
  let noReading = new Set<string>();
  if (engine === 'mysql') {
    await a.query('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined);
    const r = await a.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA IN (${schemas.map(() => '?').join(', ')})`,
      schemas,
    );
    for (const [s, t, rows, bytes] of r.rows) out.push({ schema: String(s), table: String(t), rows: num(rows), bytes: num(bytes) });
  } else if (engine === 'postgres' && isRedshift(variant ?? undefined)) {
    // Redshift has no pg_total_relation_size, and its pg_class counts are not
    // kept: svv_table_info has both, in rows and 1 MB blocks.
    // svv_table_info needs more than a plain user's rights on most clusters;
    // pg_class anyone can read, with row estimates and no sizes.
    // Literals, since Redshift takes no array parameter. A backslash may be
    // an escape there, so a schema name with one is never put in a query.
    const lit = (x: string) => `'${x.replace(/'/g, "''")}'`;
    const list = schemas.filter((x) => !x.includes('\\')).map(lit).join(', ') || "''";
    // Asked first, never tried: a refused statement aborts the read-only
    // transaction it runs in, and anything else on this connection at that
    // moment fails with it ("current transaction is aborted").
    const allowed = await a.query(`SELECT has_table_privilege('svv_table_info', 'select')`).catch(() => null);
    const info =
      allowed && String(allowed.rows[0]?.[0]) === 'true'
        ? await a.query(`SELECT "schema", "table", tbl_rows, size FROM svv_table_info WHERE "schema" IN (${list})`).catch(() => null)
        : null;
    if (info) {
      for (const [s, t, rows, mb] of info.rows) {
        const n = num(mb);
        out.push({ schema: String(s), table: String(t), rows: num(rows), bytes: n === null ? null : n * 1024 * 1024 });
      }
    } else {
      // A table is asked about by name, and naming it needs its schema: in
      // a schema this user may not use, the question itself is refused
      // ("permission denied for schema zendesk"). So the schemas are asked
      // first, and only the usable ones' tables are asked about.
      const usage = await a.query(`SELECT nspname, has_schema_privilege(nspname, 'usage') FROM pg_namespace WHERE nspname IN (${list})`).catch(() => null);
      const usable = usage ? usage.rows.filter(([, ok]) => String(ok) === 'true').map(([s]) => String(s)) : schemas;
      const usableList = usable.filter((x) => !x.includes('\\')).map(lit).join(', ') || "''";
      const r = await a.query(
        `SELECT n.nspname, c.relname, c.reltuples,
                has_table_privilege(quote_ident(n.nspname) || '.' || quote_ident(c.relname), 'select')
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname IN (${usableList})
          UNION ALL
         SELECT n.nspname, c.relname, c.reltuples, false
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname IN (${list}) AND n.nspname NOT IN (${usableList})`,
      );
      const readable = new Set<string>();
      for (const [s, t, rows, can] of r.rows) {
        const n = num(rows);
        out.push({ schema: String(s), table: String(t), rows: n !== null && n > 0 ? Math.round(n) : null, bytes: null });
        if (String(can) === 'true') readable.add(`${s}.${t}`);
      }
      noReading = new Set(out.filter((t) => !readable.has(`${t.schema}.${t.table}`)).map((t) => `${t.schema}.${t.table}`));
      // A table of unknown size would be copied whole as if it were small,
      // and on Redshift that can be a billion-row fact table. Counting is
      // quick there — it reads block metadata — so count what has no
      // estimate rather than guess.
      // Within a time limit: this connection's other requests wait behind
      // these, and past it a table of unknown size is left for a person.
      const until = Date.now() + 30_000;
      for (const t of out) {
        if (Date.now() > until) break;
        if (t.rows !== null || noReading.has(`${t.schema}.${t.table}`)) continue;
        const c = await a.query(`SELECT COUNT(*) FROM ${q(t.schema)}.${q(t.table)}`).catch(() => null);
        t.rows = c ? num(c.rows[0]?.[0]) : null;
      }
    }
  } else if (engine === 'postgres') {
    const r = await a.query(
      `SELECT n.nspname, c.relname, c.reltuples, pg_total_relation_size(c.oid) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1)`,
      [schemas],
    );
    // -1 is "never analyzed", which is not the same as empty.
    for (const [s, t, rows, bytes] of r.rows) {
      const n = num(rows);
      out.push({ schema: String(s), table: String(t), rows: n !== null && n >= 0 ? Math.round(n) : null, bytes: num(bytes) });
    }
  } else if (engine === 'sqlite') {
    for (const s of schemas) {
      const r = await a.query(`SELECT name FROM ${q(s)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
      for (const [name] of r.rows) {
        const c = await a.query(`SELECT COUNT(*) FROM ${q(s)}.${q(String(name))}`);
        out.push({ schema: s, table: String(name), rows: num(c.rows[0]?.[0]), bytes: null });
      }
    }
    return out;
  }
  const probeUntil = Date.now() + 30_000;
  for (const t of out) {
    if (Date.now() > probeUntil) break;
    if (t.rows !== 0 && t.rows !== null) continue;
    if (noReading.has(`${t.schema}.${t.table}`)) continue;
    const r = await a.query(`SELECT 1 FROM ${q(t.schema)}.${q(t.table)} LIMIT 1`).catch(() => null);
    if (r) t.rows = r.rows.length === 0 ? 0 : null;
  }
  return out;
}

/// Last resort. The adapters listen for their own driver's connection
/// errors, but a driver that throws from a timer or a socket callback we
/// never see would otherwise end the process with a stack on stderr and no
/// word to the window at all. Better to die loudly and deliberately: main
/// watches `exit`, rejects everything in flight, and tells the renderer the
/// connection is closed, which is at least a state the user can act on.
process.on('uncaughtException', (err) => {
  console.error('[dbhost] fatal:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[dbhost] unhandled rejection:', err);
});

/// Unacked chunk sequence numbers, and the resolvers waiting on them. The
/// window is 2: enough to keep the pipe full, small enough that a fast
/// Postgres can't outrun a rendering React and balloon memory in between.
const ACK_WINDOW = 2;
/// How long a statement's cleanup may take before its `done` is sent
/// anyway. Long enough for an ordinary cursor close and commit, short
/// enough that nobody sits watching a finished run claim to be running.
const CLOSE_GRACE_MS = 2_000;
const pendingAcks = new Map<number, () => void>();
const cancelled = new Set<string>();

function require_(): DbAdapter {
  if (!adapter) throw new Error('not connected');
  return adapter;
}

async function waitForAckRoom(): Promise<void> {
  if (pendingAcks.size < ACK_WINDOW) return;
  const oldest = Math.min(...pendingAcks.keys());
  // The renderer's window can be closed mid-stream, and webContents.send is
  // then a silent no-op — an unbounded wait wedges the host with its
  // read-only transaction open.
  await Promise.race([
    new Promise<void>((resolve) => pendingAcks.set(oldest, resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref?.()),
  ]);
}

async function runQuery(req: Extract<HostRequest, { op: 'run' }>): Promise<void> {
  const started = Date.now();
  let handle;
  try {
    handle = await require_().stream(req.sql, req.params ?? [], {
      maxRows: req.maxRows,
      write: req.write,
    });
  } catch (err) {
    wire.send({ kind: 'failed', runId: req.runId, message: cleanError(err) });
    return;
  }

  let seq = 0;
  let total = 0;
  let truncated = false;
  let sentColumns = false;

  try {
    for (;;) {
      if (cancelled.has(req.runId)) break;
      const room = Math.min(req.chunkRows, req.maxRows - total);
      if (room <= 0) {
        truncated = true;
        break;
      }
      const { rows, done } = await handle.next(room);
      if (rows.length > 0 || !sentColumns) {
        await waitForAckRoom();
        pendingAcks.set(seq, () => undefined);
        wire.send({
          kind: 'chunk',
          runId: req.runId,
          seq,
          columns: sentColumns ? undefined : handle.columns,
          rows,
        });
        sentColumns = true;
        seq += 1;
        total += rows.length;
      }
      if (done) break;
    }
    // Cleanup must not hold the terminal event hostage.
    //
    // Every row the caller is going to get has already been sent; what is
    // left is closing a cursor and ending a transaction. When that takes an
    // unbounded amount of time — a MySQL result set the server is still
    // pushing after we stopped reading it, say — awaiting it means the run
    // never reports done and the UI shows it as alive forever. So the close
    // is given a bounded wait and then left to finish on its own; its
    // failure is not the statement's failure, because the statement
    // succeeded.
    await Promise.race([
      handle.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
    ]);
    wire.send({
      kind: 'done',
      runId: req.runId,
      rowCount: total,
      // A write returns no rows, so `total` is 0 and says nothing. When the
      // engine reports what it changed, that is the number that means
      // something.
      affectedRows: handle.affectedRows ?? null,
      truncated,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    await handle.close().catch(() => undefined);
    wire.send({ kind: 'failed', runId: req.runId, message: cleanError(err) });
  } finally {
    cancelled.delete(req.runId);
    pendingAcks.clear();
  }
}

/// Postgres requests run one at a time. Each statement runs in its own
/// read-only transaction, and a connection has one: two requests at once —
/// discovery and the schema tree, say — interleave their BEGINs and COMMITs,
/// and one refused statement aborts the other's work ("current transaction
/// is aborted"). The driver already queues statements on its connection, so
/// nothing waits longer than it did; what changes is that a request's
/// transaction is its own. Never queued: an ack (a run in flight waits on
/// it), cancel (it must reach a running statement — it uses a second
/// connection), close and connect. MySQL is left as it was.
const UNQUEUED: ReadonlySet<string> = new Set(['ack', 'cancel', 'close', 'connect']);
let queue: Promise<unknown> = Promise.resolve();
function serially(work: () => Promise<void>): void {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
}

wire.onMessage((req) => {
  const work = async () => {
    try {
      switch (req.op) {
        case 'connect': {
          adapter = makeAdapter(req.spec.engine);
          engine = req.spec.engine;
          await adapter.connect(req.spec);
          const ping = await adapter.ping();
          variant = ping.ok ? ping.variant : null;
          wire.send({ kind: 'reply', id: req.id, ok: true, value: ping });
          return;
        }
        case 'ping':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await require_().ping() });
          return;
        case 'introspect':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().introspect({ schemas: req.schemas, tables: req.tables }),
          });
          return;
        case 'listTables':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().listTables({ unfiltered: req.unfiltered }),
          });
          return;
        case 'listSchemas':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await require_().listSchemas() });
          return;
        case 'useSchema':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().useSchema(req.name),
          });
          return;
        case 'txn': {
          const a = require_();
          if (req.action === 'begin') await a.beginTransaction();
          else if (req.action === 'commit') await a.commit();
          else if (req.action === 'rollback') await a.rollback();
          wire.send({ kind: 'reply', id: req.id, ok: true, value: { open: a.inTransaction() } });
          return;
        }
        case 'currentSchema':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().currentSchema(),
          });
          return;
        case 'explain':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().explain(req.sql, req.analyze, req.params),
          });
          return;
        case 'slowQuerySupport':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().slowQuerySupport(),
          });
          return;
        case 'slowQueries':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().slowQueries({ limit: req.limit }),
          });
          return;
        case 'slowQueryExample':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().slowQueryExample(req.digest),
          });
          return;
        case 'resetSlowQueries':
          await require_().resetSlowQueries();
          wire.send({ kind: 'reply', id: req.id, ok: true, value: null });
          return;
        case 'health':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await require_().health(req.scope) });
          return;
        case 'killSession':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().killSession(req.sessionId, { terminate: req.terminate }),
          });
          return;
        case 'seedStats':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await seedStats(require_(), req.schema, req.countUnknown, req.cap),
          });
          return;
        case 'baselineStats':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await baselineStats(require_(), req.schemas) });
          return;
        case 'baselineDistinct': {
          const qi = (n: string) => quoteIdent(n, engine ?? 'postgres');
          const target = engine === 'sqlite' ? qi(req.table) : `${qi(req.schema)}.${qi(req.table)}`;
          const cols = req.columns.map(qi).join(', ');
          const sample = Math.max(1, Math.min(200_000, Math.floor(req.sample)));
          const limit = Math.max(1, Math.min(5_000, Math.floor(req.limit)));
          const r = await require_().query(
            `SELECT DISTINCT ${cols} FROM (SELECT ${cols} FROM ${target} LIMIT ${sample}) sampled LIMIT ${limit}`,
            [],
            limit,
          );
          wire.send({ kind: 'reply', id: req.id, ok: true, value: r.rows });
          return;
        }
        case 'baselineCount': {
          const qi = (n: string) => quoteIdent(n, engine ?? 'postgres');
          const target = engine === 'sqlite' ? qi(req.table) : `${qi(req.schema)}.${qi(req.table)}`;
          const values = req.values.slice(0, 1000);
          const holders = values.map((_, i) => (engine === 'postgres' ? `$${i + 1}` : '?')).join(', ');
          const r = await require_().query(`SELECT COUNT(*) FROM ${target} WHERE ${qi(req.column)} IN (${holders || 'NULL'})`, values, 1);
          wire.send({ kind: 'reply', id: req.id, ok: true, value: Number(r.rows[0]?.[0] ?? 0) });
          return;
        }
        case 'baselineFind': {
          const { sql, params } = findSql(engine ?? 'postgres', req.req);
          const r = await require_().query(sql, params, req.req.limit);
          wire.send({ kind: 'reply', id: req.id, ok: true, value: { rows: r.rows } satisfies BaselineFindValue });
          return;
        }
        case 'run':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: { started: true } });
          await runQuery(req);
          return;
        case 'ack': {
          const resolve = pendingAcks.get(req.seq);
          pendingAcks.delete(req.seq);
          resolve?.();
          return;
        }
        case 'cancel': {
          cancelled.add(req.runId);
          const interrupted = await require_().cancel();
          wire.send({ kind: 'reply', id: req.id, ok: true, value: { interrupted } });
          return;
        }
        case 'close':
          await adapter?.close();
          adapter = null;
          wire.send({ kind: 'reply', id: req.id, ok: true, value: null });
          return;
      }
    } catch (err) {
      wire.send({ kind: 'reply', id: req.id, ok: false, error: cleanError(err) });
    }
  };
  if (engine === 'postgres' && !UNQUEUED.has(req.op)) serially(work);
  else void work();
});
