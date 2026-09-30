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
import type { Engine } from '../shared/engines';
import { SqliteAdapter } from '../db/adapters/sqlite';
import type { DbAdapter } from '../db/adapter';
import { cleanError } from './cleanError';
import type { HostRequest, HostResponse, SeedStatsValue } from './protocol';
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

wire.onMessage((req) => {
  void (async () => {
    try {
      switch (req.op) {
        case 'connect': {
          adapter = makeAdapter(req.spec.engine);
          engine = req.spec.engine;
          await adapter.connect(req.spec);
          const ping = await adapter.ping();
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
  })();
});
