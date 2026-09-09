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
  TableInfo,
} from '../adapter';
import type { Cell, CellKind, ColumnMeta } from '../../shared/types';

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

  async connect(spec: ConnectSpec): Promise<void> {
    this.spec = spec;
    const config = {
      host: spec.host ?? '127.0.0.1',
      port: spec.port ?? 3306,
      database: spec.database,
      user: spec.user,
      password: spec.password,
      ssl: spec.ssl && spec.ssl !== 'disable'
        ? { rejectUnauthorized: spec.ssl === 'verify-full' }
        : undefined,
      // Values must arrive as sent; see rawTypeCast.
      typeCast: rawTypeCast as unknown as QueryOptions['typeCast'],
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    };
    this.conn = await open(config);
    this.sideConn = await open(config);
    if (spec.statementTimeoutMs) {
      // MariaDB spells this max_statement_time and takes SECONDS as a
      // float; MySQL uses max_execution_time in milliseconds. Try each and
      // let the other fail — a missing timeout must not block connecting.
      const seconds = spec.statementTimeoutMs / 1000;
      await exec(this.conn, `set session max_statement_time = ${seconds}`).catch(() => undefined);
      await exec(this.conn, `set session max_execution_time = ${spec.statementTimeoutMs}`).catch(() => undefined);
    }
  }

  async ping(): Promise<{ ok: true; serverVersion: string } | { ok: false; error: string }> {
    try {
      const rows = (await exec(this.require(), 'select version() as v')) as Array<{ v: string }>;
      return { ok: true, serverVersion: String(rows[0].v) };
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

  async stream(sql: string, params: unknown[] = []): Promise<QueryHandle> {
    const conn = this.require();
    // Read-only is the SERVER's job. Outside an armed write the statement
    // runs inside a read-only transaction and the server rejects any
    // mutation with ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION.
    const readOnly = this.spec?.readOnly ?? true;
    if (readOnly) await exec(conn, 'start transaction read only');

    const q = conn.query({ sql, values: params, rowsAsArray: true } as QueryOptions);
    let columns: ColumnMeta[] = [];
    q.on('fields', (fields: FieldPacket[]) => {
      columns = mapFields(fields);
    });

    const stream = q.stream({ highWaterMark: 1024 });
    let ended = false;
    let failure: Error | null = null;
    stream.on('end', () => {
      ended = true;
    });
    stream.on('error', (err: Error) => {
      failure = err;
      ended = true;
    });

    return {
      get columns() {
        return columns;
      },
      async next(n: number) {
        const rows: Cell[][] = [];
        while (rows.length < n) {
          if (failure) throw failure;
          const row = stream.read() as Cell[] | null;
          if (row !== null) {
            rows.push(row);
            continue;
          }
          if (ended) break;
          // Nothing buffered and not finished: wait for whichever comes
          // first. Racing them is what keeps this a pull, not a firehose.
          await new Promise<void>((resolve) => {
            const done = () => {
              stream.off('readable', done);
              stream.off('end', done);
              stream.off('error', done);
              resolve();
            };
            stream.once('readable', done);
            stream.once('end', done);
            stream.once('error', done);
          });
        }
        if (failure) throw failure;
        return { rows, done: ended && stream.readableLength === 0 };
      },
      async close() {
        stream.destroy();
        if (readOnly) await exec(conn, 'commit').catch(() => undefined);
      },
    };
  }

  async cancel(): Promise<boolean> {
    const threadId = (this.conn as unknown as { threadId?: number })?.threadId;
    if (!threadId || !this.sideConn) return false;
    await exec(this.sideConn, `kill query ${Number(threadId)}`);
    return true;
  }

  async explain(sql: string, _analyze: boolean): Promise<{ format: 'json' | 'text'; plan: string }> {
    const rows = (await exec(this.require(), `explain format=json ${sql}`)) as Array<Record<string, unknown>>;
    const first = rows[0] ?? {};
    const value = first.EXPLAIN ?? Object.values(first)[0];
    return { format: 'json', plan: typeof value === 'string' ? value : JSON.stringify(value) };
  }

  async introspect(opts: { schemas?: string[] }): Promise<SchemaSnapshot> {
    const conn = this.require();
    const schemas = opts.schemas?.length
      ? opts.schemas
      : this.spec?.database
        ? [this.spec.database]
        : ((await exec(
            conn,
            `select schema_name from information_schema.schemata
              where schema_name not in ('information_schema','performance_schema','mysql','sys')
              order by schema_name`,
          )) as Array<{ schema_name: string }>).map((r) => r.schema_name);

    if (schemas.length === 0) {
      return { engine: 'mysql', serverVersion: 'unknown', capturedAt: new Date().toISOString(), schemas: [] };
    }
    const placeholders = schemas.map(() => '?').join(',');

    const cols = (await exec(
      conn,
      `select c.table_schema, c.table_name, t.table_type, c.column_name,
              c.ordinal_position, c.column_type, c.is_nullable, c.column_default
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema in (${placeholders})
        order by c.table_schema, c.table_name, c.ordinal_position`,
      schemas,
    )) as Array<Record<string, string>>;

    const keys = (await exec(
      conn,
      `select table_schema, table_name, column_name, seq_in_index, index_name, non_unique
         from information_schema.statistics
        where table_schema in (${placeholders})
        order by table_schema, table_name, index_name, seq_in_index`,
      schemas,
    )) as Array<Record<string, string>>;

    const fks = (await exec(
      conn,
      `select table_schema, table_name, constraint_name, column_name,
              referenced_table_schema, referenced_table_name, referenced_column_name
         from information_schema.key_column_usage
        where table_schema in (${placeholders}) and referenced_table_name is not null
        order by table_schema, table_name, constraint_name, ordinal_position`,
      schemas,
    )) as Array<Record<string, string>>;

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
        table.primaryKey.push(r.column_name);
        continue;
      }
      const ikey = `${r.table_schema}.${r.table_name}.${r.index_name}`;
      let ix = indexAcc.get(ikey);
      if (!ix) {
        ix = { name: r.index_name, columns: [], unique: String(r.non_unique) === '0' };
        indexAcc.set(ikey, ix);
        table.indexes.push(ix);
      }
      ix.columns.push(r.column_name);
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
    const rows = (await exec(
      this.require(),
      `select schema_name from information_schema.schemata
        where schema_name not in ('information_schema','performance_schema','mysql','sys')
        order by schema_name`,
    )) as Array<{ schema_name: string }>;
    return rows.map((r) => r.schema_name);
  }

  async listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const rows = (await exec(
      this.require(),
      `select table_schema, table_name, table_type from information_schema.tables
        where table_schema not in ('information_schema','performance_schema','mysql','sys')
        order by table_schema, table_name`,
    )) as Array<Record<string, string>>;
    return rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      kind: r.table_type === 'VIEW' ? 'view' : 'table',
    }));
  }

  async useSchema(name: string): Promise<void> {
    // Switch BOTH connections: the side connection issues KILL QUERY and
    // introspection reads from the primary, and leaving them pointed at
    // different databases is the kind of split-brain that produces a bug
    // report nobody can reproduce.
    const quoted = '`' + name.replace(/`/g, '``') + '`';
    await exec(this.require(), `use ${quoted}`);
    if (this.sideConn) await exec(this.sideConn, `use ${quoted}`);
    if (this.spec) this.spec.database = name;
  }

  async close(): Promise<void> {
    await end(this.conn);
    await end(this.sideConn);
    this.conn = null;
    this.sideConn = null;
  }

  private require(): MysqlConnection {
    if (!this.conn) throw new Error('mysql adapter is not connected');
    return this.conn;
  }
}

// mysql2's callback API, promisified narrowly. The promise wrapper is
// avoided on purpose: streaming needs the raw Query event emitter.

function open(config: Record<string, unknown>): Promise<MysqlConnection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(config as never);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
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
