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
  StreamOptions,
} from '../adapter';
import type { Cell, CellKind, ColumnMeta, TableInfo } from '../../shared/types';
import { tlsOptions } from '../tls';
import { detectVariant, isRedshift } from '../../shared/engines';
import type { Variant } from '../../shared/engines';
import { classifyPgProbeError, PG_REDACTED } from '../../shared/slowQueries';
import {
  emptyHealth,
  type HealthPanel,
  type HealthScope,
  type HealthSnapshot,
  type PressureCounters,
} from '../../shared/health';
import type { SlowQuerySupport, StatementStat } from '../../shared/slowQueries';

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
  /// Set by ping(), which connect() always calls. Everything that has to
  /// behave differently on a Postgres-compatible server reads this rather
  /// than sniffing version strings at the call site.
  private variant: Variant = 'postgres';
  /// True between beginTransaction() and commit()/rollback().
  private txnOpen = false;
  /// Our own pid on a Redshift cluster. STV_SESSIONS has no equivalent of
  /// `pid = pg_backend_pid()` to select on, so it is read once per health
  /// snapshot and compared in memory — offering to kill the session you are
  /// reading the list through is the trap this avoids.
  private redshiftSelfPid: string | null = null;
  /// The connection-level error that ended this session, if one did. Set
  /// from the client's own 'error' event; see `connect`.
  private fatal: Error | null = null;

  async connect(spec: ConnectSpec): Promise<void> {
    this.spec = spec;
    const config = {
      host: spec.host,
      port: spec.port,
      database: spec.database,
      user: spec.user,
      password: spec.password,
      ssl: tlsOptions(spec),
      types: RAW_TYPES,
      statement_timeout: spec.statementTimeoutMs ?? undefined,
    };
    this.fatal = null;
    // pg emits 'error' on the client when the backend goes away between
    // statements ("Connection terminated unexpectedly", an idle TCP session
    // reset). Unlistened, that is an unhandled 'error' event and it kills
    // the host process outright — taking every in-flight request with it
    // and leaving the window with nothing to show. Held as state instead;
    // see `require`.
    const onFatal = (err: Error) => {
      this.fatal = err;
    };
    this.client = new Client(config);
    this.client.on('error', onFatal);
    await this.client.connect();
    this.sideClient = new Client(config);
    this.sideClient.on('error', onFatal);
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

  async ping(): Promise<{ ok: true; serverVersion: string; variant: Variant } | { ok: false; error: string }> {
    try {
      const client = this.require();
      const r = await client.query('select version() as v');
      const version = String(r.rows[0].v);

      // Aurora and Timescale are invisible in version() — both report a
      // stock PostgreSQL string — so each needs its own probe. Both are
      // allowed to fail: that failure IS the answer everywhere else.
      const auroraVersion = await client
        .query('select aurora_version() as v')
        .then((x) => String((x.rows[0] as { v: string }).v))
        .catch(() => null);
      const hasTimescale = await client
        .query("select 1 from pg_extension where extname = 'timescaledb'")
        .then((x) => x.rows.length > 0)
        .catch(() => false);

      this.variant = detectVariant('postgres', { version, auroraVersion, hasTimescale });
      return { ok: true, serverVersion: version, variant: this.variant };
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
    const client = this.require();
    // Read-only is the SERVER's job, not a regex's. Outside an armed
    // write the whole statement runs inside a read-only transaction and
    // Postgres raises 25006 on any attempt to mutate.
    // A manual transaction, once open, owns everything — reads included.
    // Wrapping a read in its own transaction while one is open would hide
    // the uncommitted work the user opened it to see.
    const inTxn = this.txnOpen;
    const readOnly = !inTxn && (this.spec?.readOnly ?? true) && !opts.write;
    if (readOnly) await client.query('begin read only');
    // Auto-commit write: its own transaction, closed when the handle is.
    else if (!inTxn && opts.write) await client.query('begin');
    const ownsTxn = !inTxn;

    const cursor = client.query(new Cursor(sql, params, { rowMode: 'array' }));
    let columns: ColumnMeta[] | null = null;
    let finished = false;
    let closed = false;

    /// pg-cursor's own state machine. We have to read it because its
    /// close() is not safe to await in every state — see closeCursor().
    const cursorState = () => (cursor as unknown as { state?: string }).state;

    /// The reason this is not just `cursor.close()`:
    ///
    /// After a failed statement pg-cursor is in state 'error'. Its close()
    /// then sends a Close-portal message, deliberately skips the Sync that
    /// would make the server answer it, and waits for a ReadyForQuery that
    /// has ALREADY been emitted — so the callback never fires. Awaiting it
    /// hangs forever, which means the `commit` below never runs and the
    /// transaction this statement opened stays open and aborted. Every
    /// later statement on the connection — currentSchema, introspection,
    /// the next query — then fails with "current transaction is aborted,
    /// commands ignored until end of transaction block" until the whole
    /// connection is restarted.
    ///
    /// In that state there is nothing to close anyway: ending the
    /// transaction discards the portal with it. The timeout covers the
    /// same class of bug in states we can't enumerate — a stuck close must
    /// never cost us the rollback.
    const closeCursor = async () => {
      const st = cursorState();
      if (st === 'error' || st === 'done' || st === 'initialized') return;
      await Promise.race([
        new Promise<void>((resolve) => cursor.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
      ]);
    };

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
        // Callers close on both the happy and the error path, and the
        // error path closes again in a finally. Ending the same
        // transaction twice would end the NEXT statement's one.
        if (closed) return;
        closed = true;
        await closeCursor().catch(() => undefined);
        // Only the transaction this statement opened. A manual one belongs
        // to the user until they commit or roll it back.
        if (!ownsTxn) return;
        // A failed statement leaves the transaction aborted, where COMMIT
        // is a rollback wearing a misleading name. Say what happens.
        const end = cursorState() === 'error' ? 'rollback' : 'commit';
        await client.query(end).catch(() => undefined);
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
    // NEVER this.client: it is holding an open cursor, and node-postgres
    // serialises per connection — a query here would wait on a portal that
    // is waiting on us.
    if (tableIds.length > 0 && this.sideClient) {
      // Interpolated, not bound: Redshift has no array types, so
      // `= any($1::oid[])` is a syntax error there rather than a fast
      // path — and this runs on the first read of EVERY query, so an
      // error here is the whole connection failing, not just provenance.
      // These are integers the driver handed us, not user text.
      const r = await this.sideClient.query(
        `select a.attrelid::text as reloid, a.attnum::text as attnum,
                c.relname as table_name, n.nspname as schema_name, a.attname as column_name
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
          where a.attrelid in (${tableIds.map((id) => Number(id)).join(',')}) and a.attnum > 0`,
      ).catch(() => ({ rows: [] as Array<Record<string, string>> }));
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
    // Redshift has no pg_cancel_backend(); it spells this CANCEL <pid>,
    // which takes no parameters, hence the interpolation of a number we
    // got from the driver rather than from anything user-supplied.
    // Returning false here would be worse than throwing: it sends the
    // supervisor straight to killing the host, dropping a connection that
    // did not need dropping.
    if (isRedshift(this.variant)) await this.sideClient.query(`cancel ${Number(pid)}`);
    else await this.sideClient.query('select pg_cancel_backend($1)', [pid]);
    return true;
  }

  async explain(
    sql: string,
    analyze: boolean,
    params?: unknown[],
  ): Promise<{ format: 'json' | 'text'; plan: string }> {
    const guard = analyze && !this.txnOpen && (this.spec?.readOnly ?? true);
    if (guard) await this.require().query('begin read only');
    try {
      // Redshift's EXPLAIN takes no options at all — no FORMAT JSON, no
      // ANALYZE, no BUFFERS — and returns one text row per plan line.
      if (isRedshift(this.variant)) {
        const r = await this.require().query(`explain ${sql}`, params);
        return {
          format: 'text',
          plan: (r.rows as Array<Record<string, string>>)
            .map((row) => String(Object.values(row)[0]))
            .join('\n'),
        };
      }
      const opts = analyze ? '(format json, analyze, buffers)' : '(format json)';
      const r = await this.require().query(`explain ${opts} ${sql}`, params);
      return { format: 'json', plan: String(r.rows[0]['QUERY PLAN']) };
    } finally {
      if (guard) await this.require().query('commit').catch(() => undefined);
    }
  }

  async introspect(opts: { schemas?: string[]; tables?: string[] }): Promise<SchemaSnapshot> {
    const client = this.require();
    const schemas = opts.schemas?.length ? opts.schemas : await this.listSchemas();

    const byTable = isRedshift(this.variant)
      ? await this.redshiftColumns(schemas)
      : await this.postgresColumns(schemas);

    // Redshift is forked from PostgreSQL 8.0 and supports neither LATERAL
    // nor WITH ORDINALITY, so the fast pg_constraint route errors outright
    // there. information_schema is slower and present on both.
    //
    // And either way this is wrapped: a catalog that will not give up its
    // primary keys should cost primary keys — which means no inline editing
    // — and not the entire introspection, which is what makes completion
    // silently stop working on a connection that is otherwise fine.
    const pkRows = await (isRedshift(this.variant)
      ? client.query(
          `select tc.table_schema as schema, tc.table_name as table,
                  kcu.column_name as column
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu
               on kcu.constraint_name = tc.constraint_name
              and kcu.table_schema = tc.table_schema
            where tc.constraint_type = 'PRIMARY KEY'
              and tc.table_schema in (${sqlLiteralList(schemas)})
            order by kcu.ordinal_position`,
        )
      : client.query(
          `select n.nspname as schema, c.relname as table, a.attname as column, k.ord
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
             join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
            where con.contype = 'p' and n.nspname = any($1::text[])
            order by k.ord`,
          [schemas],
        )
    ).catch(() => ({ rows: [] as Array<Record<string, string>> }));

    for (const r of pkRows.rows as Array<Record<string, string>>) {
      byTable.get(`${r.schema}.${r.table}`)?.primaryKey.push(r.column);
    }

    // Indexes and foreign keys, on the same terms as the primary keys
    // above: wrapped, because a catalog that will not give them up should
    // cost those things and not the whole introspection.
    //
    // Skipped entirely on Redshift, which has no indexes at all and neither
    // LATERAL nor WITH ORDINALITY to ask with. An empty list there is the
    // TRUE answer rather than a gap — nothing is being hidden.
    if (!isRedshift(this.variant)) {
      const ixRows = await client
        .query(
          // `pg_get_indexdef` per column is what makes an EXPRESSION index
          // readable: `attname` is null for one, and this returns the
          // expression text instead of a hole. Same shape as the MySQL
          // adapter's `expression` handling, for the same reason — an
          // index nothing can name is one the comparison has to drop.
          `select n.nspname as schema, t.relname as table, i.relname as index,
                  ix.indisunique as uniq,
                  coalesce(a.attname, pg_get_indexdef(ix.indexrelid, k.ord::int, true)) as column,
                  k.ord
             from pg_index ix
             join pg_class i on i.oid = ix.indexrelid
             join pg_class t on t.oid = ix.indrelid
             join pg_namespace n on n.oid = t.relnamespace
             join lateral unnest(ix.indkey) with ordinality as k(attnum, ord) on true
             left join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
            where n.nspname = any($1::text[]) and not ix.indisprimary
            order by n.nspname, t.relname, i.relname, k.ord`,
          [schemas],
        )
        .catch(() => ({ rows: [] as Array<Record<string, string>> }));

      const ixAcc = new Map<string, IndexInfo>();
      for (const r of ixRows.rows as Array<Record<string, string>>) {
        const table = byTable.get(`${r.schema}.${r.table}`);
        if (!table) continue;
        const key = `${r.schema}.${r.table}.${r.index}`;
        let ix = ixAcc.get(key);
        if (!ix) {
          ix = { name: r.index, columns: [], unique: String(r.uniq) === 'true' };
          ixAcc.set(key, ix);
          table.indexes.push(ix);
        }
        if (r.column !== null && r.column !== undefined) ix.columns.push(String(r.column));
      }

      const fkRows = await client
        .query(
          // conkey and confkey are parallel arrays: the nth referencing
          // column matches the nth referenced one, which is what the two
          // ordinalities are joined on. Reading them independently would
          // pair the columns up wrongly on any composite key.
          `select n.nspname as schema, c.relname as table, con.conname as name,
                  a.attname as column, k.ord,
                  fn.nspname as ref_schema, fc.relname as ref_table, fa.attname as ref_column
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
             join pg_class fc on fc.oid = con.confrelid
             join pg_namespace fn on fn.oid = fc.relnamespace
             join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             join lateral unnest(con.confkey) with ordinality as f(attnum, ord) on f.ord = k.ord
             join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = f.attnum
            where con.contype = 'f' and n.nspname = any($1::text[])
            order by n.nspname, c.relname, con.conname, k.ord`,
          [schemas],
        )
        .catch(() => ({ rows: [] as Array<Record<string, string>> }));

      const fkAcc = new Map<string, ForeignKeyInfo>();
      for (const r of fkRows.rows as Array<Record<string, string>>) {
        const table = byTable.get(`${r.schema}.${r.table}`);
        if (!table) continue;
        const key = `${r.schema}.${r.table}.${r.name}`;
        let fk = fkAcc.get(key);
        if (!fk) {
          fk = {
            name: r.name,
            columns: [],
            refSchema: r.ref_schema ?? null,
            refTable: r.ref_table,
            refColumns: [],
          };
          fkAcc.set(key, fk);
          table.foreignKeys.push(fk);
        }
        fk.columns.push(r.column);
        fk.refColumns.push(r.ref_column);
      }
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

  /// Columns from the pg catalog, which is both the richest source and the
  /// one only real Postgres can serve — `format_type`, `pg_get_expr` and
  /// array-typed parameters are all absent on Redshift.
  private async postgresColumns(schemas: string[]): Promise<Map<string, TableInfo>> {
    const cols = await this.require().query(
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
    return byTable;
  }

  /// Columns from Redshift's own catalog views. `svv_columns` is the
  /// documented way in and — unlike pg_class — it also sees Spectrum's
  /// external schemas and late-binding views, which are exactly the
  /// tables a Redshift user most wants completion for.
  private async redshiftColumns(schemas: string[]): Promise<Map<string, TableInfo>> {
    const client = this.require();
    const list = sqlLiteralList(schemas);
    const cols = await client.query(
      `select table_schema as schema, table_name as table, column_name as column,
              ordinal_position as ordinal, data_type as type_name,
              character_maximum_length as char_len,
              numeric_precision as num_prec, numeric_scale as num_scale,
              is_nullable, column_default
         from svv_columns
        where table_schema in (${list})
        order by table_schema, table_name, ordinal_position`,
    );

    // Kinds come from a second view, and are allowed to fail: calling an
    // external table a table is a cosmetic loss, calling the whole
    // introspection a failure is not.
    const kindOf = new Map<string, TableInfo['kind']>();
    await client
      .query(
        `select table_schema as schema, table_name as table, table_type
           from svv_tables where table_schema in (${list})`,
      )
      .then((r) => {
        for (const t of r.rows as Array<Record<string, string>>) {
          kindOf.set(`${t.schema}.${t.table}`, /view/i.test(t.table_type ?? '') ? 'view' : 'table');
        }
      })
      .catch(() => undefined);

    const byTable = new Map<string, TableInfo>();
    for (const r of cols.rows as Array<Record<string, string>>) {
      const key = `${r.schema}.${r.table}`;
      let t = byTable.get(key);
      if (!t) {
        t = { name: r.table, kind: kindOf.get(key) ?? 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
        byTable.set(key, t);
      }
      t.columns.push({
        name: r.column,
        ordinal: Number(r.ordinal),
        typeName: redshiftTypeName(r),
        // svv_columns spells this the information_schema way.
        nullable: String(r.is_nullable).toUpperCase() === 'YES',
        defaultExpr: r.column_default ?? null,
      });
    }
    return byTable;
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.resilientQuery(
      `select nspname from pg_namespace
        where nspname not in ('pg_catalog','information_schema')
          and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
        order by nspname`,
    );
    return (r.rows as Array<{ nspname: string }>).map((x) => x.nspname);
  }

  async listTables(): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const r = await this.resilientQuery(
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

  async useSchema(name: string): Promise<string> {
    await this.require().query(`set search_path to ${quoteIdent(name)}`);
    // Read it back rather than trusting the SET: `search_path` accepts a
    // schema that does not exist, and current_schema() then resolves to
    // something else entirely.
    const now = (await this.currentSchema()) ?? name;
    if (this.spec) this.spec.searchPath = [now];
    return now;
  }

  async currentSchema(): Promise<string | null> {
    const r = await this.resilientQuery('select current_schema() as s');
    return (r.rows[0] as { s: string | null } | undefined)?.s ?? null;
  }

  async beginTransaction(): Promise<void> {
    if (this.txnOpen) return;
    await this.require().query('begin');
    this.txnOpen = true;
  }

  async commit(): Promise<void> {
    if (!this.txnOpen) return;
    this.txnOpen = false;
    await this.require().query('commit');
  }

  async rollback(): Promise<void> {
    if (!this.txnOpen) return;
    // Cleared FIRST: a rollback that itself fails must not leave the
    // adapter believing a transaction is still open, or every later
    // statement rides a transaction that no longer exists.
    this.txnOpen = false;
    await this.require().query('rollback').catch(() => undefined);
  }

  inTransaction(): boolean {
    return this.txnOpen;
  }

  async close(): Promise<void> {
    await this.client?.end().catch(() => undefined);
    await this.sideClient?.end().catch(() => undefined);
    this.client = null;
    this.sideClient = null;
    this.fatal = null;
  }

  /// A statement that must not be defeated by someone else's mess.
  ///
  /// 25P02 means the connection is sitting in a transaction that a failed
  /// statement aborted. If it is not a transaction the user opened, nobody
  /// is coming to end it, and every read after this point fails for a
  /// reason that has nothing to do with what was asked. Ending it and
  /// asking again is the only answer that isn't "restart the connection".
  private async resilientQuery(sql: string) {
    const client = this.require();
    try {
      return await client.query(sql);
    } catch (err) {
      if (this.txnOpen || (err as { code?: string })?.code !== '25P02') throw err;
      await client.query('rollback').catch(() => undefined);
      return await client.query(sql);
    }
  }

  // -------------------------------------------------------------------
  // Per-statement cost
  // -------------------------------------------------------------------

  async slowQuerySupport(): Promise<SlowQuerySupport> {
    // Redshift is forked from PostgreSQL 8.0 and has no extensions at all;
    // Cockroach keeps its statement history somewhere else entirely
    // (crdb_internal.node_statement_statistics), which is a different
    // reader, not a different query. Neither is a configuration problem, so
    // neither gets a fix line.
    if (isRedshift(this.variant)) {
      return {
        supported: false,
        reason: {
          code: 'unsupported',
          detail:
            'Redshift has no pg_stat_statements. Its query history lives in the STL/SVL system tables, which overdb does not read yet.',
          engine: 'postgres',
        },
      };
    }
    if (this.variant === 'cockroach') {
      return {
        supported: false,
        reason: {
          code: 'unsupported',
          detail:
            'CockroachDB keeps statement statistics in crdb_internal rather than pg_stat_statements, which overdb does not read yet.',
          engine: 'postgres',
        },
      };
    }

    const client = this.require();
    try {
      // The probe IS the read. Catalog presence would tell us the view
      // exists; only reading it tells us this user can read it, and on
      // Aurora those two answers routinely differ.
      //
      // Fifty rows rather than one because redaction is per row: a user
      // whose own statement happens to sort first would otherwise be told
      // they can see everything.
      const r = await client.query(
        `select query from pg_stat_statements limit 50`,
      );
      const redacted = r.rows.some(
        (row) => String((row as { query: string }).query) === PG_REDACTED,
      );
      return {
        supported: true,
        source: 'pg_stat_statements',
        resettable: await this.canResetStats(),
        visibility: redacted ? 'own-statements-only' : 'all',
        // pg_stat_statements keeps query texts in an external file rather
        // than a fixed-width column, so there is no single variable to
        // point a user at the way MySQL's digest length does.
        textLimit: null,
      };
    } catch (err) {
      // Only asked for on the failure path, and allowed to fail itself:
      // pg_available_extensions is missing on some forks, and a probe that
      // throws while explaining another throw helps nobody.
      const available = await client
        .query(`select 1 from pg_available_extensions where name = 'pg_stat_statements'`)
        .then((x) => x.rows.length > 0)
        .catch(() => false);
      const user = await this.currentUser();
      return {
        supported: false,
        reason: classifyPgProbeError(err as { code?: string; message?: string }, {
          variant: this.variant,
          available,
          user,
        }),
      };
    }
  }

  async slowQueries(opts: { limit: number }): Promise<StatementStat[]> {
    const client = this.require();
    // Renamed in 13: total_time/mean_time/max_time became
    // total_exec_time/mean_exec_time/max_exec_time when planning time got
    // its own columns. Reading server_version_num rather than parsing
    // version() because the fork strings are not reliably parseable.
    const num = await client
      .query('show server_version_num')
      .then((r) => Number((r.rows[0] as Record<string, string>).server_version_num))
      .catch(() => 0);
    const modern = num >= 130000;
    const total = modern ? 'total_exec_time' : 'total_time';
    const mean = modern ? 'mean_exec_time' : 'mean_time';
    const max = modern ? 'max_exec_time' : 'max_time';

    const r = await client.query(
      `select queryid::text as digest,
              query as sql,
              calls,
              ${total} as total_ms,
              ${mean} as mean_ms,
              ${max} as max_ms,
              rows as rows_returned,
              shared_blks_hit,
              shared_blks_read,
              shared_blks_written,
              temp_blks_written
         from pg_stat_statements
        -- Scoped to the database this connection is pointed at. The view
        -- is cluster-wide, so without this the pane reports on databases
        -- this connection cannot even query.
        where dbid = (select oid from pg_database where datname = current_database())
          and queryid is not null
        order by ${total} desc
        limit $1`,
      [opts.limit],
    );

    // Every value arrives as a string: this adapter disables type parsing
    // on purpose (see the file header), so nothing here is a number until
    // it is made one.
    return (r.rows as Array<Record<string, string | null>>).map((row) => {
      const sql = String(row.sql ?? '');
      return {
        digest: String(row.digest),
        sql,
        redacted: sql === PG_REDACTED,
        truncated: false,
        calls: n(row.calls) ?? 0,
        totalMs: n(row.total_ms) ?? 0,
        meanMs: n(row.mean_ms) ?? 0,
        maxMs: n(row.max_ms),
        rowsReturned: n(row.rows_returned),
        // Postgres counts blocks, not rows examined. Leaving this null
        // rather than inventing a rows-examined figure out of block counts,
        // which would be a different measurement wearing its name.
        rowsExamined: null,
        noIndexUsed: null,
        extra: {
          'blocks hit': n(row.shared_blks_hit),
          'blocks read': n(row.shared_blks_read),
          'blocks written': n(row.shared_blks_written),
          'temp written': n(row.temp_blks_written),
        },
      };
    });
  }

  /// A real execution of this digest, from what is running RIGHT NOW.
  ///
  /// Postgres keeps no history of executed statement texts — pg_stat_
  /// statements stores the normalized form only — so the sole place a real
  /// one exists is pg_stat_activity, and only while it is still running.
  /// That makes this useful exactly when it matters most: the expensive
  /// statement you are looking at is often still going.
  ///
  /// `query_id` arrived in 14. Below that there is no way to match an
  /// activity row to a pg_stat_statements row, so the answer is null rather
  /// than a guess based on matching text.
  async slowQueryExample(digest: string): Promise<string | null> {
    if (isRedshift(this.variant) || this.variant === 'cockroach') return null;
    return this.require()
      .query(
        `select query
           from pg_stat_activity
          where query_id = $1
            and pid <> pg_backend_pid()
            and query is not null
          order by now() - query_start desc
          limit 1`,
        [digest],
      )
      .then((r) => {
        const q = (r.rows[0] as { query?: string } | undefined)?.query;
        // Same redaction as pg_stat_statements: an activity row this user
        // may not read comes back with the text replaced rather than
        // withheld.
        return q && q !== PG_REDACTED ? String(q) : null;
      })
      .catch(() => null);
  }

  async resetSlowQueries(): Promise<void> {
    await this.require().query('select pg_stat_statements_reset()');
  }

  // -------------------------------------------------------------------
  // Live health
  // -------------------------------------------------------------------

  /// Everything the dashboard shows, in one pass.
  ///
  /// Each piece is its own query and each is allowed to fail on its own:
  /// a managed Postgres hides `pg_stat_replication` from ordinary users,
  /// Redshift has none of these views under these names, and a single
  /// `Promise.all` that rejects would turn one missing permission into a
  /// blank dashboard. A failure becomes a note; the rest still renders.
  async health(scope: HealthScope = 'full'): Promise<HealthSnapshot> {
    const client = this.require();
    const out = emptyHealth('postgres');
    const notes: string[] = [];

    const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notes.push(`${what}: ${message}`);
        return null;
      }
    };

    if (isRedshift(this.variant)) return this.redshiftHealth(scope);

    await attempt('server', async () => {
      // pg_database_size() adds up every file in the database directory,
      // which is the one expensive thing in an otherwise in-memory query —
      // so a pulse asks for everything here except the size.
      const r = await client.query(
        `select version() as v,
                extract(epoch from (now() - pg_postmaster_start_time())) as uptime,
                ${scope === 'full' ? 'pg_database_size(current_database())' : 'null'} as size,
                current_setting('max_connections') as max_conn,
                current_setting('superuser_reserved_connections') as reserved,
                (select count(*) from pg_stat_activity) as used`,
      );
      const row = r.rows[0] as Record<string, string | null>;
      out.serverVersion = row.v;
      out.uptimeSeconds = n(row.uptime);
      out.databaseBytes = n(row.size);
      // Counted against the whole cluster, which is what max_connections
      // limits — not derived from the session list below, which is capped
      // and filtered to client backends.
      out.connections = {
        used: n(row.used) ?? 0,
        max: n(row.max_conn),
        reservedForSuperuser: n(row.reserved),
      };
    });

    await attempt('sessions', async () => {
      // `pg_blocking_pids` is the whole reason to read this view rather
      // than counting connections: "sixty sessions are waiting on that
      // one" is the answer, and nothing else in the catalog gives it.
      const r = await client.query(
        `select pid::text as id,
                usename as usr,
                application_name as app,
                host(client_addr) as client,
                datname as db,
                state,
                coalesce(wait_event_type || ':' || wait_event, null) as wait,
                query,
                extract(epoch from (now() - coalesce(query_start, state_change, backend_start))) as secs,
                pid = pg_backend_pid() as is_self,
                pg_blocking_pids(pid)::text as blocked_by
           from pg_stat_activity
          where backend_type = 'client backend'
          order by state = 'active' desc, secs desc nulls last
          limit 500`,
      );
      out.sessions = (r.rows as Array<Record<string, string | null>>).map((row) => ({
        id: String(row.id),
        user: row.usr,
        application: row.app === '' ? null : row.app,
        clientAddress: row.client,
        database: row.db,
        state: row.state,
        waitEvent: row.wait,
        query: row.query,
        seconds: n(row.secs),
        isSelf: String(row.is_self) === 'true',
        // The array arrives as '{123,456}' with parsing off.
        blockedBy: String(row.blocked_by ?? '{}')
          .replace(/[{}]/g, '')
          .split(',')
          .filter((s) => s !== ''),
      }));
    });

    await attempt('cache and transactions', async () => {
      const r = await client.query(
        `select blks_hit, blks_read, xact_commit, xact_rollback
           from pg_stat_database
          where datname = current_database()`,
      );
      const row = r.rows[0] as Record<string, string | null> | undefined;
      if (!row) return;
      const hit = n(row.blks_hit) ?? 0;
      const read = n(row.blks_read) ?? 0;
      // A server that has done no reads at all has no ratio, and reporting
      // 0% for one would read as a catastrophe rather than as silence.
      out.cacheHitRatio = hit + read > 0 ? hit / (hit + read) : null;
      out.transactions = { committed: n(row.xact_commit) ?? 0, rolledBack: n(row.xact_rollback) ?? 0 };
    });

    await attempt('pressure', async () => {
      const r = await client.query(
        `select (select count(*) from pg_stat_activity
                  where backend_type = 'client backend' and state = 'active'
                    and pid <> pg_backend_pid()) as running,
                (select count(*) from pg_stat_activity
                  where backend_type = 'client backend' and wait_event_type = 'Lock') as lock_waits,
                (select extract(epoch from max(now() - xact_start)) from pg_stat_activity
                  where backend_type = 'client backend' and pid <> pg_backend_pid()) as oldest,
                d.xact_commit + d.xact_rollback as work, d.temp_files, d.deadlocks
           from pg_stat_database d
          where d.datname = current_database()`,
      );
      const row = r.rows[0] as Record<string, string | null> | undefined;
      if (!row) return;
      const counters: PressureCounters = {};
      const work = n(row.work);
      const tempToDisk = n(row.temp_files);
      const deadlocks = n(row.deadlocks);
      if (work !== null) counters.work = work;
      if (tempToDisk !== null) counters.tempToDisk = tempToDisk;
      if (deadlocks !== null) counters.deadlocks = deadlocks;
      out.pressure = {
        running: n(row.running) ?? 0,
        lockWaits: n(row.lock_waits),
        oldestTransactionSeconds: n(row.oldest),
        // No undo log to back up: Postgres keeps old versions in the table,
        // and what that costs shows as bloat, not as a queue.
        undoBacklog: null,
        counters,
      };
    });

    // The storage half. Every one of these stats a file per relation or
    // reads a statistics table with a row per object, which is why a fast
    // poll skips them and the pane keeps showing the last measurement with
    // the time it was taken. `replication` below stays in the pulse: it is
    // an in-memory view, and lag is live data.
    if (scope === 'full') {
      await attempt('table sizes', async () => {
        const r = await client.query(
          `select schemaname as sch, relname as tbl,
                  pg_table_size(relid) as bytes,
                  pg_indexes_size(relid) as index_bytes,
                  n_live_tup as rows
             from pg_stat_user_tables
            order by pg_total_relation_size(relid) desc
            limit 50`,
        );
        out.tables = (r.rows as Array<Record<string, string | null>>).map((row) => ({
          schema: String(row.sch),
          table: String(row.tbl),
          bytes: n(row.bytes) ?? 0,
          indexBytes: n(row.index_bytes),
          estimatedRows: n(row.rows),
        }));
      });

      await attempt('index usage', async () => {
        const r = await client.query(
          `select s.schemaname as sch, s.relname as tbl, s.indexrelname as idx,
                  s.idx_scan as scans,
                  pg_relation_size(s.indexrelid) as bytes,
                  i.indisunique as uniq
             from pg_stat_user_indexes s
             join pg_index i on i.indexrelid = s.indexrelid
            where s.idx_scan = 0
            order by pg_relation_size(s.indexrelid) desc
            limit 50`,
        );
        out.unusedIndexes = (r.rows as Array<Record<string, string | null>>).map((row) => ({
          schema: String(row.sch),
          table: String(row.tbl),
          index: String(row.idx),
          scans: n(row.scans) ?? 0,
          bytes: n(row.bytes),
          unique: String(row.uniq) === 'true',
        }));
      });

      await attempt('scan counts', async () => {
        const r = await client.query(
          `select schemaname as sch, relname as tbl,
                  seq_scan, seq_tup_read, idx_scan, n_live_tup as rows
             from pg_stat_user_tables
            where seq_scan > 0
            order by seq_tup_read desc
            limit 50`,
        );
        out.sequentialScans = (r.rows as Array<Record<string, string | null>>).map((row) => ({
          schema: String(row.sch),
          table: String(row.tbl),
          sequentialScans: n(row.seq_scan) ?? 0,
          sequentialRowsRead: n(row.seq_tup_read) ?? 0,
          indexScans: n(row.idx_scan) ?? 0,
          estimatedRows: n(row.rows),
        }));
      });
    }

    await attempt('replication', async () => {
      const r = await client.query(
        `select client_addr::text as client, state,
                pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag
           from pg_stat_replication`,
      );
      out.replication = (r.rows as Array<Record<string, string | null>>).map((row) => ({
        client: row.client,
        state: row.state,
        lagBytes: n(row.lag),
      }));
    });

    return { ...out, notes };
  }

  /// Stop someone else's statement, or close their connection.
  ///
  /// Deliberately two verbs. `pg_cancel_backend` stops the running
  /// statement and leaves the session alive — nearly always what is wanted,
  /// and reversible in the sense that the client just gets an error.
  /// `pg_terminate_backend` closes the connection and rolls back whatever
  /// it held, which is the bigger hammer and the one the UI makes you
  /// confirm.
  /// The same dashboard, read out of a database that has none of the views
  /// it is normally read from.
  ///
  /// Redshift forked from PostgreSQL 8.0 and never got pg_stat_*. It is not
  /// a Postgres missing a few fields: the things worth knowing there are
  /// different things. It has no indexes, so "the planner never chose this
  /// index" is not a sentence about Redshift; what costs you a query is a
  /// table that has gone unsorted, whose statistics are stale, or whose
  /// rows landed unevenly across the slices. Those are the panels.
  ///
  /// Each read is attempted on its own, because which of these views a
  /// cluster will show depends on the user's privileges — an ordinary user
  /// sees only their own rows in STV_RECENTS, and that is worth a note
  /// rather than an empty pane.
  private async redshiftHealth(scope: HealthScope): Promise<HealthSnapshot> {
    const client = this.require();
    const out = emptyHealth('postgres');
    const notes: string[] = [];

    const attempt = async (what: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        notes.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Whether this user is a superuser decides what half of these views
    // will even show, so it is read first and shapes the notes rather than
    // being discovered as a string of permission errors.
    let superuser = false;

    await attempt('server', async () => {
      const r = await client.query(
        `select version() as v,
                pg_backend_pid() as pid,
                (select usesuper from pg_user where usename = current_user) as super`,
      );
      const row = r.rows[0] as Record<string, string | null>;
      out.serverVersion = row.v;
      this.redshiftSelfPid = row.pid === null ? null : String(row.pid);
      superuser = String(row.super) === 'true';
    });

    await attempt('sessions', async () => {
      // STV_SESSIONS is everyone connected; STV_RECENTS is what is running.
      // Joined rather than read separately so a session appears once, with
      // its statement when it has one — and aggregated first because a pid
      // can have several rows in STV_RECENTS.
      const r = await client.query(
        `select s.process::text as id,
                trim(s.user_name) as usr,
                trim(s.db_name) as db,
                case when r.pid is null then 'idle' else 'active' end as state,
                r.query as query,
                datediff(second,
                         case when r.pid is null then s.starttime else r.starttime end,
                         getdate()) as secs
           from stv_sessions s
           left join (select pid, max(starttime) as starttime, min(query) as query
                        from stv_recents
                       where status = 'Running'
                       group by pid) r
             on r.pid = s.process
          order by case when r.pid is null then 1 else 0 end, secs desc
          limit 500`,
      );
      out.sessions = (r.rows as Array<Record<string, string | null>>).map((row) => ({
        id: String(row.id),
        user: row.usr,
        // Redshift reports neither an application name nor the client
        // address on STV_SESSIONS.
        application: null,
        clientAddress: null,
        database: row.db,
        state: row.state,
        waitEvent: null,
        query: row.query,
        seconds: n(row.secs),
        isSelf: this.redshiftSelfPid !== null && String(row.id) === this.redshiftSelfPid,
        blockedBy: [],
      }));
      out.connections = { used: out.sessions.length, max: null };
      notes.push(
        'Redshift does not publish a connection ceiling to its clients; the count is the sessions it listed.',
      );
      // The one misreading this pane could cause on Redshift: STV_RECENTS
      // shows a non-superuser only their OWN statements, so every other
      // session on a busy cluster arrives here with nothing running and is
      // drawn as idle. A screen saying "432 connected · 0 awake" on a
      // cluster that is working hard is worse than a screen saying nothing.
      if (!superuser && out.sessions.every((session) => session.state === 'idle')) {
        notes.push(
          'Every session reads as idle because STV_RECENTS shows a non-superuser only their own statements. Other people may well be running queries; this connection cannot see them.',
        );
      }
    });

    await attempt('locks', async () => {
      // The Redshift spelling of pg_blocking_pids: a transaction waiting on
      // a relation, and whoever holds the lock on it.
      const r = await client.query(
        `select w.pid::text as waiter, h.pid::text as holder
           from svv_transactions w
           join svv_transactions h
             on h.relation = w.relation
            and h.granted = true
            and h.pid <> w.pid
          where w.granted = false`,
      );
      const blocked = new Map<string, string[]>();
      for (const row of r.rows as Array<Record<string, string>>) {
        const list = blocked.get(String(row.waiter)) ?? [];
        list.push(String(row.holder));
        blocked.set(String(row.waiter), list);
      }
      for (const session of out.sessions) {
        const holders = blocked.get(session.id);
        if (holders) {
          session.blockedBy = holders;
          session.waitEvent = 'lock';
        }
      }
    });

    if (scope === 'full') {
      // SVV_TABLE_INFO is superuser-only. Said once, in a sentence carrying
      // the way out of it, rather than letting a raw "permission denied for
      // relation svv_table_info" stand as the pane's whole explanation —
      // and not attempted at all when it is already known it will fail,
      // which would spend a round trip per refresh to learn nothing.
      if (!superuser) {
        notes.push(
          'Table sizes, unsorted percentage and distribution skew come from SVV_TABLE_INFO, which Redshift shows to superusers only. Connecting as one, or being granted access to it, fills in the rest of this pane.',
        );
      }

      await attempt('table sizes', async () => {
        if (!superuser) return;
        // SVV_TABLE_INFO is one row per table and carries, in the same
        // row, both how big it is and the three things that make it slow.
        const r = await client.query(
          `select "schema" as sch, "table" as tbl, size as mb, tbl_rows as rows,
                  unsorted, stats_off, skew_rows
             from svv_table_info
            order by size desc
            limit 50`,
        );
        const rows = r.rows as Array<Record<string, string | null>>;
        // `size` is a count of 1 MB blocks, not bytes.
        out.tables = rows.map((row) => ({
          schema: String(row.sch),
          table: String(row.tbl),
          bytes: (n(row.mb) ?? 0) * 1024 * 1024,
          indexBytes: null,
          estimatedRows: n(row.rows),
        }));
        out.databaseBytes = out.tables.reduce((sum, t) => sum + t.bytes, 0);
        if (out.tables.length === 50) {
          notes.push('Sizes cover the 50 biggest tables, so the total is a floor, not the database.');
        }
        out.panels = redshiftPanels(rows);
      });
    }

    return { ...out, notes };
  }

  async killSession(id: string, opts: { terminate: boolean }): Promise<{ ok: boolean; error?: string }> {
    try {
      if (isRedshift(this.variant)) {
        // CANCEL takes no parameters, hence the interpolation — of a number
        // this checks, not of anything a user typed. PG_TERMINATE_BACKEND
        // does exist there and is the only one of the pair that reports.
        if (!/^\d+$/.test(id)) return { ok: false, error: `${id} is not a session id.` };
        if (opts.terminate) {
          await this.require().query(`select pg_terminate_backend(${Number(id)})`);
        } else {
          await this.require().query(`cancel ${Number(id)}`);
        }
        return { ok: true };
      }
      const r = await this.require().query(
        opts.terminate
          ? 'select pg_terminate_backend($1::int) as ok'
          : 'select pg_cancel_backend($1::int) as ok',
        [id],
      );
      // Both functions return false rather than raising when the pid is
      // simply gone, which is a common race — the statement you were
      // reading about finished while you were reading about it.
      const ok = String((r.rows[0] as { ok: string } | undefined)?.ok) === 'true';
      return ok
        ? { ok: true }
        : { ok: false, error: `The server declined — session ${id} may have already ended.` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /// Asked of the catalog rather than found out by calling it: the only
  /// other way to know is to reset the counters and see, which destroys the
  /// thing being measured on every server where the answer is yes.
  private canResetStats(): Promise<boolean> {
    return this.require()
      .query(
        `select has_function_privilege(current_user, 'pg_stat_statements_reset()', 'execute') as ok`,
      )
      .then((r) => String((r.rows[0] as { ok: string }).ok) === 'true')
      .catch(() => false);
  }

  private currentUser(): Promise<string | undefined> {
    return this.require()
      .query('select current_user as u')
      .then((r) => String((r.rows[0] as { u: string }).u))
      .catch(() => undefined);
  }

  private require(): Client {
    // Checked first: a client whose backend has gone stays a live object,
    // so without this the next statement fails with the driver's own
    // wording and nothing says the fix is to reconnect.
    if (this.fatal) {
      throw new Error(`the postgres connection was lost (${this.fatal.message}) — reconnect to continue`);
    }
    if (!this.client) throw new Error('postgres adapter is not connected');
    return this.client;
  }
}

/// Postgres hands back every value as text here, and `Number('')` is 0
/// while `Number(null)` is also 0 — both wrong for a counter that is
/// genuinely absent.
function n(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/// A `in (...)` list of string literals, for the catalog queries Redshift
/// has to answer. Not an optimisation and not a shortcut: Redshift has no
/// array types at all, so `= any($1::text[])` — the form the Postgres
/// queries use — cannot be sent to it.
export function sqlLiteralList(values: string[]): string {
  if (values.length === 0) return `''`;
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

/// Rebuild the type as the user would have written it. `svv_columns` splits
/// what `format_type` returns on Postgres into a bare name plus separate
/// length and precision columns, and a bare `character varying` in the
/// completion popup tells you nothing about what will fit.
/// The three things that make a Redshift table slow, as panels.
///
/// Kept out of the adapter method and exported so the thresholds can be
/// tested, because they are claims about Redshift rather than about
/// layout: a table is worth vacuuming somewhere around a tenth of it being
/// unsorted, statistics start costing you plans around a fifth stale, and
/// skew is a ratio where 1 is even and anything approaching 2 means one
/// slice is doing twice the work of the average.
///
/// Each panel is dropped entirely when nothing crosses its threshold. A
/// card reading "nothing to report" for every table on the cluster is a
/// card that teaches you to stop looking at this column.
export function redshiftPanels(
  rows: Array<Record<string, string | null>>,
): HealthPanel[] {
  const num = (v: string | null): number => {
    const parsed = v === null ? NaN : Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const name = (row: Record<string, string | null>): string => `${row.sch}.${row.tbl}`;
  const panels: HealthPanel[] = [];

  const unsorted = rows
    .filter((row) => num(row.unsorted) >= 10)
    .sort((a, b) => num(b.unsorted) - num(a.unsorted))
    .slice(0, 8);
  if (unsorted.length > 0) {
    panels.push({
      key: 'redshift-unsorted',
      title: 'Tables gone unsorted',
      rows: unsorted.map((row) => ({
        label: name(row),
        value: `${num(row.unsorted).toFixed(0)}%`,
        ratio: Math.min(1, num(row.unsorted) / 100),
        tone: num(row.unsorted) >= 25 ? 'bad' : 'watch',
      })),
      note: 'Rows written since the last VACUUM sit outside the sort key, so a query that should read one zone map reads the table. VACUUM SORT ONLY puts them back.',
    });
  }

  const stale = rows
    .filter((row) => num(row.stats_off) >= 20)
    .sort((a, b) => num(b.stats_off) - num(a.stats_off))
    .slice(0, 8);
  if (stale.length > 0) {
    panels.push({
      key: 'redshift-stats',
      title: 'Stale statistics',
      rows: stale.map((row) => ({
        label: name(row),
        value: `${num(row.stats_off).toFixed(0)}%`,
        ratio: Math.min(1, num(row.stats_off) / 100),
        tone: num(row.stats_off) >= 50 ? 'bad' : 'watch',
      })),
      note: 'How far the statistics are from the current table. The planner is choosing joins from these numbers; ANALYZE refreshes them.',
    });
  }

  const skewed = rows
    .filter((row) => num(row.skew_rows) >= 1.5)
    .sort((a, b) => num(b.skew_rows) - num(a.skew_rows))
    .slice(0, 8);
  if (skewed.length > 0) {
    panels.push({
      key: 'redshift-skew',
      title: 'Distribution skew',
      rows: skewed.map((row) => ({
        label: name(row),
        sub: `${(n(row.rows) ?? 0).toLocaleString()} rows`,
        value: `${num(row.skew_rows).toFixed(1)}×`,
        // 4 is where a slice is doing four times the average, which is
        // where the bar should already be full rather than still climbing.
        ratio: Math.min(1, num(row.skew_rows) / 4),
        tone: num(row.skew_rows) >= 3 ? 'bad' : 'watch',
      })),
      note: 'The busiest slice against the average one. A query is only as fast as its slowest slice, so an uneven distribution key costs every scan of this table.',
    });
  }

  return panels;
}

export function redshiftTypeName(r: Record<string, string>): string {
  const base = String(r.type_name ?? '');
  if (r.char_len != null && r.char_len !== '') return `${base}(${r.char_len})`;
  if (r.num_prec != null && r.num_prec !== '' && /numeric|decimal/i.test(base)) {
    return `${base}(${r.num_prec},${r.num_scale ?? 0})`;
  }
  return base;
}

// Unused placeholders kept off the public surface.
export type { IndexInfo, ForeignKeyInfo };
