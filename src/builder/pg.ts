// The builder for a Postgres copy — of a Postgres server, or of Redshift,
// which has no local edition and so is copied into Postgres. It carries out
// the same plan the MySQL builder does (src/shared/baselineBuild.ts): the
// same starting points, rows following their parents, missing parents
// fetched afterwards. Only the SQL differs.
//
// Values travel as the text the source prints them as and go back in as
// text, so nothing is reinterpreted on the way: no Date objects, no floats
// for numerics, no parsed JSON. Postgres reads its own text output back
// exactly; Redshift's differs only for binary, which is fixed up below.

import { Client, type ClientConfig } from 'pg';
import type { BuildPlan, BuildProgress, BuildReport, BuildTable, FollowRule } from '../shared/baselineBuild';
import { tableKey, type TableRef } from '../shared/baseline';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from '../shared/types';
import { pgColumn, pgIdent as q } from '../shared/pgCopy';
import type { ConnectSpec } from '../db/adapter';
import { tlsOptions } from '../db/tls';

export interface PgEndpoint {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tls?: Pick<ConnectSpec, 'engine' | 'ssl' | 'sslRootCert' | 'sslCert' | 'sslKey' | 'tlsServerName' | 'host'>;
}

/// A planned table as the catalog read it during discovery: what the copy
/// creates it from, so the builder does not read the catalog again.
export interface PgTable {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface PgBuildRequest {
  source: PgEndpoint;
  target: PgEndpoint;
  plan: BuildPlan;
  catalog: PgTable[];
  redshift: boolean;
  login: { user: string; password: string } | null;
  /// The copy's `postgres` password. Main turns on password login once the
  /// build is done; until then the build alone reaches it.
  admin: string;
}

const qt = (ref: TableRef) => `${q(ref.schema)}.${q(ref.table)}`;
/// Keys per IN list, and the most parameters one INSERT may carry.
const KEY_CHUNK = 1_000;
const MAX_PARAMS = 30_000;
const FILL_ROUNDS = 6;

/// Every value as the text it was printed as.
const RAW = { getTypeParser: () => (v: string) => v } as unknown as ClientConfig['types'];

function config(ep: PgEndpoint, database?: string): ClientConfig {
  return {
    host: ep.host ?? '127.0.0.1',
    port: ep.port ?? 5432,
    user: ep.user,
    password: ep.password,
    database: database ?? ep.database,
    ssl: ep.tls ? tlsOptions(ep.tls as ConnectSpec) : undefined,
    types: RAW,
    application_name: 'overdb-base-builder',
  };
}

export async function buildPostgres(req: PgBuildRequest, progress: (p: BuildProgress) => void): Promise<BuildReport> {
  const started = Date.now();
  const report: BuildReport = { tables: 0, rows: 0, copied: {}, filled: 0, skipped: [], durationMs: 0 };
  const { plan, redshift } = req;
  const database = req.source.database || 'postgres';
  const byKey = new Map(req.catalog.map((t) => [tableKey({ schema: t.schema, table: t.table }), t]));

  progress({ stage: 'start', text: 'Connecting to the server and to the new instance' });
  const source = new Client(config(req.source));
  await source.connect();
  // The copy holds the same database name, so a service's connection
  // string changes only its host and port.
  const admin = new Client(config(req.target, 'postgres'));
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${q(database)}`);
  await admin.end();
  const target = new Client(config(req.target, database));
  await target.connect();

  try {
    await source.query("SET TIME ZONE 'UTC'").catch(() => undefined);
    await target.query("SET TIME ZONE 'UTC'");
    // Loading, not running the app: no triggers or key checks while rows
    // arrive out of order.
    await target.query("SET session_replication_role = 'replica'");

    progress({ stage: 'schemas', text: `Creating ${plan.schemas.length} schemas` });
    for (const s of plan.schemas) await target.query(`CREATE SCHEMA IF NOT EXISTS ${q(s)}`);

    progress({ stage: 'tables', text: `Creating ${plan.tables.length} tables`, done: 0, total: plan.tables.length });
    for (const [i, t] of plan.tables.entries()) {
      const info = byKey.get(tableKey(t.ref));
      if (!info || info.columns.length === 0) {
        report.skipped.push({ what: `table ${tableKey(t.ref)}`, reason: 'Its columns were not in the catalog.' });
        continue;
      }
      const cols = [...info.columns].sort((a, b) => a.ordinal - b.ordinal);
      // The key from the start, so a row reached twice — a starting point
      // that is also some kept row's child — is inserted once.
      const key = info.primaryKey.length ? `, PRIMARY KEY (${info.primaryKey.map(q).join(', ')})` : '';
      await target.query(`CREATE TABLE IF NOT EXISTS ${qt(t.ref)} (${cols.map((c) => `${q(c.name)} ${pgColumn(c, redshift)}`).join(', ')}${key})`);
      report.tables++;
      if ((i + 1) % 50 === 0) progress({ stage: 'tables', text: `Created ${i + 1} tables`, done: i + 1, total: plan.tables.length });
    }

    // Binary comes out of Redshift as bare hex; Postgres wants it marked.
    const binary = new Map<string, Set<number>>();
    for (const t of req.catalog) {
      const at = new Set<number>();
      [...t.columns].sort((a, b) => a.ordinal - b.ordinal).forEach((c, i) => {
        if (redshift && /^(varbyte|varbinary|binary varying)/i.test(c.typeName)) at.add(i);
      });
      if (at.size) binary.set(tableKey({ schema: t.schema, table: t.table }), at);
    }

    const columnsOf = (ref: TableRef) => [...(byKey.get(tableKey(ref))?.columns ?? [])].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.name);

    const copy = async (ref: TableRef, where: string, params: unknown[]): Promise<number> => {
      const cols = columnsOf(ref);
      if (cols.length === 0) return 0;
      const res = await source.query({ text: `SELECT ${cols.map(q).join(', ')} FROM ${qt(ref)}${where}`, values: params, rowMode: 'array' });
      const rows = res.rows as unknown[][];
      if (rows.length === 0) return 0;
      const hex = binary.get(tableKey(ref));
      const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      let n = 0;
      for (let i = 0; i < rows.length; i += per) {
        const batch = rows.slice(i, i + per);
        const values: unknown[] = [];
        const tuples = batch.map((row) => {
          const marks = row.map((v, j) => {
            values.push(hex?.has(j) && typeof v === 'string' && !v.startsWith('\\x') ? `\\x${v}` : v);
            return `$${values.length}`;
          });
          return `(${marks.join(', ')})`;
        });
        const r = await target.query(
          `INSERT INTO ${qt(ref)} (${cols.map(q).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
          values,
        );
        n += r.rowCount ?? batch.length;
      }
      return n;
    };

    const copyIn = async (ref: TableRef, column: string, values: unknown[], when?: { column: string; value: string }): Promise<number> => {
      let n = 0;
      for (let i = 0; i < values.length; i += KEY_CHUNK) {
        const chunk = values.slice(i, i + KEY_CHUNK);
        const marks = chunk.map((_, j) => `$${j + 1}`).join(', ');
        const extra = when ? ` AND ${q(when.column)} = $${chunk.length + 1}` : '';
        // Untyped parameters: the server reads them as the column's own
        // type, so a key column's index is used.
        n += await copy(ref, ` WHERE ${q(column)} IN (${marks})${extra}`, when ? [...chunk, when.value] : chunk);
      }
      return n;
    };

    // The keys a person started from: a table following its starting point
    // follows these too, even when that row is not in the table itself — a
    // data mart keeps one client in several tables.
    const startKeys = new Map<string, unknown[]>();
    for (const t of plan.tables) if (t.rows.kind === 'keys') startKeys.set(`${tableKey(t.ref)}.${t.rows.column}`.toLowerCase(), t.rows.values);
    const keysOf = async (ref: TableRef, column: string): Promise<unknown[]> => {
      const r = await target.query({ text: `SELECT DISTINCT ${q(column)}::text FROM ${qt(ref)} WHERE ${q(column)} IS NOT NULL`, rowMode: 'array' });
      const found = (r.rows as unknown[][]).map((x) => x[0]);
      const start = startKeys.get(`${tableKey(ref)}.${column}`.toLowerCase()) ?? [];
      const have = new Set(found.map(String));
      return [...found, ...start.filter((v) => !have.has(String(v)))];
    };

    const follow = async (ref: TableRef, r: FollowRule): Promise<number> => {
      const parents = await keysOf(r.parent, r.refColumn);
      let n = parents.length === 0 ? 0 : await copyIn(ref, r.column, parents, r.when);
      for (const m of r.more ?? []) n += await follow(ref, m);
      if (r.orUnassigned) {
        const u = r.orUnassigned;
        const tenants = await keysOf(u.parent, u.refColumn);
        for (let i = 0; i < tenants.length; i += KEY_CHUNK) {
          const chunk = tenants.slice(i, i + KEY_CHUNK);
          n += await copy(ref, ` WHERE ${q(r.column)} IS NULL AND ${q(u.column)} IN (${chunk.map((_, j) => `$${j + 1}`).join(', ')})`, chunk);
        }
      }
      return n;
    };

    const copyTable = async (t: BuildTable): Promise<number> => {
      const r = t.rows;
      switch (r.kind) {
        case 'none':
          return 0;
        case 'all':
          return copy(t.ref, '', []);
        case 'keys': {
          const n = await copyIn(t.ref, r.column, r.values);
          return r.also ? n + (await follow(t.ref, r.also)) : n;
        }
        case 'follows':
          return follow(t.ref, r);
      }
    };

    const withRows = plan.tables.filter((t) => t.rows.kind !== 'none' && byKey.has(tableKey(t.ref)));
    progress({ stage: 'rows', text: `Copying rows into ${withRows.length} tables`, done: 0, total: withRows.length });
    for (const [i, t] of withRows.entries()) {
      let n = 0;
      let failed: string | null = null;
      try {
        n = await copyTable(t);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
        report.skipped.push({ what: `Rows for ${tableKey(t.ref)}`, reason: failed });
      }
      if (n > 0) report.copied[tableKey(t.ref)] = n;
      report.rows += n;
      progress({
        stage: 'rows',
        text: failed ? `${tableKey(t.ref)}: not copied — ${failed}` : `${tableKey(t.ref)}: ${n.toLocaleString()} rows`,
        done: i + 1,
        total: withRows.length,
      });
    }

    if (plan.fills.length > 0) {
      progress({ stage: 'parents', text: `Completing ${plan.fills.length} foreign keys` });
      const failedFills = new Set<(typeof plan.fills)[number]>();
      for (let round = 0; round < FILL_ROUNDS; round++) {
        let added = 0;
        for (const f of plan.fills) {
          if (failedFills.has(f) || !byKey.has(tableKey(f.parent)) || !byKey.has(tableKey(f.child))) continue;
          try {
            const missing = await target.query({
              text: `SELECT DISTINCT c.${q(f.column)}::text FROM ${qt(f.child)} c
                       LEFT JOIN ${qt(f.parent)} p ON p.${q(f.refColumn)}::text = c.${q(f.column)}::text
                      WHERE c.${q(f.column)} IS NOT NULL AND p.${q(f.refColumn)} IS NULL${f.when ? ` AND c.${q(f.when.column)}::text = $1` : ''}`,
              values: f.when ? [f.when.value] : [],
              rowMode: 'array',
            });
            if (missing.rows.length === 0) continue;
            const n = await copyIn(f.parent, f.refColumn, (missing.rows as unknown[][]).map((x) => x[0]));
            added += n;
            report.copied[tableKey(f.parent)] = (report.copied[tableKey(f.parent)] ?? 0) + n;
          } catch (err) {
            failedFills.add(f);
            report.skipped.push({
              what: `Parents for ${tableKey(f.child)}.${f.column} → ${tableKey(f.parent)}.${f.refColumn}`,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        report.filled += added;
        report.rows += added;
        if (added === 0) break;
        progress({ stage: 'parents', text: `Fetched ${added.toLocaleString()} parent rows` });
      }
    }

    progress({ stage: 'objects', text: 'Keys, indexes, identities and views' });
    await target.query("SET session_replication_role = 'origin'");
    await finishTables(target, plan, req.catalog, redshift, report);
    await copyViews(source, target, plan, report);

    progress({ stage: 'users', text: 'The account overdb connects as' });
    if (req.login && req.login.user && req.login.user !== 'postgres') {
      // Local and loopback-only, so the account can do anything: services
      // run their own migrations against a copy. Redshift's IAM user names
      // (`IAM:alice`) are not names Postgres takes, and are left out.
      const who = req.login.user;
      if (/^[A-Za-z_][\w$.-]*$/.test(who)) {
        const pw = `'${req.login.password.replace(/'/g, "''")}'`;
        const has = await target.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [who]);
        await target.query(`${has.rowCount ? 'ALTER' : 'CREATE'} ROLE ${q(who)} LOGIN SUPERUSER PASSWORD ${pw}`);
      } else {
        report.skipped.push({ what: `account ${who}`, reason: 'Not a name Postgres accepts; connect as postgres.' });
      }
    }

    await target.query(`ALTER ROLE postgres PASSWORD '${req.admin.replace(/'/g, "''")}'`);
    await target.query('ANALYZE').catch(() => undefined);
    progress({ stage: 'finish', text: `Built: ${report.tables} tables, ${report.rows.toLocaleString()} rows` });
    report.durationMs = Date.now() - started;
    return report;
  } finally {
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
  }
}

/// After the rows: duplicates out of keyless tables, indexes, foreign keys (NOT VALID — a kept
/// row may point at a parent the base left out), and identity counters
/// moved past the copied ids. Each that the copy refuses is reported.
async function finishTables(target: Client, plan: BuildPlan, catalog: PgTable[], redshift: boolean, report: BuildReport): Promise<void> {
  const planned = new Set(plan.tables.map((t) => tableKey(t.ref)));
  const skip = (what: string, err: unknown) => report.skipped.push({ what, reason: err instanceof Error ? err.message : String(err) });
  for (const t of catalog) {
    const ref = { schema: t.schema, table: t.table };
    if (!planned.has(tableKey(ref))) continue;
    if (t.primaryKey.length === 0) {
      // No key to keep a row from arriving twice — every Redshift table —
      // so exact duplicates are removed once the rows are in.
      // Compared as text: json, xml and point have no equality to group by.
      const cols = t.columns.map((c) => `${q(c.name)}::text`).join(', ');
      await target
        .query(
          `DELETE FROM ${qt(ref)} WHERE ctid IN (SELECT ctid FROM (SELECT ctid, row_number() OVER (PARTITION BY ${cols}) AS n FROM ${qt(ref)}) d WHERE n > 1)`,
        )
        .catch((err) => skip(`duplicate rows in ${tableKey(ref)}`, err));
    }
    if (!redshift) {
      for (const ix of t.indexes) {
        if (ix.columns.length === 0 || ix.columns.every((c) => t.primaryKey.includes(c))) continue;
        await target
          .query(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(ix.name)} ON ${qt(ref)} (${ix.columns.map(q).join(', ')})`)
          .catch((e) => skip(`index ${ix.name}`, e));
      }
    }
    for (const c of t.columns) {
      if (!/^(nextval\(|"?identity"?\s*\()/i.test(c.defaultExpr ?? '')) continue;
      await target
        .query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${q(c.name)}) FROM ${qt(ref)}), 0) + 1, false)`, [qt(ref), c.name])
        .catch(() => undefined);
    }
  }
  for (const t of catalog) {
    const ref = { schema: t.schema, table: t.table };
    if (!planned.has(tableKey(ref))) continue;
    for (const fk of t.foreignKeys) {
      const to = { schema: fk.refSchema ?? t.schema, table: fk.refTable };
      if (!planned.has(tableKey(to))) continue;
      await target
        .query(
          `ALTER TABLE ${qt(ref)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${qt(to)} (${fk.refColumns.map(q).join(', ')}) NOT VALID`,
        )
        .catch((e) => skip(`foreign key ${fk.name}`, e));
    }
  }
}

/// Views over the copied tables. Redshift's own functions do not exist
/// here, so a view using one is reported, not fatal; views over views are
/// retried until a pass makes no progress.
async function copyViews(source: Client, target: Client, plan: BuildPlan, report: BuildReport): Promise<void> {
  const r = await source
    .query({ text: 'SELECT schemaname, viewname, definition FROM pg_views WHERE schemaname = ANY($1)', values: [plan.schemas], rowMode: 'array' })
    .catch(() =>
      source.query({
        text: `SELECT schemaname, viewname, definition FROM pg_views WHERE schemaname IN (${plan.schemas.map((_, i) => `$${i + 1}`).join(', ') || 'NULL'})`,
        values: plan.schemas,
        rowMode: 'array',
      }),
    )
    .catch(() => null);
  let pending = ((r?.rows ?? []) as string[][]).map(([s, v, def]) => ({ s, v, def }));
  for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
    const failed: typeof pending = [];
    const why = new Map<string, string>();
    for (const x of pending) {
      try {
        // One SELECT, as the catalog prints it. A definition carrying a
        // second statement is not a view, and is never run here.
        const def = x.def.replace(/;\s*$/, '');
        if (def.includes(';')) throw new Error('Its definition holds more than one statement; not recreated.');
        await target.query(`CREATE OR REPLACE VIEW ${q(x.s)}.${q(x.v)} AS ${def}`);
      } catch (err) {
        failed.push(x);
        why.set(`${x.s}.${x.v}`, err instanceof Error ? err.message : String(err));
      }
    }
    if (failed.length === pending.length) {
      for (const x of failed) report.skipped.push({ what: `view ${x.s}.${x.v}`, reason: why.get(`${x.s}.${x.v}`) ?? '' });
      break;
    }
    pending = failed;
  }
}
