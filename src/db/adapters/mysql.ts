// MySQL / MariaDB via `mysql2`.
//
// Same two decisions as the Postgres adapter, for the same reasons:
//
// 1. TYPE PARSING IS DISABLED. mysql2 by default turns DATETIME into a JS
//    Date in the process's local zone and DECIMAL into a float. Both are
//    silent corruption in a tool whose job is showing what is actually
//    stored. A typeCast that returns the raw string for everything means
//    values arrive exactly as the server sent them.
//
// 2. TWO CONNECTIONS, ALWAYS. `KILL QUERY` has to arrive on a different
//    connection than the one that is busy running the query.
//
// MariaDB note: this speaks the same wire protocol and everything here is
// supported on MariaDB 10.x — `START TRANSACTION READ ONLY` landed in 10.0
// and `EXPLAIN FORMAT=JSON` in 10.1. The two diverge on newer
// performance-schema views, which matters for the perf work later, not
// here.

import mysql from 'mysql2';
import type { Connection as MysqlConnection, FieldPacket, QueryOptions } from 'mysql2';
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
import { tlsOptions } from '../tls';
import { detectVariant } from '../../shared/engines';
import type { Variant } from '../../shared/engines';
import { classifyMysqlProbeError, digestTruncated } from '../../shared/slowQueries';
import { emptyHealth, type HealthSnapshot } from '../../shared/health';
import type { SlowQuerySupport, StatementStat } from '../../shared/slowQueries';

/// mysql2 field type codes. Hardcoded rather than imported from
/// mysql2/lib/constants/types, which is not part of its public surface.
const T = {
  DECIMAL: 0, TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6,
  TIMESTAMP: 7, LONGLONG: 8, INT24: 9, DATE: 10, TIME: 11, DATETIME: 12,
  YEAR: 13, BIT: 16, JSON: 245, NEWDECIMAL: 246, ENUM: 247, SET: 248,
  TINY_BLOB: 249, MEDIUM_BLOB: 250, LONG_BLOB: 251, BLOB: 252,
  VAR_STRING: 253, STRING: 254, GEOMETRY: 255,
} as const;

/// Collation 63 is `binary`. It is the ONLY thing separating a BLOB from a
/// TEXT column — MySQL gives both the same type code, so classifying on
/// the code alone renders every TEXT column as `<n bytes binary>`.
const BINARY_CHARSET = 63;

export function mysqlKind(typeCode: number, charsetNr: number): CellKind {
  const binary = charsetNr === BINARY_CHARSET;
  switch (typeCode) {
    case T.TINY: case T.SHORT: case T.LONG: case T.INT24: case T.YEAR:
      return 'int';
    case T.LONGLONG:
      return 'bigint';
    case T.FLOAT: case T.DOUBLE:
      return 'float';
    case T.DECIMAL: case T.NEWDECIMAL:
      return 'decimal';
    case T.JSON:
      return 'json';
    case T.DATE:
      return 'date';
    case T.TIME:
      return 'time';
    // MySQL's TIMESTAMP is zone-converted on read and DATETIME is not, but
    // neither carries an offset on the wire the way timestamptz does, so
    // both report as a plain timestamp rather than claiming otherwise.
    case T.DATETIME: case T.TIMESTAMP:
      return 'timestamp';
    case T.BIT: case T.GEOMETRY:
      return 'bytes';
    case T.TINY_BLOB: case T.MEDIUM_BLOB: case T.LONG_BLOB: case T.BLOB:
      return binary ? 'bytes' : 'text';
    case T.VAR_STRING: case T.STRING:
      return binary ? 'bytes' : 'text';
    case T.ENUM: case T.SET:
      return 'text';
    default:
      return 'other';
  }
}

const MAX_INLINE_BYTES = 64 * 1024;

/// Return every value as the server's own bytes: a string, or a capped
/// binary cell. `next()` is never called, so mysql2's own conversions
/// never run.
function rawTypeCast(field: {
  type: number; characterSet: number;
  string(): string | null; buffer(): Buffer | null;
}): Cell {
  const binary =
    field.characterSet === BINARY_CHARSET &&
    (field.type === T.BLOB || field.type === T.TINY_BLOB ||
     field.type === T.MEDIUM_BLOB || field.type === T.LONG_BLOB ||
     field.type === T.VAR_STRING || field.type === T.STRING ||
     field.type === T.BIT || field.type === T.GEOMETRY);

  if (binary) {
    const buf = field.buffer();
    if (buf === null) return null;
    const slice = buf.byteLength > MAX_INLINE_BYTES ? buf.subarray(0, MAX_INLINE_BYTES) : buf;
    return {
      __bin: true,
      b64: slice.toString('base64'),
      byteLength: buf.byteLength,
      truncated: buf.byteLength > MAX_INLINE_BYTES,
    };
  }
  return field.string();
}

/// information_schema answers in a different case depending on who you ask.
///
/// MySQL 8 turned information_schema into views over the data dictionary, and
/// the label a column comes back under is now the DICTIONARY's name — upper
/// case — not the lower-case text you wrote in the select list. MariaDB (and
/// MySQL 5.7) still echo what you typed. So `r.table_name` is populated on
/// one server and `undefined` on the other, and the failure is silent: the
/// catalog loads with the right number of tables and every name empty, which
/// downstream reads as "this database has no tables called anything".
///
/// Aliasing every column would work too, and would have to be remembered by
/// every future query. Folding the keys once cannot be forgotten.
export function lowerKeys<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
    return out as T;
  });
}

function mapFields(fields: FieldPacket[]): ColumnMeta[] {
  return fields.map((f) => {
    const raw = f as unknown as {
      name: string; orgName?: string; table?: string; orgTable?: string;
      schema?: string; db?: string; type: number; characterSet: number;
    };
    // orgTable/orgName are the SOURCE table and column, as opposed to
    // table/name which reflect any alias. An expression or a literal has
    // an empty orgTable, and that is what makes its cell non-editable.
    const orgTable = raw.orgTable ?? '';
    const orgName = raw.orgName ?? '';
    return {
      name: raw.name,
      typeName: typeNameOf(raw.type, raw.characterSet),
      kind: mysqlKind(raw.type, raw.characterSet),
      nullable: null,
      sourceTable:
        orgTable && orgName
          ? { schema: raw.schema ?? raw.db ?? null, table: orgTable, column: orgName }
          : null,
    };
  });
}

function typeNameOf(code: number, charsetNr: number): string {
  const binary = charsetNr === BINARY_CHARSET;
  const names: Record<number, string> = {
    [T.DECIMAL]: 'decimal', [T.NEWDECIMAL]: 'decimal', [T.TINY]: 'tinyint',
    [T.SHORT]: 'smallint', [T.LONG]: 'int', [T.INT24]: 'mediumint',
    [T.LONGLONG]: 'bigint', [T.FLOAT]: 'float', [T.DOUBLE]: 'double',
    [T.TIMESTAMP]: 'timestamp', [T.DATE]: 'date', [T.TIME]: 'time',
    [T.DATETIME]: 'datetime', [T.YEAR]: 'year', [T.BIT]: 'bit',
    [T.JSON]: 'json', [T.ENUM]: 'enum', [T.SET]: 'set',
    [T.GEOMETRY]: 'geometry',
  };
  if (names[code]) return names[code];
  if (code === T.BLOB || code === T.TINY_BLOB || code === T.MEDIUM_BLOB || code === T.LONG_BLOB) {
    return binary ? 'blob' : 'text';
  }
  if (code === T.VAR_STRING) return binary ? 'varbinary' : 'varchar';
  if (code === T.STRING) return binary ? 'binary' : 'char';
  return `type_${code}`;
}

export class MysqlAdapter implements DbAdapter {
  private conn: MysqlConnection | null = null;
  /// Reserved for KILL QUERY — see the header.
  private sideConn: MysqlConnection | null = null;
  private spec: ConnectSpec | null = null;
  /// Set by ping(), which connect() always calls. MariaDB and MySQL
  /// diverge on the performance schema, so the perf reads need to know
  /// which one answered rather than sniffing version strings at the call
  /// site.
  private variant: Variant = 'mysql';
  /// True between beginTransaction() and commit()/rollback().
  private txnOpen = false;
  /// The socket-level error that ended this session, if one did. Set from
  /// the connection's own 'error' event; see `open`.
  private fatal: Error | null = null;

  async connect(spec: ConnectSpec): Promise<void> {
    this.spec = spec;
    const config = {
      host: spec.host ?? '127.0.0.1',
      port: spec.port ?? 3306,
      database: spec.database,
      user: spec.user,
      password: spec.password,
      ssl: tlsOptions(spec),
      // Values must arrive as sent; see rawTypeCast.
      typeCast: rawTypeCast as unknown as QueryOptions['typeCast'],
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    };
    this.fatal = null;
    const onFatal = (err: Error) => {
      this.fatal = err;
    };
    this.conn = await open(config, onFatal);
    this.sideConn = await open(config, onFatal);
    if (spec.statementTimeoutMs) {
      // MariaDB spells this max_statement_time and takes SECONDS as a
      // float; MySQL uses max_execution_time in milliseconds. Try each and
      // let the other fail — a missing timeout must not block connecting.
      const seconds = spec.statementTimeoutMs / 1000;
      await exec(this.conn, `set session max_statement_time = ${seconds}`).catch(() => undefined);
      await exec(this.conn, `set session max_execution_time = ${spec.statementTimeoutMs}`).catch(() => undefined);
    }
  }

  async ping(): Promise<{ ok: true; serverVersion: string; variant: Variant } | { ok: false; error: string }> {
    try {
      const conn = this.require();
      const rows = (await exec(
        conn,
        'select version() as v, @@version_comment as c',
      )) as Array<{ v: string; c: string | null }>;
      const version = String(rows[0].v);

      // Aurora MySQL reports a stock MySQL version(); aurora_version() is
      // the only thing that distinguishes it.
      const auroraVersion = await exec(conn, 'select aurora_version() as v')
        .then((r) => String((r as Array<{ v: string }>)[0].v))
        .catch(() => null);

      this.variant = detectVariant('mysql', {
        version,
        versionComment: rows[0].c,
        auroraVersion,
      });
      return { ok: true, serverVersion: version, variant: this.variant };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    const conn = this.require();
    // Read-only is the SERVER's job. Outside an armed write the statement
    // runs inside a read-only transaction and the server rejects any
    // mutation with ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION.
    // A manual transaction, once open, owns everything — reads included.
    // Wrapping a read in its own transaction while one is open would hide
    // the uncommitted work the user opened it to see.
    // Captured here, not read off `this` inside the handle below: the
    // handle is a plain object literal and its `this` is not the adapter.
    const sideConn = this.sideConn;
    const inTxn = this.txnOpen;
    const readOnly = !inTxn && (this.spec?.readOnly ?? true) && !opts.write;
    if (readOnly) await exec(conn, 'start transaction read only');
    // Auto-commit write: its own transaction, closed when the handle is.
    // DDL auto-commits in MySQL regardless of this.
    else if (!inTxn && opts.write) await exec(conn, 'start transaction');
    const ownsTxn = !inTxn;

    const q = conn.query({ sql, values: params, rowsAsArray: true } as QueryOptions);
    let columns: ColumnMeta[] = [];
    // mysql2 emits 'fields' with UNDEFINED for a statement that produces no
    // result set — `doneInsert` does `emit('fields', void 0)` for a DELETE,
    // UPDATE or ALTER. Calling .map on that threw inside mysql2's own packet
    // handler, which it treats as a FATAL connection error: one DELETE
    // destroyed the connection rather than returning a row count.
    q.on('fields', (fields: FieldPacket[] | undefined) => {
      columns = fields ? mapFields(fields) : [];
    });

    const stream = q.stream({ highWaterMark: 1024 });
    let ended = false;
    let failure: Error | null = null;
    let affected: number | null = null;
    /// Resolvers for a `next()` that is parked waiting for something to
    /// happen. Kept here rather than as one-shot listeners because the
    /// thing being waited for can arrive on the QUERY as easily as on the
    /// stream, and a waiter listening to only one of them waits forever.
    const waiters = new Set<() => void>();
    const wake = () => {
      for (const w of waiters) w();
      waiters.clear();
    };
    const finish = () => {
      ended = true;
      wake();
    };

    // A statement with no result set — DELETE, UPDATE, ALTER — produces an
    // OkPacket instead of rows. Its stream never yields anything and, in
    // paused mode, never emits 'end' either: the query completes on the
    // server in a millisecond and the handle sits there forever waiting for
    // a row that is not coming. Listening on the QUERY is what notices.
    q.on('result', (packet: unknown) => {
      if (packet && typeof packet === 'object' && 'affectedRows' in packet) {
        affected = Number((packet as { affectedRows: number }).affectedRows);
      }
    });
    q.on('end', finish);
    q.on('error', (err: Error) => {
      failure = err;
      finish();
    });
    stream.on('readable', wake);
    stream.on('end', finish);
    stream.on('error', (err: Error) => {
      failure = err;
      finish();
    });

    return {
      get columns() {
        return columns;
      },
      get affectedRows() {
        return affected;
      },
      async next(n: number) {
        const rows: Cell[][] = [];
        while (rows.length < n) {
          if (failure) throw failure;
          const row = stream.read() as Cell[] | null;
          if (row !== null) {
            // `rowsAsArray` means a real row is an ARRAY. The OkPacket that
            // ends a write arrives through the same stream as an object,
            // and pushing it would put a phantom
            // `{affectedRows: 1, insertId: 0, …}` row in the grid.
            if (Array.isArray(row)) rows.push(row);
            continue;
          }
          if (ended) break;
          // Nothing buffered and not finished: park until anything happens,
          // on the stream OR on the query.
          await new Promise<void>((resolve) => waiters.add(resolve));
        }
        if (failure) throw failure;
        return { rows, done: ended && stream.readableLength === 0 };
      },
      async close() {
        // MySQL sends a result set in full and offers no way to stop it
        // from the connection reading it. `stream.destroy()` only stops US
        // reading — the server keeps sending, the connection stays busy for
        // the remainder, and the `commit` below queues behind every row we
        // said we did not want. On a big table over a network that is
        // minutes, and until it returns the caller has no terminal event:
        // the run sits at the row cap, apparently alive, forever.
        //
        // KILL QUERY from the reserved side connection is the only thing
        // that actually stops it. Best-effort: if it fails we are no worse
        // off than before, and the statement is finished either way.
        if (!ended) {
          const threadId = (conn as unknown as { threadId?: number })?.threadId;
          if (threadId && sideConn) {
            await exec(sideConn, `kill query ${Number(threadId)}`).catch(() => undefined);
          }
        }
        stream.destroy();
        // Only the transaction this statement opened. A manual one belongs
        // to the user until they commit or roll it back.
        if (ownsTxn) await exec(conn, 'commit').catch(() => undefined);
      },
    };
  }

  async cancel(): Promise<boolean> {
    const threadId = (this.conn as unknown as { threadId?: number })?.threadId;
    if (!threadId || !this.sideConn) return false;
    await exec(this.sideConn, `kill query ${Number(threadId)}`);
    return true;
  }

  async explain(
    sql: string,
    _analyze: boolean,
    params?: unknown[],
  ): Promise<{ format: 'json' | 'text'; plan: string }> {
    const rows = (await exec(
      this.require(),
      `explain format=json ${sql}`,
      params ?? [],
    )) as Array<Record<string, unknown>>;
    const first = rows[0] ?? {};
    const value = first.EXPLAIN ?? Object.values(first)[0];
    return { format: 'json', plan: typeof value === 'string' ? value : JSON.stringify(value) };
  }

  async introspect(opts: { schemas?: string[]; tables?: string[] }): Promise<SchemaSnapshot> {
    const conn = this.require();
    const schemas = opts.schemas?.length
      ? opts.schemas
      : this.spec?.database
        ? [this.spec.database]
        : lowerKeys(
            (await exec(
              conn,
              `select schema_name from information_schema.schemata
                where schema_name not in ('information_schema','performance_schema','mysql','sys')
                order by schema_name`,
            )) as Array<{ schema_name: string }>,
          ).map((r) => r.schema_name);

    if (schemas.length === 0) {
      return { engine: 'mysql', serverVersion: 'unknown', capturedAt: new Date().toISOString(), schemas: [] };
    }
    const placeholders = schemas.map(() => '?').join(',');

    const cols = lowerKeys(await exec(
      conn,
      `select c.table_schema, c.table_name, t.table_type, c.column_name,
              c.ordinal_position, c.column_type, c.is_nullable, c.column_default
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema in (${placeholders})
        order by c.table_schema, c.table_name, c.ordinal_position`,
      schemas,
    ) as Array<Record<string, string>>);

    // `expression` is what a FUNCTIONAL index stores: MySQL 8.0.13+ reports
    // `column_name` as NULL for one and puts the expression in its own
    // column. Read without it, such an index arrives with a null column
    // name — which is not a hypothetical, it is every functional index on
    // the server. MariaDB has no such column at all, so the query is tried
    // with it and retried without: cheaper and more honest than deciding
    // from a version string which forks grew which column when.
    const keys = lowerKeys(
      (await exec(
        conn,
        `select table_schema, table_name, column_name, expression, seq_in_index, index_name, non_unique
           from information_schema.statistics
          where table_schema in (${placeholders})
          order by table_schema, table_name, index_name, seq_in_index`,
        schemas,
      ).catch(() =>
        exec(
          conn,
          `select table_schema, table_name, column_name, seq_in_index, index_name, non_unique
             from information_schema.statistics
            where table_schema in (${placeholders})
            order by table_schema, table_name, index_name, seq_in_index`,
          schemas,
        ),
      )) as Array<Record<string, string | null>>,
    );

    const fks = lowerKeys(await exec(
      conn,
      `select table_schema, table_name, constraint_name, column_name,
              referenced_table_schema, referenced_table_name, referenced_column_name
         from information_schema.key_column_usage
        where table_schema in (${placeholders}) and referenced_table_name is not null
        order by table_schema, table_name, constraint_name, ordinal_position`,
      schemas,
    ) as Array<Record<string, string>>);

    const byTable = new Map<string, TableInfo>();
    for (const r of cols) {
      const key = `${r.table_schema}.${r.table_name}`;
      let t = byTable.get(key);
      if (!t) {
        t = {
          name: r.table_name,
          kind: r.table_type === 'VIEW' ? 'view' : 'table',
          columns: [], primaryKey: [], indexes: [], foreignKeys: [],
        };
        byTable.set(key, t);
      }
      const col: ColumnInfo = {
        name: r.column_name,
        ordinal: Number(r.ordinal_position),
        typeName: r.column_type,
        nullable: r.is_nullable === 'YES',
        defaultExpr: r.column_default ?? null,
      };
      t.columns.push(col);
    }

    const indexAcc = new Map<string, IndexInfo>();
    for (const r of keys) {
      const table = byTable.get(`${r.table_schema}.${r.table_name}`);
      if (!table) continue;
      if (r.index_name === 'PRIMARY') {
        // A primary key is never functional, so a null here would mean
        // something has gone wrong rather than something unusual.
        if (r.column_name !== null) table.primaryKey.push(String(r.column_name));
        continue;
      }
      const ikey = `${r.table_schema}.${r.table_name}.${r.index_name}`;
      let ix = indexAcc.get(ikey);
      if (!ix) {
        ix = { name: String(r.index_name), columns: [], unique: String(r.non_unique) === '0' };
        indexAcc.set(ikey, ix);
        table.indexes.push(ix);
      }
      // The expression, parenthesised the way MySQL writes it in SHOW
      // CREATE TABLE, so a functional index reads as what it indexes
      // rather than as a hole. An index part that is neither — which
      // should not happen — is left out, and the drift comparison names
      // the index as one it could not read instead of guessing.
      const part =
        r.column_name !== null && r.column_name !== undefined
          ? String(r.column_name)
          : r.expression
            ? `(${String(r.expression)})`
            : null;
      if (part !== null) ix.columns.push(part);
    }

    const fkAcc = new Map<string, ForeignKeyInfo>();
    for (const r of fks) {
      const table = byTable.get(`${r.table_schema}.${r.table_name}`);
      if (!table) continue;
      const fkey = `${r.table_schema}.${r.table_name}.${r.constraint_name}`;
      let fk = fkAcc.get(fkey);
      if (!fk) {
        fk = {
          name: r.constraint_name, columns: [],
          refSchema: r.referenced_table_schema ?? null,
          refTable: r.referenced_table_name, refColumns: [],
        };
        fkAcc.set(fkey, fk);
        table.foreignKeys.push(fk);
      }
      fk.columns.push(r.column_name);
      fk.refColumns.push(r.referenced_column_name);
    }

    const ping = await this.ping();
    return {
      engine: 'mysql',
      serverVersion: ping.ok ? ping.serverVersion : 'unknown',
      capturedAt: new Date().toISOString(),
      schemas: schemas.map((name) => ({
        name,
        tables: [...byTable.entries()].filter(([k]) => k.startsWith(`${name}.`)).map(([, t]) => t),
      })),
    };
  }

  async listSchemas(): Promise<string[]> {
    const rows = lowerKeys(
      (await exec(
        this.require(),
        `select schema_name from information_schema.schemata
          where schema_name not in ('information_schema','performance_schema','mysql','sys')
          order by schema_name`,
      )) as Array<{ schema_name: string }>,
    );
    return rows.map((r) => r.schema_name);
  }

  async listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const rows = lowerKeys(
      (await exec(
        this.require(),
        `select table_schema, table_name, table_type from information_schema.tables
          where table_schema not in ('information_schema','performance_schema','mysql','sys')
          order by table_schema, table_name`,
      )) as Array<Record<string, string>>,
    );
    return rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      kind: r.table_type === 'VIEW' ? 'view' : 'table',
    }));
  }

  async useSchema(name: string): Promise<string> {
    // Switch BOTH connections: the side connection issues KILL QUERY and
    // introspection reads from the primary, and leaving them pointed at
    // different databases is the kind of split-brain that produces a bug
    // report nobody can reproduce.
    const quoted = '`' + name.replace(/`/g, '``') + '`';
    await exec(this.require(), `use ${quoted}`);
    if (this.sideConn) await exec(this.sideConn, `use ${quoted}`);
    const now = (await this.currentSchema()) ?? name;
    // Update the spec too, so a host restart (the cancel backstop kills and
    // reconnects) comes back to the database you chose rather than the one
    // the connection was saved with.
    if (this.spec) this.spec.database = now;
    return now;
  }

  async currentSchema(): Promise<string | null> {
    const rows = (await exec(this.require(), 'select database() as db')) as Array<{
      db: string | null;
    }>;
    return rows[0]?.db ?? null;
  }

  async beginTransaction(): Promise<void> {
    if (this.txnOpen) return;
    await exec(this.require(), 'start transaction');
    this.txnOpen = true;
  }

  async commit(): Promise<void> {
    if (!this.txnOpen) return;
    this.txnOpen = false;
    await exec(this.require(), 'commit');
  }

  async rollback(): Promise<void> {
    if (!this.txnOpen) return;
    // Cleared FIRST: a rollback that itself fails must not leave the
    // adapter believing a transaction is still open.
    this.txnOpen = false;
    await exec(this.require(), 'rollback').catch(() => undefined);
  }

  inTransaction(): boolean {
    return this.txnOpen;
  }

  async close(): Promise<void> {
    await end(this.conn);
    await end(this.sideConn);
    this.conn = null;
    this.sideConn = null;
    this.fatal = null;
  }

  // -------------------------------------------------------------------
  // Per-statement cost
  // -------------------------------------------------------------------

  async slowQuerySupport(): Promise<SlowQuerySupport> {
    const conn = this.require();
    try {
      // Checked BEFORE the read, unlike Postgres, because of a failure that
      // does not look like one: with performance_schema off, the digest
      // table still exists and still answers — with zero rows. Reading
      // first would report "supported, nothing recorded yet" for a server
      // that is recording nothing and always will be.
      const on = (await exec(conn, 'select @@performance_schema as ps')) as Array<{ ps: string }>;
      if (String(on[0]?.ps) !== '1') {
        return {
          supported: false,
          reason: {
            code: 'needs-restart',
            detail:
              this.variant === 'aurora-mysql'
                ? 'The performance schema is off. On Aurora it is turned on in the parameter group, which needs a reboot.'
                : 'The performance schema is off. It is set at startup, so turning it on needs a server restart.',
            parameter: 'performance_schema',
            // Not a claim about where the server runs — it is a claim about
            // whether a SET GLOBAL from here could ever work. On Aurora it
            // cannot, because the parameter is read-only at every level.
            managed: this.variant === 'aurora-mysql',
          },
        };
      }

      const consumer = (await exec(
        conn,
        `select enabled from performance_schema.setup_consumers where name = 'statements_digest'`,
      )) as Array<{ enabled: string }>;
      if (consumer.length > 0 && String(consumer[0].enabled).toUpperCase() !== 'YES') {
        return {
          supported: false,
          reason: {
            code: 'disabled',
            detail:
              'The statements_digest consumer is off, so the server is not aggregating statements. This one can be turned on without a restart — but it reverts when the server restarts.',
            parameter: 'setup_consumers.statements_digest',
            sql: `UPDATE performance_schema.setup_consumers SET enabled = 'YES' WHERE name = 'statements_digest'`,
          },
        };
      }

      // Now the real read, for the privilege answer. SELECT on
      // performance_schema is granted separately from everything else, and
      // plenty of application users do not have it.
      await exec(
        conn,
        'select digest from performance_schema.events_statements_summary_by_digest limit 1',
      );

      return {
        supported: true,
        source: 'performance_schema',
        resettable: await this.canTruncateDigests(),
        textLimit: await this.digestTextLimit(),
        // MySQL has no per-row redaction: a user who cannot see the table
        // gets the error above rather than rows with the text removed.
        visibility: 'all',
      };
    } catch (err) {
      const user = await exec(conn, 'select current_user() as u')
        .then((r) => String((r as Array<{ u: string }>)[0].u).replace(/@.*$/, ''))
        .catch(() => undefined);
      return {
        supported: false,
        reason: classifyMysqlProbeError(err as { errno?: number; message?: string }, {
          variant: this.variant,
          user,
        }),
      };
    }
  }

  /// How much of a statement this server keeps.
  ///
  /// Two variables, and the smaller wins: max_digest_length is the buffer
  /// the digest is COMPUTED in, and performance_schema_max_digest_length is
  /// what gets STORED for display. Raising only the second changes nothing,
  /// which is the trap worth naming the pair for.
  private async digestTextLimit(): Promise<{ parameter: string; bytes: number } | null> {
    try {
      const r = (await exec(
        this.require(),
        'select @@max_digest_length as compute, @@performance_schema_max_digest_length as store',
      )) as Array<{ compute: string; store: string }>;
      const compute = Number(r[0]?.compute);
      const store = Number(r[0]?.store);
      if (!Number.isFinite(compute) || !Number.isFinite(store)) return null;
      return compute <= store
        ? { parameter: 'max_digest_length', bytes: compute }
        : { parameter: 'performance_schema_max_digest_length', bytes: store };
    } catch {
      // MariaDB does not have both of these under these names. No limit
      // reported is better than naming a variable that does not exist.
      return null;
    }
  }

  async slowQueries(opts: { limit: number }): Promise<StatementStat[]> {
    const rows = (await exec(
      this.require(),
      // Timers are PICOSECONDS. Dividing by 1e9 for milliseconds is the
      // easiest thing in this file to get wrong, because getting it wrong
      // by a thousand still produces numbers that look plausible.
      `select digest,
              digest_text,
              count_star,
              sum_timer_wait / 1e9   as total_ms,
              avg_timer_wait / 1e9   as mean_ms,
              max_timer_wait / 1e9   as max_ms,
              sum_rows_sent          as rows_returned,
              sum_rows_examined      as rows_examined,
              sum_no_index_used      as no_index_used,
              sum_select_full_join,
              sum_created_tmp_disk_tables,
              sum_errors,
              first_seen,
              last_seen
         from performance_schema.events_statements_summary_by_digest
        -- Scoped to the connected database, and DIGEST NOT NULL drops the
        -- overflow bucket: when the digest table is full, MySQL lumps
        -- everything further into one nameless row whose totals belong to
        -- no statement anyone could act on.
        where schema_name = database()
          and digest is not null
        order by sum_timer_wait desc
        limit ?`,
      [opts.limit],
    )) as Array<Record<string, string | null>>;

    // typeCast is disabled on this connection (see the file header), so
    // every column arrives as a string.
    return rows.map((row) => {
      const sql = String(row.digest_text ?? '');
      return {
      digest: String(row.digest),
      sql,
      redacted: false,
      truncated: digestTruncated(sql),
      calls: n(row.count_star) ?? 0,
      totalMs: n(row.total_ms) ?? 0,
      meanMs: n(row.mean_ms) ?? 0,
      maxMs: n(row.max_ms),
      rowsReturned: n(row.rows_returned),
      rowsExamined: n(row.rows_examined),
      noIndexUsed: n(row.no_index_used),
      extra: {
        'full joins': n(row.sum_select_full_join),
        'tmp tables on disk': n(row.sum_created_tmp_disk_tables),
        errors: n(row.sum_errors),
        'first seen': row.first_seen ?? null,
        'last seen': row.last_seen ?? null,
      },
      };
    });
  }

  /// A recent real execution of this digest, literal values intact.
  ///
  /// Two buffers, most complete first. `events_statements_history_long`
  /// holds ten thousand statements server-wide but its consumer is OFF by
  /// default; `events_statements_history` keeps only the last ten per
  /// thread and IS on by default. So the second is usually the one that
  /// answers, and usually only for statements run in the last few moments —
  /// which is why a null here is ordinary rather than a fault.
  async slowQueryExample(digest: string): Promise<string | null> {
    const limit = await this.sqlTextLimit();
    for (const table of [
      'events_statements_history_long',
      'events_statements_history',
    ]) {
      const text = await exec(
        this.require(),
        `select sql_text
           from performance_schema.${table}
          where digest = ?
            and sql_text is not null
          -- The slowest example, not the newest: a plan is worth reading
          -- for the execution that actually hurt.
          order by timer_wait desc
          limit 1`,
        [digest],
      )
        .then((r) => {
          const row = (r as Array<{ sql_text: string | null }>)[0];
          return row?.sql_text ? String(row.sql_text) : null;
        })
        // A missing table means that consumer is off. Not an error worth
        // surfacing — it is just the other buffer's turn.
        .catch(() => null);

      if (!text) continue;
      // SQL_TEXT has its own cap, and unlike DIGEST_TEXT it is cut with no
      // marker at all. A statement sitting exactly at the limit is almost
      // certainly missing its tail, and a truncated example is worse than
      // none: it parses far enough to produce a plan for a query nobody
      // ran.
      if (limit !== null && Buffer.byteLength(text, 'utf8') >= limit) continue;
      return text;
    }
    return null;
  }

  private async sqlTextLimit(): Promise<number | null> {
    return exec(this.require(), 'select @@performance_schema_max_sql_text_length as n')
      .then((r) => {
        const n = Number((r as Array<{ n: string }>)[0]?.n);
        return Number.isFinite(n) ? n : null;
      })
      .catch(() => null);
  }

  async resetSlowQueries(): Promise<void> {
    await exec(
      this.require(),
      'truncate table performance_schema.events_statements_summary_by_digest',
    );
  }

  // -------------------------------------------------------------------
  // Live health
  // -------------------------------------------------------------------

  /// The same dashboard, read out of MySQL's own vocabulary.
  ///
  /// Two things differ from Postgres and both are worth knowing. MySQL has
  /// no per-connection "is this session blocked" view outside
  /// `performance_schema.data_locks`, which is expensive on a busy server,
  /// so `blockedBy` stays empty here rather than being guessed at. And
  /// `information_schema.TABLES` reports size from the storage engine's own
  /// statistics, which on InnoDB are estimates that can be badly stale —
  /// said out loud in a note rather than presented as a measurement.
  async health(): Promise<HealthSnapshot> {
    const conn = this.require();
    const out = emptyHealth('mysql');
    const notes: string[] = [];

    const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        notes.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };

    await attempt('server', async () => {
      const rows = (await exec(
        conn,
        `select @@version as v, @@max_connections as max_conn, database() as db`,
      )) as Array<Record<string, string | number | null>>;
      const row = rows[0];
      if (!row) return;
      out.serverVersion = row.v === null ? null : String(row.v);
      out.connections = { used: 0, max: num(row.max_conn) };
    });

    await attempt('status counters', async () => {
      const rows = (await exec(
        conn,
        `show global status where Variable_name in
           ('Uptime','Threads_connected','Innodb_buffer_pool_read_requests',
            'Innodb_buffer_pool_reads','Com_commit','Com_rollback')`,
      )) as Array<{ Variable_name: string; Value: string }>;
      const stat = new Map(rows.map((r) => [r.Variable_name, Number(r.Value)]));

      out.uptimeSeconds = stat.get('Uptime') ?? null;
      if (out.connections) out.connections.used = stat.get('Threads_connected') ?? 0;

      const requests = stat.get('Innodb_buffer_pool_read_requests') ?? 0;
      const disk = stat.get('Innodb_buffer_pool_reads') ?? 0;
      out.cacheHitRatio = requests > 0 ? (requests - disk) / requests : null;

      const commit = stat.get('Com_commit');
      const rollback = stat.get('Com_rollback');
      if (commit !== undefined && rollback !== undefined) {
        out.transactions = { committed: commit, rolledBack: rollback };
      }
    });

    await attempt('sessions', async () => {
      const rows = (await exec(
        conn,
        `select ID as id, USER as usr, HOST as host, DB as db, COMMAND as cmd,
                STATE as state, TIME as secs, INFO as query
           from information_schema.PROCESSLIST
          order by COMMAND = 'Query' desc, TIME desc
          limit 500`,
      )) as Array<Record<string, string | number | null>>;
      const self = (
        (await exec(conn, 'select connection_id() as id')) as Array<{ id: number | string }>
      )[0]?.id;
      out.sessions = rows.map((row) => ({
        id: String(row.id),
        user: row.usr === null ? null : String(row.usr),
        // MySQL has no application_name; the closest thing is the host the
        // client dialled in from, which is already its own field.
        application: null,
        clientAddress: row.host === null ? null : String(row.host),
        database: row.db === null ? null : String(row.db),
        // 'Sleep' is MySQL's idle. Translated so one dashboard reads the
        // same across engines, with the server's own STATE kept beside it.
        state: row.cmd === 'Sleep' ? 'idle' : row.cmd === 'Query' ? 'active' : String(row.cmd ?? ''),
        waitEvent: row.state === null || row.state === '' ? null : String(row.state),
        query: row.query === null ? null : String(row.query),
        seconds: num(row.secs),
        isSelf: String(row.id) === String(self),
        blockedBy: [],
      }));
      // `used` stays whatever Threads_connected said: this list is capped
      // at 500 rows, so counting it would under-report a server that is
      // actually near its ceiling — the one case the number exists for.
    });

    await attempt('table sizes', async () => {
      const rows = (await exec(
        conn,
        `select TABLE_SCHEMA as sch, TABLE_NAME as tbl,
                DATA_LENGTH as bytes, INDEX_LENGTH as index_bytes, TABLE_ROWS as rows
           from information_schema.TABLES
          where TABLE_SCHEMA = database() and TABLE_TYPE = 'BASE TABLE'
          order by (coalesce(DATA_LENGTH,0) + coalesce(INDEX_LENGTH,0)) desc
          limit 50`,
      )) as Array<Record<string, string | number | null>>;
      out.tables = rows.map((row) => ({
        schema: String(row.sch),
        table: String(row.tbl),
        bytes: num(row.bytes) ?? 0,
        indexBytes: num(row.index_bytes),
        estimatedRows: num(row.rows),
      }));
      if (out.tables.length > 0) {
        notes.push(
          'Sizes and row counts come from InnoDB’s own statistics, which are estimates and can be well out of date. ANALYZE TABLE refreshes them.',
        );
      }
      out.databaseBytes = out.tables.reduce((sum, t) => sum + t.bytes + (t.indexBytes ?? 0), 0);
    });

    await attempt('index usage', async () => {
      // sys.schema_unused_indexes is a view over performance_schema; it is
      // absent when performance_schema is off, which is exactly the case
      // the attempt wrapper turns into a note.
      const rows = (await exec(
        conn,
        `select object_schema as sch, object_name as tbl, index_name as idx
           from sys.schema_unused_indexes
          where object_schema = database()
          limit 50`,
      )) as Array<Record<string, string | null>>;
      out.unusedIndexes = rows.map((row) => ({
        schema: String(row.sch),
        table: String(row.tbl),
        index: String(row.idx),
        scans: 0,
        bytes: null,
        unique: false,
      }));
    });

    await attempt('scan counts', async () => {
      const rows = (await exec(
        conn,
        `select object_schema as sch, object_name as tbl,
                count_read as reads, rows_read as rows_read
           from performance_schema.table_io_waits_summary_by_table
          where object_schema = database() and rows_read > 0
          order by rows_read desc
          limit 50`,
      )) as Array<Record<string, string | number | null>>;
      // MySQL does not separate sequential from indexed access at the table
      // level the way pg_stat_user_tables does. What it has is rows read
      // per table, which answers the same question — "what is being read
      // hardest" — and is reported as that rather than dressed up as a
      // seq-scan count.
      out.sequentialScans = rows.map((row) => ({
        schema: String(row.sch),
        table: String(row.tbl),
        sequentialScans: num(row.reads) ?? 0,
        sequentialRowsRead: num(row.rows_read) ?? 0,
        indexScans: 0,
        estimatedRows: null,
      }));
      if (rows.length > 0) {
        notes.push(
          'MySQL counts rows read per table rather than sequential scans, so this list is “read hardest”, not “scanned end to end”.',
        );
      }
    });

    await attempt('replication', async () => {
      const rows = (await exec(conn, 'show replicas')) as Array<Record<string, string | number>>;
      out.replication = rows.map((row) => ({
        client: String(row.Host ?? row.Server_id ?? ''),
        state: null,
        // SHOW REPLICAS reports position, not a byte lag, and computing one
        // needs the replica's own view. Left null rather than invented.
        lagBytes: null,
      }));
    });

    return { ...out, notes };
  }

  /// KILL QUERY stops the statement; KILL closes the connection.
  async killSession(id: string, opts: { terminate: boolean }): Promise<{ ok: boolean; error?: string }> {
    try {
      // The id is interpolated because KILL takes no placeholders — so it
      // is checked to be digits, which every MySQL thread id is.
      if (!/^\d+$/.test(id)) return { ok: false, error: `${id} is not a thread id.` };
      await exec(this.require(), `kill ${opts.terminate ? '' : 'query '}${id}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /// Read from SHOW GRANTS rather than attempted.
  ///
  /// There is no information_schema view that answers "may I truncate this
  /// performance_schema table", and the only direct test is to truncate it
  /// — which destroys the history whenever the answer is yes. So the grants
  /// are parsed, and a parse that is unsure says no: a Reset button that
  /// errors is worse than an absent one, and the client-side baseline
  /// already covers the workflow without it.
  private canTruncateDigests(): Promise<boolean> {
    return exec(this.require(), 'show grants for current_user()')
      .then((r) =>
        mysqlCanTruncateDigests(
          (r as Array<Record<string, string>>).map((row) => String(Object.values(row)[0])),
        ),
      )
      .catch(() => false);
  }

  private require(): MysqlConnection {
    // The dead-socket case first: `this.conn` is still an object after the
    // server hung up, so without this the driver's own complaint ("Can't
    // add new command when connection is in closed state") is what reached
    // the user, which reads like a bug in the app rather than a connection
    // that needs reopening.
    if (this.fatal) {
      throw new Error(`the mysql connection was lost (${this.fatal.message}) — reconnect to continue`);
    }
    if (!this.conn) throw new Error('mysql adapter is not connected');
    return this.conn;
  }
}

/// TRUNCATE needs the DROP privilege, on `*.*` or on performance_schema
/// specifically. Anything narrower does not reach the digest table.
export function mysqlCanTruncateDigests(grants: string[]): boolean {
  return grants.some((g) => {
    const m = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b/i.exec(g.trim());
    if (!m) return false;
    const privileges = m[1].toUpperCase();
    const scope = m[2].toLowerCase().replace(/[`"']/g, '');
    if (scope !== '*.*' && scope !== 'performance_schema.*') return false;
    // "ALL PRIVILEGES" includes DROP. Matching \bDROP\b rather than a
    // substring so that GRANT OPTION and role names containing "drop" do
    // not read as the privilege.
    return /\bALL PRIVILEGES\b/.test(privileges) || /\bDROP\b/.test(privileges);
  });
}

/// Counters arrive as text on this connection, and `Number(null)` is 0 —
/// which is a real count, not a missing one.
function n(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// mysql2's callback API, promisified narrowly. The promise wrapper is
// avoided on purpose: streaming needs the raw Query event emitter.

function open(
  config: Record<string, unknown>,
  onFatal: (err: Error) => void,
): Promise<MysqlConnection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(config as never);
    // mysql2 emits 'error' on the connection itself when the socket dies
    // under an idle session — ETIMEDOUT through a NAT that dropped the
    // mapping, ECONNRESET when a VPN blinks. With no listener that is an
    // unhandled 'error' event, and an unhandled 'error' event takes the
    // whole host process down: every in-flight request dies with it, the
    // window says nothing, and the next click lands on a corpse. Recorded
    // instead, so the failure comes back as a sentence on the next call.
    conn.on('error', (err: Error) => onFatal(err));
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

/// MySQL hands counters back as numbers or as strings depending on the
/// column's type; a bigint arrives as a string so it is not silently made
/// lossy. Neither is a number until it is made one, and an absent counter
/// must stay absent rather than becoming zero.
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function exec(conn: MysqlConnection, sql: string, values: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values } as QueryOptions, (err, rows) =>
      err ? reject(err) : resolve(rows),
    );
  });
}

function end(conn: MysqlConnection | null): Promise<void> {
  if (!conn) return Promise.resolve();
  return new Promise((resolve) => conn.end(() => resolve()));
}
