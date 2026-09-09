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
import { PostgresAdapter } from '../db/adapters/postgres';
import { SqliteAdapter } from '../db/adapters/sqlite';
import type { DbAdapter } from '../db/adapter';
import type { HostRequest, HostResponse } from './protocol';

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

function makeAdapter(engine: 'postgres' | 'mysql' | 'sqlite'): DbAdapter {
  switch (engine) {
    case 'sqlite':
      return new SqliteAdapter();
    case 'mysql':
      return new MysqlAdapter();
    case 'postgres':
      return new PostgresAdapter();
  }
}

const wire = transport();
let adapter: DbAdapter | null = null;

/// Unacked chunk sequence numbers, and the resolvers waiting on them. The
/// window is 2: enough to keep the pipe full, small enough that a fast
/// Postgres can't outrun a rendering React and balloon memory in between.
const ACK_WINDOW = 2;
const pendingAcks = new Map<number, () => void>();
const cancelled = new Set<string>();

function require_(): DbAdapter {
  if (!adapter) throw new Error('not connected');
  return adapter;
}

async function waitForAckRoom(): Promise<void> {
  if (pendingAcks.size < ACK_WINDOW) return;
  const oldest = Math.min(...pendingAcks.keys());
  await new Promise<void>((resolve) => pendingAcks.set(oldest, resolve));
}

async function runQuery(req: Extract<HostRequest, { op: 'run' }>): Promise<void> {
  const started = Date.now();
  let handle;
  try {
    handle = await require_().stream(req.sql, req.params ?? []);
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
    await handle.close();
    wire.send({
      kind: 'done',
      runId: req.runId,
      rowCount: total,
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

/// Driver errors carry stack noise and, on Postgres and MySQL, sometimes
/// echo connection parameters. Main scrubs known secret values on top of
/// this; here we just trim to the message.
function cleanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

wire.onMessage((req) => {
  void (async () => {
    try {
      switch (req.op) {
        case 'connect': {
          adapter = makeAdapter(req.spec.engine);
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
            value: await require_().introspect({ schemas: req.schemas }),
          });
          return;
        case 'listTables':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await require_().listTables() });
          return;
        case 'listSchemas':
          wire.send({ kind: 'reply', id: req.id, ok: true, value: await require_().listSchemas() });
          return;
        case 'useSchema':
          await require_().useSchema(req.name);
          wire.send({ kind: 'reply', id: req.id, ok: true, value: null });
          return;
        case 'explain':
          wire.send({
            kind: 'reply', id: req.id, ok: true,
            value: await require_().explain(req.sql, req.analyze),
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
