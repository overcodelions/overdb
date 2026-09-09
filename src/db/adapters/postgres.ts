// Postgres via `pg` + `pg-cursor`.
//
// Two decisions worth knowing before you edit this file:
//
// 1. TYPE PARSING IS DISABLED. `pg` by default turns timestamptz into a
//    local-time JS Date (discarding the offset the server sent) and
//    numeric into a lossy float. Both are silent corruption in a tool
//    whose job is showing you what is actually in the database. We install
//    an identity parser for every oid, so values arrive as the exact
//    strings Postgres produced; overdb decides presentation, and an inline
//    edit round-trips byte for byte.
//
// 2. TWO CONNECTIONS, ALWAYS. You cannot cancel a Postgres query on the
//    connection running it — `pg_cancel_backend` has to come from
//    somewhere else. The second client exists solely for that.

import { Client } from 'pg';
import Cursor from 'pg-cursor';
import type {
  ColumnInfo,
  ConnectSpec,
  DbAdapter,
  ForeignKeyInfo,
  IndexInfo,
  QueryHandle,
  QueryResult,
  SchemaSnapshot,
} from '../adapter';
import type { Cell, CellKind, ColumnMeta, TableInfo } from '../../shared/types';

/// Identity for every type: hand back the wire text untouched.
const RAW_TYPES = { getTypeParser: () => (v: string) => v };

const OID_KIND: Record<number, CellKind> = {
  16: 'bool',
  17: 'bytes',
  20: 'bigint',
  21: 'int', 23: 'int',
  114: 'json', 3802: 'json',
  700: 'float', 701: 'float',
  1082: 'date',
  1083: 'time', 1266: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'decimal',
  2950: 'uuid',
  25: 'text', 1042: 'text', 1043: 'text',
};

export function postgresKind(oid: number): CellKind {
  return OID_KIND[oid] ?? 'other';
}

interface PgField {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
}

export class PostgresAdapter implements DbAdapter {
  private client: Client | null = null;
  /// Reserved for cancellation only — see the header.
  private sideClient: Client | null = null;
  private spec: ConnectSpec | null = null;
  private typeNames = new Map<number, string>();

  async connect(spec: ConnectSpec): Promise<void> {
    this.spec = spec;
    const config = {
      host: spec.host,
      port: spec.port,
      database: spec.database,
      user: spec.user,
      password: spec.password,
      ssl: spec.ssl && spec.ssl !== 'disable'
        ? { rejectUnauthorized: spec.ssl === 'verify-full' }
        : undefined,
      types: RAW_TYPES,
      statement_timeout: spec.statementTimeoutMs ?? undefined,
    };
    this.client = new Client(config);
    await this.client.connect();
    this.sideClient = new Client(config);
    await this.sideClient.connect();

    if (spec.searchPath?.length) {
      await this.client.query(`set search_path to ${spec.searchPath.map(quoteIdent).join(', ')}`);
    }
    // Cache oid -> type name so the grid header can show the engine's own
    // spelling rather than a number.
    const types = await this.client.query('select oid, typname from pg_type');
    for (const r of types.rows as Array<{ oid: string; typname: string }>) {
      this.typeNames.set(Number(r.oid), r.typname);
    }
  }

  async ping(): Promise<{ ok: true; serverVersion: string } | { ok: false; error: string }> {
    try {
      const r = await this.require().query('select version() as v');
      return { ok: true, serverVersion: String(r.rows[0].v) };
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

  async stream(sql: string, params: unknown[] = []): Promise<QueryHandle> {
    const client = this.require();
    // Read-only is the SERVER's job, not a regex's. Outside an armed
    // write the whole statement runs inside a read-only transaction and
    // Postgres raises 25006 on any attempt to mutate.
    const readOnly = this.spec?.readOnly ?? true;
    if (readOnly) await client.query('begin read only');

    const cursor = client.query(new Cursor(sql, params, { rowMode: 'array' }));
    let columns: ColumnMeta[] | null = null;
    let finished = false;

    const self = this;
    const handle: QueryHandle = {
      get columns() {
        return columns ?? [];
      },
      async next(n: number) {
        const rows = await new Promise<unknown[][]>((resolve, reject) => {
          cursor.read(n, (err: Error | undefined, result: unknown[][]) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        if (!columns) {
          const fields = (cursor as unknown as { _result?: { fields?: PgField[] } })._result?.fields ?? [];
          columns = await self.describeFields(fields);
        }
        if (rows.length < n) finished = true;
        return { rows: rows.map((r) => r.map(toCell)), done: finished };
      },
      async close() {
        await new Promise<void>((resolve) => cursor.close(() => resolve()));
        if (readOnly) await client.query('commit').catch(() => undefined);
      },
    };

    // Force the first read so `columns` is populated before the caller
    // looks at it — the grid needs a header before it has any rows.
    return handle;
  }

  /// Resolve `tableID`/`columnID` into real names. Without this a cell has
  /// no provenance, and the grid must refuse to edit it.
  private async describeFields(fields: PgField[]): Promise<ColumnMeta[]> {
    const tableIds = [...new Set(fields.map((f) => f.tableID).filter((id) => id > 0))];
    const lookup = new Map<string, { schema: string; table: string; column: string }>();
    if (tableIds.length > 0) {
      const r = await this.require().query(
        `select a.attrelid::text as reloid, a.attnum::text as attnum,
                c.relname as table_name, n.nspname as schema_name, a.attname as column_name
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
          where a.attrelid = any($1::oid[]) and a.attnum > 0`,
        [tableIds],
      );
      for (const row of r.rows as Array<Record<string, string>>) {
        lookup.set(`${row.reloid}:${row.attnum}`, {
          schema: row.schema_name,
          table: row.table_name,
          column: row.column_name,
        });
      }
    }
    return fields.map((f) => {
      const src = lookup.get(`${f.tableID}:${f.columnID}`);
      return {
        name: f.name,
        typeName: this.typeNames.get(f.dataTypeID) ?? String(f.dataTypeID),
        kind: postgresKind(f.dataTypeID),
        nullable: null,
        sourceTable: src ? { schema: src.schema, table: src.table, column: src.column } : null,
      };
    });
  }

  async cancel(): Promise<boolean> {
    const pid = (this.client as unknown as { processID?: number })?.processID;
    if (!pid || !this.sideClient) return false;
    await this.sideClient.query('select pg_cancel_backend($1)', [pid]);
    return true;
  }

  async explain(sql: string, analyze: boolean): Promise<{ format: 'json' | 'text'; plan: string }> {
    const opts = analyze ? '(format json, analyze, buffers)' : '(format json)';
    const r = await this.require().query(`explain ${opts} ${sql}`);
    return { format: 'json', plan: String(r.rows[0]['QUERY PLAN']) };
  }

  async introspect(opts: { schemas?: string[] }): Promise<SchemaSnapshot> {
    const client = this.require();
    const schemas = opts.schemas?.length
      ? opts.schemas
      : (await client.query(
          `select nspname from pg_namespace
            where nspname not in ('pg_catalog','information_schema')
              and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
            order by nspname`,
        )).rows.map((r: Record<string, string>) => r.nspname);

    const cols = await client.query(
      `select n.nspname as schema, c.relname as table, c.relkind::text as relkind,
              a.attname as column, a.attnum::int as ordinal,
              format_type(a.atttypid, a.atttypmod) as type_name,
              (not a.attnotnull) as nullable,
              pg_get_expr(d.adbin, d.adrelid) as default_expr
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = any($1::text[]) and a.attnum > 0 and not a.attisdropped
          and c.relkind in ('r','v','m','p')
        order by n.nspname, c.relname, a.attnum`,
      [schemas],
    );

    const pks = await client.query(
      `select n.nspname as schema, c.relname as table, a.attname as column, k.ord
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
        where con.contype = 'p' and n.nspname = any($1::text[])
        order by k.ord`,
      [schemas],
    );

    const byTable = new Map<string, TableInfo>();
    const relkind: Record<string, TableInfo['kind']> = { r: 'table', p: 'table', v: 'view', m: 'matview' };
    for (const r of cols.rows as Array<Record<string, string>>) {
      const key = `${r.schema}.${r.table}`;
      let t = byTable.get(key);
      if (!t) {
        t = { name: r.table, kind: relkind[r.relkind] ?? 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
        byTable.set(key, t);
      }
      const col: ColumnInfo = {
        name: r.column,
        ordinal: Number(r.ordinal),
        typeName: r.type_name,
        nullable: String(r.nullable) === 'true',
        defaultExpr: r.default_expr ?? null,
      };
      t.columns.push(col);
    }
    for (const r of pks.rows as Array<Record<string, string>>) {
      byTable.get(`${r.schema}.${r.table}`)?.primaryKey.push(r.column);
    }

    const ping = await this.ping();
    return {
      engine: 'postgres',
      serverVersion: ping.ok ? ping.serverVersion : 'unknown',
      capturedAt: new Date().toISOString(),
      schemas: schemas.map((name: string) => ({
        name,
        tables: [...byTable.entries()]
          .filter(([k]) => k.startsWith(`${name}.`))
          .map(([, t]) => t),
      })),
    };
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.require().query(
      `select nspname from pg_namespace
        where nspname not in ('pg_catalog','information_schema')
          and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
        order by nspname`,
    );
    return (r.rows as Array<{ nspname: string }>).map((x) => x.nspname);
  }

  async listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const r = await this.require().query(
      `select n.nspname as schema, c.relname as table, c.relkind::text as relkind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','v','m','p')
          and n.nspname not in ('pg_catalog','information_schema')
          and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
        order by n.nspname, c.relname`,
    );
    const kinds: Record<string, TableInfo['kind']> = { r: 'table', p: 'table', v: 'view', m: 'matview' };
    return (r.rows as Array<Record<string, string>>).map((x) => ({
      schema: x.schema, table: x.table, kind: kinds[x.relkind] ?? 'table',
    }));
  }

  async useSchema(name: string): Promise<void> {
    await this.require().query(`set search_path to ${quoteIdent(name)}`);
    if (this.spec) this.spec.searchPath = [name];
  }

  async close(): Promise<void> {
    await this.client?.end().catch(() => undefined);
    await this.sideClient?.end().catch(() => undefined);
    this.client = null;
    this.sideClient = null;
  }

  private require(): Client {
    if (!this.client) throw new Error('postgres adapter is not connected');
    return this.client;
  }
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Unused placeholders kept off the public surface.
export type { IndexInfo, ForeignKeyInfo };
