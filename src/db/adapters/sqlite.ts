// SQLite via `node:sqlite` — the runtime's own driver, no native addon.
//
// Why not better-sqlite3: overdb ships six artifacts across three OSes
// and two architectures. A native addon means a prebuild for Electron's
// module ABI on every one of those, asarUnpack, and a separately-signed
// .node inside a notarized bundle — a large recurring tax for a driver
// whose job is opening a local file. Verified: Electron 41.7 bundles Node
// 24 (24.18.0 as of 41.7), where node:sqlite is present, reports the source
// table per column, and emits no experimental warning. Host node 22 DOES
// warn — that is the test runner, not the app.
//
// The trade this makes is that the API is SYNCHRONOUS, so a slow query
// blocks its thread. That is survivable only because this adapter runs in
// a dedicated connection host process (src/dbhost), where the only thing
// it can block is itself. Do not construct it on the main thread.
//
// The other asymmetry: SQLite has no out-of-band interrupt, so `cancel()`
// returns false and the supervisor kills the host instead. Reopening a
// local file costs about a millisecond, so this is cheaper than it sounds.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ColumnInfo,
  ConnectSpec,
  DbAdapter,
  ForeignKeyInfo,
  IndexInfo,
  QueryHandle,
  QueryResult,
  SchemaSnapshot,
  StreamOptions,
  TableInfo,
} from '../adapter';
import type { Cell, CellKind, ColumnMeta } from '../../shared/types';
import { emptyHealth, type HealthSnapshot } from '../../shared/health';
import type { Variant } from '../../shared/engines';
import type { SlowQuerySupport, StatementStat } from '../../shared/slowQueries';

/// SQLite's declared types are free text (`VARCHAR(80)`, `INT8`), so we
/// classify by the same affinity rules SQLite itself uses rather than by
/// exact match. A null decltype (an expression column) lands on 'other'.
export function sqliteKind(declType: string | null): CellKind {
  if (!declType) return 'other';
  const t = declType.toUpperCase();
  if (t.includes('INT')) return t.includes('BIGINT') ? 'bigint' : 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB')) return 'bytes';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'float';
  if (t.includes('NUMERIC') || t.includes('DECIMAL')) return 'decimal';
  if (t.includes('BOOL')) return 'bool';
  if (t.includes('DATETIME') || t.includes('TIMESTAMP')) return 'timestamp';
  if (t.includes('DATE')) return 'date';
  if (t.includes('JSON')) return 'json';
  return 'other';
}

/// node:sqlite hands back JS values directly; normalize the ones that
/// don't survive structured clone or would lose precision on the wire.
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    const MAX = 64 * 1024;
    const slice = v.byteLength > MAX ? v.subarray(0, MAX) : v;
    return {
      __bin: true,
      b64: Buffer.from(slice).toString('base64'),
      byteLength: v.byteLength,
      truncated: v.byteLength > MAX,
    };
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function columnsOf(stmt: StatementSync): ColumnMeta[] {
  return stmt.columns().map((c) => ({
    name: c.name,
    typeName: c.type ?? '',
    kind: sqliteKind(c.type ?? null),
    nullable: null,
    // `columns()` reporting the source table and column is what makes a
    // reviewable inline UPDATE possible at all. Expression columns report
    // null, and the grid marks those read-only rather than guessing.
    sourceTable:
      c.table && c.column
        ? { schema: c.database ?? null, table: c.table, column: c.column }
        : null,
  }));
}

export class SqliteAdapter implements DbAdapter {
  private db: DatabaseSync | null = null;
  /// Opened lazily, and only ever by an armed write. See writable().
  private writeDb: DatabaseSync | null = null;
  /// True between beginTransaction() and commit()/rollback().
  private txnOpen = false;
  private spec: ConnectSpec | null = null;

  async connect(spec: ConnectSpec): Promise<void> {
    if (!spec.file) throw new Error('sqlite connection requires a file path');
    this.spec = spec;
    // Read-only is enforced HERE, by SQLite, not by inspecting the SQL.
    // An INSERT against this handle throws ERR_SQLITE_ERROR.
    this.db = new DatabaseSync(spec.file, { readOnly: spec.readOnly });
  }

  async ping(): Promise<{ ok: true; serverVersion: string; variant: Variant } | { ok: false; error: string }> {
    try {
      const row = this.require().prepare('select sqlite_version() as v').get() as { v: string };
      return { ok: true, serverVersion: row.v, variant: 'sqlite' };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async query(sql: string, params: unknown[] = [], maxRows = 100_000): Promise<QueryResult> {
    const handle = await this.stream(sql, params);
    const { rows, done } = await handle.next(maxRows);
    await handle.close();
    return { columns: handle.columns, rows, rowCount: rows.length, truncated: !done };
  }

  async stream(
    sql: string,
    params: unknown[] = [],
    opts: StreamOptions = {},
  ): Promise<QueryHandle> {
    const stmt = (opts.write ? this.writable() : this.require()).prepare(sql);
    stmt.setReturnArrays(true);
    stmt.setReadBigInts(true);
    const columns = columnsOf(stmt);

    // No result columns means a statement, not a query — run it and
    // report the write as an empty result rather than iterating nothing.
    if (columns.length === 0) {
      stmt.run(...(params as never[]));
      return { columns, async next() { return { rows: [], done: true }; }, async close() {} };
    }

    const iter = stmt.iterate(...(params as never[])) as Iterator<unknown[]>;
    let exhausted = false;
    return {
      columns,
      async next(n: number) {
        const rows: Cell[][] = [];
        while (rows.length < n) {
          const step = iter.next();
          if (step.done) {
            exhausted = true;
            break;
          }
          rows.push((step.value as unknown[]).map(toCell));
        }
        return { rows, done: exhausted };
      },
      async close() {
        exhausted = true;
      },
    };
  }

  /// SQLite offers no out-of-band interrupt. Returning false tells the
  /// supervisor to kill this host process instead.
  async cancel(): Promise<boolean> {
    return false;
  }

  async explain(
    sql: string,
    _analyze: boolean,
    params?: unknown[],
  ): Promise<{ format: 'json' | 'text'; plan: string }> {
    const stmt = this.require().prepare(`explain query plan ${sql}`);
    const rows = stmt.all(...((params ?? []) as never[])) as Array<Record<string, unknown>>;
    return { format: 'text', plan: rows.map((r) => String(r.detail ?? '')).join('\n') };
  }

  /// SQLite is a library, not a server. There is nobody keeping a history
  /// of what every client ran, because there is no "every client" — each
  /// process opens the file itself. Timing statements here would mean
  /// timing them in this adapter, which is what `settings.slowQueryMs`
  /// already does for the statements you ran.
  async slowQuerySupport(): Promise<SlowQuerySupport> {
    return {
      supported: false,
      reason: {
        code: 'unsupported',
        detail:
          'SQLite runs inside this process rather than on a server, so nothing accumulates a history of what has been run against the file.',
        engine: 'sqlite',
      },
    };
  }

  async slowQueries(): Promise<StatementStat[]> {
    return [];
  }

  async slowQueryExample(): Promise<string | null> {
    return null;
  }

  async resetSlowQueries(): Promise<void> {}

  /// SQLite has no server, so most of the dashboard has nothing to report
  /// — and saying that is the honest answer. What it DOES have is a file,
  /// and how big that file is (and how much of it is free pages waiting on
  /// a VACUUM) is a real thing to know.
  async health(): Promise<HealthSnapshot> {
    const db = this.require();
    const out = emptyHealth('sqlite');
    const notes = [
      'SQLite runs in this process — there are no sessions, no connection ceiling and no shared cache to report on.',
    ];

    const scalar = (sql: string): number | null => {
      try {
        const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
        const v = row ? Object.values(row)[0] : null;
        return typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v);
      } catch {
        return null;
      }
    };

    const pageSize = scalar('pragma page_size');
    const pageCount = scalar('pragma page_count');
    const freePages = scalar('pragma freelist_count');
    if (pageSize !== null && pageCount !== null) {
      out.databaseBytes = pageSize * pageCount;
      if (freePages !== null && freePages > 0) {
        notes.push(
          `${freePages} of ${pageCount} pages are free — about ${Math.round((freePages / pageCount) * 100)}% of the file is space a VACUUM would reclaim.`,
        );
      }
    }

    try {
      // dbstat is a compile-time option and is absent on plenty of builds;
      // when it is there it is the only way to size a table in SQLite.
      const rows = db
        .prepare(
          `select name as tbl, sum(pgsize) as bytes
             from dbstat group by name order by bytes desc limit 50`,
        )
        .all() as Array<{ tbl: string; bytes: number }>;
      out.tables = rows.map((r) => ({
        schema: 'main',
        table: String(r.tbl),
        bytes: Number(r.bytes) || 0,
        indexBytes: null,
        estimatedRows: null,
      }));
    } catch {
      notes.push('This SQLite build has no dbstat module, so per-table sizes are not available.');
    }

    return { ...out, notes };
  }

  /// Nothing to kill: there is no other session.
  async killSession(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'SQLite has no sessions.' };
  }

  async introspect(_opts: { schemas?: string[]; tables?: string[] }): Promise<SchemaSnapshot> {
    const db = this.require();
    const ping = await this.ping();
    const objects = db
      .prepare(
        `select name, type from sqlite_master
          where type in ('table','view') and name not like 'sqlite_%'
          order by name`,
      )
      .all() as Array<{ name: string; type: string }>;

    const infoStmt = db.prepare('select * from pragma_table_info(?)');
    const idxListStmt = db.prepare('select * from pragma_index_list(?)');
    const fkStmt = db.prepare('select * from pragma_foreign_key_list(?)');
    const idxInfoStmt = db.prepare('select * from pragma_index_info(?)');

    const tables: TableInfo[] = objects.map((o) => {
      const info = infoStmt.all(o.name) as Array<{
        cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }>;
      const columns: ColumnInfo[] = info.map((c) => ({
        name: c.name,
        ordinal: c.cid,
        typeName: c.type,
        nullable: c.notnull === 0,
        defaultExpr: c.dflt_value,
      }));
      const primaryKey = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

      const idxList = idxListStmt.all(o.name) as Array<{
        name: string; unique: number;
      }>;
      const indexes: IndexInfo[] = idxList.map((ix) => ({
        name: ix.name,
        unique: ix.unique === 1,
        columns: (idxInfoStmt.all(ix.name) as Array<{ name: string }>)
          .map((c) => c.name),
      }));

      const fkList = fkStmt.all(o.name) as Array<{
        id: number; table: string; from: string; to: string | null;
      }>;
      const byId = new Map<number, ForeignKeyInfo>();
      for (const fk of fkList) {
        const existing = byId.get(fk.id);
        if (existing) {
          existing.columns.push(fk.from);
          if (fk.to) existing.refColumns.push(fk.to);
        } else {
          byId.set(fk.id, {
            name: `fk_${o.name}_${fk.id}`,
            columns: [fk.from],
            refSchema: null,
            refTable: fk.table,
            refColumns: fk.to ? [fk.to] : [],
          });
        }
      }

      return {
        name: o.name,
        kind: o.type === 'view' ? 'view' : 'table',
        columns,
        primaryKey,
        indexes,
        foreignKeys: [...byId.values()],
      };
    });

    return {
      engine: 'sqlite',
      serverVersion: ping.ok ? ping.serverVersion : 'unknown',
      capturedAt: new Date().toISOString(),
      schemas: [{ name: 'main', tables }],
    };
  }

  async listSchemas(): Promise<string[]> {
    const rows = this.require().prepare('pragma database_list').all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const rows = this.require()
      .prepare(
        `select name, type from sqlite_master
          where type in ('table','view') and name not like 'sqlite_%' order by name`,
      )
      .all() as Array<{ name: string; type: string }>;
    return rows.map((r) => ({
      schema: 'main', table: r.name, kind: r.type === 'view' ? 'view' : 'table',
    }));
  }

  /// SQLite has no notion of a current schema — `main` and any ATTACHed
  /// database are addressed by qualifying the name. Nothing to switch.
  async useSchema(_name: string): Promise<string> {
    return 'main';
  }

  async currentSchema(): Promise<string | null> {
    return 'main';
  }

  /// SQLite's read-only is an OPEN FLAG, not a transaction, so an armed
  /// write cannot reuse the read-only handle at all — it needs a second one
  /// opened writable. Kept once opened: reopening a local file costs about
  /// a millisecond, but doing it per statement would mean losing any
  /// in-memory page cache each time.
  private writable(): DatabaseSync {
    if (!this.writeDb) {
      if (!this.spec?.file) throw new Error('sqlite connection requires a file path');
      this.writeDb = new DatabaseSync(this.spec.file);
    }
    return this.writeDb;
  }

  async beginTransaction(): Promise<void> {
    if (this.txnOpen) return;
    this.writable().exec('begin');
    this.txnOpen = true;
  }

  async commit(): Promise<void> {
    if (!this.txnOpen) return;
    this.txnOpen = false;
    this.writable().exec('commit');
  }

  async rollback(): Promise<void> {
    if (!this.txnOpen) return;
    this.txnOpen = false;
    try {
      this.writable().exec('rollback');
    } catch {
      // Already unwound; nothing left to undo.
    }
  }

  inTransaction(): boolean {
    return this.txnOpen;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.writeDb?.close();
    this.db = null;
    this.writeDb = null;
  }

  private require(): DatabaseSync {
    if (!this.db) throw new Error('sqlite adapter is not connected');
    return this.db;
  }
}

/// PRAGMA arguments can't be parameterized, so identifiers are quoted the
/// way SQLite expects: wrap in double quotes, double any inner quote.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
