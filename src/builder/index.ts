// The baseline builder: one process per build, holding two sessions — your
// own server, read-only, and the empty instance overdb started for the
// baseline — and carrying out a BuildPlan between them. See
// docs/design/baselines.md and src/shared/baselineBuild.ts.
//
// It talks to MySQL through the raw driver rather than the adapter, because
// the adapter shapes values for a grid and this has to write them back
// exactly: dates stay strings, JSON stays text, binary stays bytes. Like
// the connection host it never imports electron, and it runs under
// Electron's utilityProcess or plain node alike.

import mysql from 'mysql2';
import type { Connection, RowDataPacket } from 'mysql2';
import type { Connection as PromiseConnection } from 'mysql2/promise';
import type { BuildPlan, BuildProgress, BuildReport, BuildTable, FollowRule } from '../shared/baselineBuild';
import { tableKey, type TableRef } from '../shared/baseline';
import type { ConnectSpec } from '../db/adapter';
import { tlsOptions } from '../db/tls';
import { buildPostgres, type PgBuildRequest } from './pg';

export interface Endpoint {
  host?: string;
  port?: number;
  socketPath?: string;
  user?: string;
  password?: string;
  /// Postgres only: the database the copy is read from and written to.
  database?: string;
  /// How a shared server is reached securely: the connection's own TLS
  /// settings, turned into options on this side because they include a
  /// function that cannot cross between processes.
  tls?: Pick<ConnectSpec, 'engine' | 'ssl' | 'sslRootCert' | 'sslCert' | 'sslKey' | 'tlsServerName' | 'host'>;
}

export type BuilderRequest = ({ op: 'buildPostgres' } & PgBuildRequest) | {
  op: 'build';
  source: Endpoint;
  target: Endpoint;
  plan: BuildPlan;
  /// The account overdb itself connects to the source as. The baseline's
  /// copy of it gets the same password, so the same connection settings
  /// reach a ticket copy.
  login: { user: string; password: string } | null;
  /// The copy's own root password, set last: until then the build alone
  /// uses root, and after it nothing on this machine reaches the copy — or
  /// the account hashes it keeps for your services — without a password.
  admin: string;
};

export type BuilderMessage =
  | { kind: 'progress'; progress: BuildProgress }
  | { kind: 'done'; report: BuildReport }
  /// `sql`: the statement the server refused, when it was one — the build
  /// log keeps it, so a failure says what was being asked, not only why not.
  | { kind: 'failed'; error: string; sql?: string };

interface Wire {
  send(msg: BuilderMessage): void;
  onMessage(fn: (msg: BuilderRequest) => void): void;
}

function transport(): Wire {
  const pp = (process as unknown as { parentPort?: { postMessage(m: unknown): void; on(e: 'message', f: (ev: { data: unknown }) => void): void } }).parentPort;
  if (pp) {
    return {
      send: (m) => pp.postMessage(m),
      onMessage: (fn) => pp.on('message', (ev) => fn(ev.data as BuilderRequest)),
    };
  }
  return {
    send: (m) => process.send?.(m),
    onMessage: (fn) => process.on('message', (m) => fn(m as BuilderRequest)),
  };
}

/// Rows per INSERT, and the bytes past which a batch goes early, well
/// under MySQL's default 64 MB max_allowed_packet.
const BATCH_ROWS = 500;
const BATCH_BYTES = 4 * 1024 * 1024;
/// Keys per `IN (…)` when following a parent.
const KEY_CHUNK = 2_000;
/// Rounds of fetching missing parents: a parent can itself point at one.
const FILL_ROUNDS = 4;

const q = (name: string) => '`' + name.replace(/`/g, '``') + '`';

/// Server settings copied from the source before any table is created,
/// besides sql_mode: whether InnoDB refuses a table or row it would only warn
/// about, and the row format a table gets when its DDL names none.
const MIRRORED = ['innodb_strict_mode', 'innodb_default_row_format'] as const;
const qt = (ref: TableRef) => `${q(ref.schema)}.${q(ref.table)}`;

function open(ep: Endpoint): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const c = mysql.createConnection({
      host: ep.socketPath ? undefined : ep.host ?? '127.0.0.1',
      port: ep.socketPath ? undefined : ep.port ?? 3306,
      socketPath: ep.socketPath,
      user: ep.user,
      password: ep.password,
      ssl: ep.tls ? tlsOptions(ep.tls as ConnectSpec) : undefined,
      charset: 'utf8mb4',
      // Values go back exactly as they came: no Date objects (and their
      // time zones), no floating-point decimals, no parsed JSON.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // MariaDB keeps JSON as LONGTEXT flagged `format=json`, which mysql2
      // parses unless told not to — and a parsed array goes back into an
      // INSERT as a row of '[object Object]'s. Text in, text out.
      jsonStrings: true,
      typeCast(field, next) {
        if (field.type === 'JSON') return field.string('utf8');
        if (field.type === 'GEOMETRY') return field.buffer();
        return next();
      },
    });
    c.connect((err) => (err ? reject(err) : resolve(c)));
  });
}

async function rows<T = RowDataPacket>(c: PromiseConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await c.query(sql, params);
  return r as T[];
}

/// `DEFINER=`app`@`%`` names an account the baseline may not have; without
/// it the object runs as whoever creates it, which here is root.
function dropDefiner(ddl: string): string {
  return ddl.replace(/\sDEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '');
}

function sizeOf(row: unknown[]): number {
  let n = 0;
  for (const v of row) {
    if (v === null || v === undefined) n += 4;
    else if (Buffer.isBuffer(v)) n += v.length * 2;
    else n += String(v).length + 2;
  }
  return n;
}

async function build(req: BuilderRequest, progress: (p: BuildProgress) => void): Promise<BuildReport> {
  const started = Date.now();
  const report: BuildReport = { tables: 0, rows: 0, copied: {}, filled: 0, skipped: [], durationMs: 0 };
  const plan = req.plan;
  setStartKeys(plan);

  progress({ stage: 'start', text: 'Connecting to your server and to the new instance' });
  const sourceRaw = await open(req.source);
  const targetRaw = await open(req.target);
  const source = sourceRaw.promise();
  const target = targetRaw.promise();

  try {
    // One clock for both sides, so a TIMESTAMP reads and writes the same.
    await source.query("SET SESSION time_zone = '+00:00'");
    await target.query("SET SESSION time_zone = '+00:00'");
    // Loading, not running the app: no key checks while parents and
    // children arrive in batches, and zero dates and zero ids kept as they
    // are rather than refused or renumbered.
    await target.query("SET SESSION foreign_key_checks = 0, unique_checks = 0, sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
    // The app runs with the server's own mode once the baseline is in use.
    const [mode] = await rows<{ m: string }>(source, 'SELECT @@GLOBAL.sql_mode AS m');
    await target.query('SET PERSIST sql_mode = ?', [mode?.m ?? '']).catch(() => target.query('SET GLOBAL sql_mode = ?', [mode?.m ?? '']));
    report.settings = { sql_mode: mode?.m ?? '' };
    // What decides whether a table or a row is accepted at all, as the
    // server has it. RDS and Aurora run with strict mode off, so a COMPACT
    // table whose widest row would pass 8 KB was created there with a
    // warning — and a local server's default refuses the same CREATE.
    const matched: string[] = [];
    for (const name of MIRRORED) {
      const [v] = await rows<{ v: string | number | null }>(source, `SELECT @@GLOBAL.${name} AS v`).catch(() => []);
      if (v?.v === null || v?.v === undefined) continue;
      // The build's own session first: CREATE TABLE reads it, not the global.
      await target.query(`SET SESSION ${name} = ?`, [v.v]).catch(() => undefined);
      await target.query(`SET PERSIST ${name} = ?`, [v.v]).catch(() => target.query(`SET GLOBAL ${name} = ?`, [v.v]).catch(() => undefined));
      const value = String(v.v) === '0' ? 'OFF' : String(v.v) === '1' ? 'ON' : String(v.v);
      matched.push(`${name} ${value}`);
      report.settings = { ...report.settings, [name]: value };
    }
    if (matched.length) progress({ stage: 'start', text: `Matching the server's settings: ${matched.join(', ')}` });

    progress({ stage: 'schemas', text: `Creating ${plan.schemas.length} schemas` });
    for (const s of plan.schemas) {
      const [ddl] = await rows<Record<string, string>>(source, `SHOW CREATE DATABASE ${q(s)}`);
      const text = ddl?.['Create Database'] ?? `CREATE DATABASE ${q(s)}`;
      await target.query(text.replace(/^CREATE DATABASE\s+(IF NOT EXISTS\s+)?/i, 'CREATE DATABASE IF NOT EXISTS '));
    }

    progress({ stage: 'tables', text: `Creating ${plan.tables.length} tables`, done: 0, total: plan.tables.length });
    for (const [i, t] of plan.tables.entries()) {
      const [ddl] = await rows<Record<string, string>>(source, `SHOW CREATE TABLE ${qt(t.ref)}`);
      await target.query(`USE ${q(t.ref.schema)}`);
      await target.query(ddl['Create Table']);
      report.tables++;
      if ((i + 1) % 50 === 0) progress({ stage: 'tables', text: `Created ${i + 1} tables`, done: i + 1, total: plan.tables.length });
    }

    // Columns a row is written with: every one the server does not compute.
    const writable = new Map<string, string[]>();
    const cols = await rows<{ s: string; t: string; c: string; x: string }>(
      source,
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, EXTRA AS x FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      [plan.schemas],
    );
    for (const r of cols) {
      if (/GENERATED/i.test(r.x ?? '')) continue;
      const k = `${r.s}.${r.t}`;
      writable.set(k, [...(writable.get(k) ?? []), r.c]);
    }

    /// Stream a SELECT from the source into the same table on the target.
    const copy = async (ref: TableRef, where: string, params: unknown[]): Promise<number> => {
      const columns = writable.get(tableKey(ref));
      if (!columns || columns.length === 0) return 0;
      const list = columns.map(q).join(', ');
      const insert = `INSERT IGNORE INTO ${qt(ref)} (${list}) VALUES ?`;
      const stream = sourceRaw.query({ sql: `SELECT ${list} FROM ${qt(ref)}${where}`, rowsAsArray: true }, params).stream({ highWaterMark: BATCH_ROWS });
      let batch: unknown[][] = [];
      let bytes = 0;
      let n = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const [res] = await target.query(insert, [batch]);
        n += (res as { affectedRows?: number }).affectedRows ?? batch.length;
        batch = [];
        bytes = 0;
      };
      for await (const row of stream as AsyncIterable<unknown[]>) {
        batch.push(row);
        bytes += sizeOf(row);
        if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
      }
      await flush();
      return n;
    };

    const copyIn = async (ref: TableRef, column: string, values: unknown[], when?: { column: string; value: string }): Promise<number> => {
      let n = 0;
      for (let i = 0; i < values.length; i += KEY_CHUNK) {
        n += when
          ? await copy(ref, ` WHERE ${q(when.column)} = ? AND ${q(column)} IN (?)`, [when.value, values.slice(i, i + KEY_CHUNK)])
          : await copy(ref, ` WHERE ${q(column)} IN (?)`, [values.slice(i, i + KEY_CHUNK)]);
      }
      return n;
    };

    const withRows = plan.tables.filter((t) => t.rows.kind !== 'none');
    progress({ stage: 'rows', text: `Copying rows into ${withRows.length} tables`, done: 0, total: withRows.length });
    for (const [i, t] of withRows.entries()) {
      // One table the server will not take rows for is named in the report
      // and left with what it got; the other few hundred still copy.
      let n = 0;
      let failed: string | null = null;
      try {
        n = await copyTable(t, copy, copyIn, target);
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
          if (failedFills.has(f)) continue;
          // Completing a key is best effort — foreign key checks are off, so
          // a parent that cannot be fetched leaves a dangling id, not a
          // broken base. One that fails is named in the report and the
          // rest carry on, rather than the whole build stopping on it.
          try {
            const missing = await rows<{ v: unknown }>(
              target,
              `SELECT DISTINCT c.${q(f.column)} AS v FROM ${qt(f.child)} c
                 LEFT JOIN ${qt(f.parent)} p ON p.${q(f.refColumn)} = c.${q(f.column)}
                WHERE c.${q(f.column)} IS NOT NULL AND p.${q(f.refColumn)} IS NULL${f.when ? ` AND c.${q(f.when.column)} = ?` : ''}`,
              f.when ? [f.when.value] : [],
            );
            if (missing.length === 0) continue;
            const n = await copyIn(f.parent, f.refColumn, missing.map((m) => m.v));
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

    progress({ stage: 'objects', text: 'Recreating views, routines and triggers' });
    await recreateObjects(source, target, plan, report);

    progress({ stage: 'users', text: 'Recreating the accounts your services connect as' });
    await recreateUsers(source, target, report, req.login);
    await lockRoot(target, req.admin);

    report.durationMs = Date.now() - started;
    progress({ stage: 'finish', text: `Built: ${report.tables} tables, ${report.rows.toLocaleString()} rows` });
    return report;
  } finally {
    sourceRaw.destroy();
    targetRaw.destroy();
  }
}

async function copyTable(
  t: BuildTable,
  copy: (ref: TableRef, where: string, params: unknown[]) => Promise<number>,
  copyIn: (ref: TableRef, column: string, values: unknown[], when?: { column: string; value: string }) => Promise<number>,
  target: PromiseConnection,
): Promise<number> {
  const r = t.rows;
  switch (r.kind) {
    case 'none':
      return 0;
    case 'all':
      return copy(t.ref, '', []);
    case 'keys': {
      const n = await copyIn(t.ref, r.column, r.values);
      return r.also ? n + (await follow(t.ref, r.also, copy, copyIn, target)) : n;
    }
    case 'follows':
      return follow(t.ref, r, copy, copyIn, target);
  }
}

/// Rows whose column holds a key already copied into the parent — and,
/// following a narrowed level, the tenant's rows that belong to no level.
/// The keys a person started from, by table and column. A table that
/// follows its starting point follows these too, even when that row is not
/// in the table itself — a data mart keeps one client in several tables,
/// and the one most tables point at may not hold the one you picked.
let startKeys = new Map<string, unknown[]>();

function setStartKeys(plan: BuildPlan): void {
  startKeys = new Map();
  for (const t of plan.tables) {
    if (t.rows.kind === 'keys') startKeys.set(`${tableKey(t.ref)}.${t.rows.column}`.toLowerCase(), t.rows.values);
  }
}

function withStartKeys(found: unknown[], parent: TableRef, column: string): unknown[] {
  const start = startKeys.get(`${tableKey(parent)}.${column}`.toLowerCase());
  if (!start) return found;
  const have = new Set(found.map((v) => String(v)));
  return [...found, ...start.filter((v) => !have.has(String(v)))];
}

async function follow(
  ref: TableRef,
  r: FollowRule,
  copy: (ref: TableRef, where: string, params: unknown[]) => Promise<number>,
  copyIn: (ref: TableRef, column: string, values: unknown[], when?: { column: string; value: string }) => Promise<number>,
  target: PromiseConnection,
): Promise<number> {
  const keysOf = async (parent: TableRef, column: string) => {
    const got = await rows<{ v: unknown }>(target, `SELECT DISTINCT ${q(column)} AS v FROM ${qt(parent)} WHERE ${q(column)} IS NOT NULL`);
    return withStartKeys(got.map((x) => x.v), parent, column).map((v) => ({ v }));
  };
  const parents = await keysOf(r.parent, r.refColumn);
  let n = parents.length === 0 ? 0 : await copyIn(ref, r.column, parents.map((p) => p.v), r.when);
  for (const m of r.more ?? []) n += await follow(ref, m, copy, copyIn, target);
  if (r.orUnassigned) {
    const u = r.orUnassigned;
    const tenants = await keysOf(u.parent, u.refColumn);
    for (let i = 0; i < tenants.length; i += KEY_CHUNK) {
      n += await copy(ref, ` WHERE ${q(r.column)} IS NULL AND ${q(u.column)} IN (?)`, [tenants.slice(i, i + KEY_CHUNK).map((x) => x.v)]);
    }
  }
  return n;
}

/// Views, then routines, then triggers — triggers last, so loading the rows
/// above never fired one. A view over a table the recipe left out cannot be
/// created; that is reported, not fatal.
async function recreateObjects(source: PromiseConnection, target: PromiseConnection, plan: BuildPlan, report: BuildReport) {
  const views = await rows<{ s: string; n: string }>(
    source,
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA IN (?)`,
    [plan.schemas],
  );
  // Views over views: retry until a pass creates nothing new.
  let pending = views;
  for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
    const failed: typeof pending = [];
    const reasons = new Map<string, string>();
    for (const v of pending) {
      try {
        const [ddl] = await rows<Record<string, string>>(source, `SHOW CREATE VIEW ${q(v.s)}.${q(v.n)}`);
        await target.query(`USE ${q(v.s)}`);
        await target.query(dropDefiner(ddl['Create View']));
      } catch (err) {
        failed.push(v);
        reasons.set(`${v.s}.${v.n}`, err instanceof Error ? err.message : String(err));
      }
    }
    if (failed.length === pending.length) {
      for (const v of failed) report.skipped.push({ what: `view ${v.s}.${v.n}`, reason: reasons.get(`${v.s}.${v.n}`) ?? '' });
      break;
    }
    pending = failed;
  }

  const routines = await rows<{ s: string; n: string; t: string }>(
    source,
    `SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (?)`,
    [plan.schemas],
  );
  for (const r of routines) {
    const kind = r.t === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    try {
      const [ddl] = await rows<Record<string, string>>(source, `SHOW CREATE ${kind} ${q(r.s)}.${q(r.n)}`);
      const text = ddl[kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure'];
      if (!text) throw new Error('the server did not show its definition');
      await target.query(`USE ${q(r.s)}`);
      await target.query(dropDefiner(text));
    } catch (err) {
      report.skipped.push({ what: `${kind.toLowerCase()} ${r.s}.${r.n}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const triggers = await rows<{ s: string; n: string; t: string }>(
    source,
    `SELECT TRIGGER_SCHEMA AS s, TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (?)`,
    [plan.schemas],
  );
  const tables = new Set(plan.tables.map((t) => tableKey(t.ref)));
  for (const tr of triggers) {
    if (!tables.has(`${tr.s}.${tr.t}`)) continue;
    try {
      const [ddl] = await rows<Record<string, string>>(source, `SHOW CREATE TRIGGER ${q(tr.s)}.${q(tr.n)}`);
      await target.query(`USE ${q(tr.s)}`);
      await target.query(dropDefiner(ddl['SQL Original Statement']));
    } catch (err) {
      report.skipped.push({ what: `trigger ${tr.s}.${tr.n}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }
}

/// MySQL's own accounts stay as the new instance made them.
const SYSTEM_USERS = new Set(['mysql.sys', 'mysql.session', 'mysql.infoschema', 'root']);

/// Every account on your server, with its password hash, and its grants —
/// so a service that connects as `app` today connects to a ticket copy the
/// same way. The account overdb uses gets its password set outright, since
/// that is the one overdb has to reach the copy with.
async function recreateUsers(
  source: PromiseConnection,
  target: PromiseConnection,
  report: BuildReport,
  login: { user: string; password: string } | null,
) {
  const users = await rows<{ u: string; h: string }>(source, 'SELECT User AS u, Host AS h FROM mysql.user').catch((err) => {
    report.skipped.push({ what: 'accounts', reason: `your server would not list them: ${err instanceof Error ? err.message : String(err)}` });
    return [] as Array<{ u: string; h: string }>;
  });
  for (const { u, h } of users) {
    if (SYSTEM_USERS.has(u)) continue;
    const who = `${mysql.escape(u)}@${mysql.escape(h)}`;
    try {
      const [create] = await rows<Record<string, string>>(source, `SHOW CREATE USER ${who}`);
      const text = Object.values(create)[0];
      await target.query(text.replace(/^CREATE USER\s+(IF NOT EXISTS\s+)?/i, 'CREATE USER IF NOT EXISTS '));
      const grants = await rows<Record<string, string>>(source, `SHOW GRANTS FOR ${who}`);
      for (const g of grants) {
        const stmt = Object.values(g)[0];
        await target.query(stmt).catch((err) => {
          report.skipped.push({ what: `grant for ${u}@${h}`, reason: err instanceof Error ? err.message : String(err) });
        });
      }
    } catch (err) {
      report.skipped.push({ what: `account ${u}@${h}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (login) {
    // Reachable from 127.0.0.1 and over the socket alike.
    for (const host of ['localhost', '127.0.0.1', '%']) {
      const who = `${mysql.escape(login.user)}@${mysql.escape(host)}`;
      await target.query(`CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ?`, [login.password]);
      await target.query(`ALTER USER ${who} IDENTIFIED BY ?`, [login.password]);
      await target.query(`GRANT ALL PRIVILEGES ON *.* TO ${who} WITH GRANT OPTION`);
    }
  }
  await target.query('FLUSH PRIVILEGES');
}

/// The copy's root accounts get their password, and the anonymous ones a
/// fresh instance may have are dropped. The last statement of a build.
async function lockRoot(target: PromiseConnection, admin: string) {
  const roots = await rows<{ u: string; h: string }>(target, "SELECT User AS u, Host AS h FROM mysql.user WHERE User IN ('root', '')");
  for (const { u, h } of roots) {
    const who = `${mysql.escape(u)}@${mysql.escape(h)}`;
    await target.query(u === '' ? `DROP USER IF EXISTS ${who}` : `ALTER USER ${who} IDENTIFIED BY ?`, u === '' ? [] : [admin]);
  }
  await target.query('FLUSH PRIVILEGES');
}

/// An account statement with its password or hash masked: `IDENTIFIED BY
/// '…'`, `BY PASSWORD '…'`, `AS '…'` (MySQL) and `USING '…'` (MariaDB).
export function redactSecrets(sql: string): string {
  if (!/\bIDENTIFIED\b|\bPASSWORD\b/i.test(sql)) return sql;
  return sql
    .replace(/\b(BY|AS|USING|PASSWORD)(\s*(?:PASSWORD\s*)?(?:\(\s*)?)'(?:[^'\\]|\\.)*'/gi, "$1$2'…'")
    // The same hash printed as hex (print_identified_with_as_hex).
    .replace(/\b(BY|AS|USING)(\s+)0x[0-9a-f]+/gi, '$1$20x…');
}

const wire = transport();
wire.onMessage((req) => {
  if (req.op !== 'build' && req.op !== 'buildPostgres') return;
  const send = (progress: BuildProgress) => wire.send({ kind: 'progress', progress });
  (req.op === 'buildPostgres' ? buildPostgres(req, send) : build(req, send))
    // A skipped statement's error can quote it, and an account's with it.
    .then((report) => wire.send({ kind: 'done', report: { ...report, skipped: report.skipped.map((x) => ({ ...x, reason: redactSecrets(x.reason) })) } }))
    .catch((err) => {
      // mysql2 puts the statement on its errors; long ones are cut.
      // A password never reaches the log: the accounts step sets them.
      const sql =
        typeof (err as { sql?: unknown })?.sql === 'string'
          ? redactSecrets((err as { sql: string }).sql).slice(0, 4000)
          : undefined;
      wire.send({ kind: 'failed', error: err instanceof Error ? err.message : String(err), ...(sql ? { sql } : {}) });
    })
    .finally(() => setTimeout(() => process.exit(0), 50));
});

