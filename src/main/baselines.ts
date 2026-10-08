// Baselines and ticket copies: building one, cloning it per ticket, running
// the copies, and pointing the proxy at one. See docs/design/baselines.md.
//
// Records live in `instances/records.json` under overdb's data; the data
// directories beside them. Nothing here touches your own server except
// through the builder's read-only session.

import { utilityProcess } from 'electron';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Connection } from '../shared/types';
import type { BuildPlan, BuildProgress, BuildReport } from '../shared/baselineBuild';
import type {
  BaselineRecord,
  HelperStatus,
  ProxyClient,
  ProxyConfig,
  ProxyState,
  ProxyTarget,
  TicketRecord,
  TicketState,
} from '../shared/instances';
import { baseOf, proxyConnectionId } from '../shared/instances';
import type { BuilderMessage, BuilderRequest, Endpoint } from '../builder/index';
import type { PgTable } from '../builder/pg';
import * as instances from './instances';
import { copySecret, deleteSecret, getSecret, hasSecret, setSecret } from './secrets';
import { LocalRuntime, proxyEntry, readRecords, updateRecords, type Runtime } from './runtime';
import { AuthPrimer, mysqlLogin, type Account } from './authPrimer';
import { Store } from './store';
import { HelperClient } from './helperClient';
import * as helperInstall from './helperInstall';
import { helperSocket } from '../helper/index';

export function root(): string {
  return path.join(app.getPath('userData'), 'instances');
}

// ---- who runs things -----------------------------------------------------
//
// Ticket copies and the proxy have exactly one owner: overdb itself, or the
// background helper when it is installed. Building a baseline is always
// overdb's — its instance is overdb's own for the length of the build.

let local: LocalRuntime | null = null;
let helperClient: HelperClient | null = null;
let helperMode: boolean | null = null;

async function rt(): Promise<Runtime> {
  if (helperMode === null) helperMode = await helperInstall.isInstalled(root());
  if (helperMode) return (helperClient ??= new HelperClient(helperSocket(root())));
  return (local ??= new LocalRuntime(root(), { primer }));
}

/// The accounts a MySQL base's proxy warms at its current target, read here
/// in main and handed only to the primer — never logged, never over IPC.
///
/// The source connection's own login, when overdb keeps its password: the
/// build gave a branch that account with the same password, and your own
/// server has it already. On a branch, root too, with the password its base
/// gave it — what a connection with no stored password uses. A password
/// fetched at connect time (1Password, a command, IAM) is not fetched here:
/// that would mean a prompt, or a command run, at a service's connection.
async function primerAccounts(sourceId: string): Promise<Account[]> {
  const r = await readRecords(root());
  const base = r.baselines.find((b) => b.sourceConnectionId === sourceId);
  const conn = Store.load().connections.find((c) => c.id === sourceId);
  // caching_sha2_password is MySQL's; MariaDB and Postgres have no such cache.
  if (!conn || conn.engine !== 'mysql' || (base?.flavor && base.flavor !== 'mysql')) return [];
  const out: Account[] = [];
  const stored = (!conn.secretSource || conn.secretSource === 'stored') && conn.secretRef ? getSecret(conn.secretRef) : undefined;
  if (conn.user && stored) out.push({ user: conn.user, password: stored });
  const target = proxyEntry(r, sourceId).target;
  if (target.kind === 'ticket') {
    const t = r.tickets.find((x) => x.id === target.id);
    const ref = t ? baseOf(t, r.baselines)?.adminSecret : undefined;
    const admin = ref && hasSecret(ref) ? getSecret(ref) : undefined;
    if (admin && !out.some((a) => a.user === 'root')) out.push({ user: 'root', password: admin });
  }
  return out;
}

/// overdb's own primer, for the proxies it runs itself. The helper has none.
const primer = new AuthPrimer({
  accounts: (source) => primerAccounts(source),
  login: mysqlLogin,
});


export async function helperStatus(): Promise<HelperStatus> {
  const installed = await helperInstall.isInstalled(root());
  if (!installed) return { installed, running: false, pid: null, error: null };
  try {
    const { pid } = await new HelperClient(helperSocket(root())).ping();
    return { installed, running: true, pid, error: null };
  } catch (err) {
    return { installed, running: false, pid: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/// Hand everything to the background helper: stop what overdb runs itself,
/// install the agent, and wait for it to answer — it brings the proxy back
/// from the records on its own.
export async function enableHelper(): Promise<HelperStatus> {
  const wasLocal = local;
  if (wasLocal) await wasLocal.shutdown();
  primer.forget();
  await helperInstall.install({
    root: root(),
    script: path.join(__dirname, '..', 'helper', 'index.js'),
    exec: process.execPath,
  });
  helperMode = true;
  helperClient = new HelperClient(helperSocket(root()));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await helperStatus();
    if (s.running) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  return helperStatus();
}

/// Take everything back: the helper stops the proxy and every copy, the
/// agent is removed, and overdb runs the proxy itself again if it was on.
export async function disableHelper(): Promise<HelperStatus> {
  await helperInstall.uninstall(root());
  helperMode = false;
  helperClient = null;
  // What the helper's servers were warmed with, overdb never knew.
  primer.forget();
  local = new LocalRuntime(root(), { primer });
  await local.resume().catch(() => undefined);
  return helperStatus();
}

// ---- building -------------------------------------------------------------

/// The builder is its own process, like a connection host: a build streams
/// hundreds of thousands of rows, and none of that belongs on main's loop.
function runBuilder(req: BuilderRequest, onProgress: (p: BuildProgress) => void, signal: { cancelled: boolean; kill?: () => void }): Promise<BuildReport> {
  return new Promise((resolve, reject) => {
    // stderr is kept: a crash the builder cannot catch — V8 out of memory,
    // say — leaves its only account of itself there.
    const proc = utilityProcess.fork(path.join(__dirname, '..', 'builder', 'index.js'), [], { serviceName: 'overdb-baseline-builder', stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf-8')).slice(-8_000);
    });
    proc.stdout?.resume();
    let settled = false;
    signal.kill = () => {
      if (!settled) proc.kill();
    };
    proc.on('message', (msg: BuilderMessage) => {
      if (msg.kind === 'progress') onProgress(msg.progress);
      else if (msg.kind === 'done') {
        settled = true;
        resolve(msg.report);
      } else {
        settled = true;
        reject(Object.assign(new Error(msg.error), msg.sql ? { sql: msg.sql } : {}));
      }
    });
    proc.on('exit', (code) => {
      if (settled) return;
      if (signal.cancelled) return reject(new Error('Stopped.'));
      const said = stderr.trim();
      reject(new Error(`The builder stopped before it finished (exit code ${code}).${said ? `\nIts last output:\n${said.split('\n').slice(-25).join('\n')}` : ''}`));
    });
    proc.postMessage(req);
  });
}

export interface BuildArgs {
  source: Connection;
  /// The source's resolved address and credentials. Main only.
  endpoint: Endpoint;
  plan: BuildPlan;
  serverVersion: string;
  recipeSavedAt: string;
  label: string;
  /// Postgres and Redshift: the planned tables as discovery read them, and
  /// whether the source is Redshift.
  catalog?: PgTable[];
  redshift?: boolean;
  onProgress(p: BuildProgress): void;
  signal: { cancelled: boolean; kill?: () => void };
}

/// Build a baseline into a fresh instance and freeze it. The previous
/// baseline for the same connection is replaced only once this one has
/// finished; ticket copies made from it are independent and stay.
const KIND: Record<instances.Flavor, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'Postgres' };

export async function buildBaseline(args: BuildArgs): Promise<BaselineRecord> {
  if (args.source.engine !== 'mysql' && args.source.engine !== 'postgres') throw new Error('Bases are for MySQL, MariaDB, Postgres and Redshift.');
  const flavor = instances.copyFlavor(args.source.engine, args.serverVersion) ?? 'mysql';
  const bin = await instances.findMysqld(args.serverVersion, flavor);
  if (!bin) {
    const log = await openBuildLog();
    log.write(`Base for ${args.source.name}, from ${args.serverVersion}`);
    log.write(`FAILED   no ${KIND[flavor]} server on this machine to build it with`);
    await log.close();
    const minor = args.serverVersion.match(/^(\d+\.\d+)/)?.[1];
    throw new Error(
      flavor === 'postgres'
        ? `A copy of ${args.redshift ? 'Redshift' : 'this server'} runs on Postgres, which is not installed here. Install it with \`brew install postgresql@17\`, then build again.`
        : flavor === 'mariadb'
          ? `This server is MariaDB ${minor ?? ''}; a base of it needs MariaDB here too. Install it with \`brew install mariadb${minor ? `@${minor}` : ''}\`, then build again.`
          : `This server is MySQL ${minor ?? ''}; a base of it needs MySQL here — MariaDB cannot load its tables. Install it with \`brew install mysql${minor ? `@${minor}` : ''}\`, then build again.`,
    );
  }

  const id = randomUUID();
  const dir = path.join(root(), 'baselines', id);
  const datadir = path.join(dir, 'data');
  const log = await openBuildLog();
  log.write(`Base for ${args.source.name}, from ${args.serverVersion}`);
  log.write(`server ${bin.path} (${instances.flavorOf(bin)} ${bin.version})`);
  const kinds = args.plan.tables.reduce<Record<string, number>>((m, t) => ({ ...m, [t.rows.kind]: (m[t.rows.kind] ?? 0) + 1 }), {});
  log.write(
    `Plan: ${args.plan.schemas.length} schemas, ${args.plan.tables.length} tables (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), ${args.plan.fills.length} keys to complete`,
  );
  for (const w of args.plan.warnings) log.write(`WARNING  ${w}`);
  const say = (p: BuildProgress) => {
    log.write(`${p.stage.padEnd(8)} ${p.text}`);
    args.onProgress(p);
  };
  try {
    say({ stage: 'start', text: `Creating an empty ${KIND[instances.flavorOf(bin)]} ${bin.version} instance` });
    await instances.initialize(bin, datadir);
    if (args.signal.cancelled) throw new Error('Stopped.');
    const inst = await instances.start(id, bin, datadir);
    say({ stage: 'start', text: `Started it on port ${inst.port}` });

    const login = args.endpoint.user && args.endpoint.password !== undefined ? { user: args.endpoint.user, password: args.endpoint.password } : null;
    // The copy's superuser gets a password of its own — unless you connect
    // as that very account, which keeps yours so the same connection works.
    const pg = instances.flavorOf(bin) === 'postgres';
    const admin = login && login.user === (pg ? 'postgres' : 'root') ? login.password : randomBytes(24).toString('base64url');
    const report = await runBuilder(
      instances.flavorOf(bin) === 'postgres'
        ? {
            op: 'buildPostgres',
            source: args.endpoint,
            target: { host: '127.0.0.1', port: inst.port, user: 'postgres', password: '' },
            plan: args.plan,
            catalog: args.catalog ?? [],
            redshift: !!args.redshift,
            login,
            admin,
          }
        : {
            op: 'build',
            source: args.endpoint,
            target: { host: '127.0.0.1', port: inst.port, user: 'root', password: '' },
            plan: args.plan,
            login,
            admin,
          },
      say,
      args.signal,
    );

    say({ stage: 'finish', text: 'Stopping the instance — its data directory is the base' });
    await instances.stop(id);
    // Built with no password asked; from here on, every login needs one.
    if (pg) await instances.requirePasswords(datadir);
    const adminSecret = `base-admin-${id}`;
    setSecret(adminSecret, admin);
    const prior = (await readRecords(root())).baselines.find((b) => b.sourceConnectionId === args.source.id && b.named);
    const record: BaselineRecord = {
      id,
      sourceConnectionId: args.source.id,
      sourceName: args.source.name,
      datadir,
      mysqld: bin.path,
      version: bin.version,
      flavor: instances.flavorOf(bin),
      builtAt: new Date().toISOString(),
      recipeSavedAt: args.recipeSavedAt,
      label: prior?.label ?? args.label,
      ...(prior ? { named: true } : {}),
      bytes: await instances.dirBytes(datadir),
      report,
      adminSecret,
    };
    log.write(`Built: ${report.tables} tables, ${report.rows} rows, ${report.filled} parent rows filled, in ${Math.round(report.durationMs / 1000)} s`);
    for (const x of report.skipped) log.write(`skipped  ${x.what}: ${x.reason}`);
    await log.close();
    const old = await updateRecords(root(), (r) => {
      const was = r.baselines.filter((b) => b.sourceConnectionId === args.source.id);
      r.baselines = [...r.baselines.filter((b) => b.sourceConnectionId !== args.source.id), record];
      return was;
    });
    for (const b of old) {
      await fs.rm(path.dirname(b.datadir), { recursive: true, force: true });
      if (b.adminSecret) deleteSecret(b.adminSecret);
    }
    return record;
  } catch (err) {
    await instances.stop(id).catch(() => undefined);
    log.write(`FAILED   ${err instanceof Error ? err.message : String(err)}`);
    const sql = (err as { sql?: string })?.sql;
    if (sql) log.write(`statement:\n${sql}`);
    // The server's own account of it, before its directory goes.
    for (const name of ['initialize.log', 'mysqld.log']) {
      const tail = await fs.readFile(path.join(dir, name), 'utf-8').catch(() => '');
      if (tail.trim()) log.write(`${name}, last lines:\n${tail.trim().split('\n').slice(-25).join('\n')}`);
    }
    await log.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { log: log.path });
  }
}

/// Where build logs are kept: the last few, beside the instances, kept
/// whether the build worked or not — a failed build removes its own
/// directory, and without this nothing would say what it was doing.
const KEEP_LOGS = 20;

async function openBuildLog(): Promise<{ path: string; write(line: string): void; close(): Promise<void> }> {
  const dir = path.join(root(), 'logs');
  await fs.mkdir(dir, { recursive: true });
  const old = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('build-')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) await fs.rm(path.join(dir, n), { force: true });
  const file = path.join(dir, `build-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  let chain = fs.writeFile(file, '');
  return {
    path: file,
    write(line) {
      const at = new Date().toISOString().slice(11, 19);
      chain = chain.then(() => fs.appendFile(file, `${at}  ${line}\n`)).catch(() => undefined);
    },
    close: () => chain,
  };
}

/// Give a baseline a name of your choosing; a rebuild keeps it.
export async function renameBaseline(id: string, label: string): Promise<void> {
  const name = label.trim();
  if (!name) return;
  await updateRecords(root(), (r) => {
    r.baselines = r.baselines.map((b) => (b.id === id ? { ...b, label: name, named: true } : b));
  });
}

export async function baselines(): Promise<BaselineRecord[]> {
  return (await readRecords(root())).baselines;
}

// ---- ticket copies --------------------------------------------------------

export async function tickets(): Promise<TicketState[]> {
  return (await rt()).tickets();
}

/// The overdb connection for a ticket copy: the source connection's
/// settings, pointed at the copy. The baseline gave the source's account
/// the same password, so the same credential works; a stored one is copied
/// to the new connection here, inside main.
function ticketConnection(source: Connection, t: TicketRecord, base: BaselineRecord | undefined): Connection {
  return localCopyConnection(source, { id: t.connectionId, name: `${t.name} · branch`, port: t.port, secretRef: `ticket-${t.id}`, writes: true, adminRef: base?.adminSecret });
}

/// Where a branch's superuser password is kept: its base's.
export async function adminRefFor(ticketId: string): Promise<string | undefined> {
  const r = await readRecords(root());
  const t = r.tickets.find((x) => x.id === ticketId);
  return t ? baseOf(t, r.baselines)?.adminSecret : undefined;
}

/// A connection to something overdb runs on this machine — a branch, or a
/// proxy — made from the connection its data came from. Whatever reached the
/// source (a tunnel, TLS, certificates, an IAM token) does not reach a
/// local copy: it is a plain loopback server. A stored password works,
/// because the build gave the source's account the same one; a credential
/// fetched some other way (IAM, a command, 1Password) has no password to
/// copy, so the instance's own superuser — root, or postgres — is used.
function localCopyConnection(
  source: Connection,
  o: { id: string; name: string; port: number; secretRef: string; writes: boolean; adminRef?: string },
): Connection {
  // A Postgres copy's own superuser is `postgres`; Redshift's IAM names
  // (`IAM:alice`) are not names it takes, so those connect as it too.
  const pg = source.engine === 'postgres';
  const stored = (!source.secretSource || source.secretSource === 'stored') && (!pg || /^[A-Za-z_][\w$.-]*$/.test(source.user ?? ''));
  const conn: Connection = {
    ...source,
    // A copy of Redshift is Postgres, and is spoken to as Postgres.
    ...(pg ? { variant: 'postgres' as const } : {}),
    id: o.id,
    name: o.name,
    env: 'local',
    host: '127.0.0.1',
    port: o.port,
    tunnel: undefined,
    ssl: undefined,
    tlsServerName: undefined,
    sslRootCert: undefined,
    sslCert: undefined,
    sslKey: undefined,
    pinned: false,
    mcpExposed: false,
    lastOpenedAt: undefined,
    writesEnabled: o.writes,
    // Its repos are its source's, followed rather than copied.
    branchOf: source.id,
    repoPaths: undefined,
    repoSchemas: undefined,
    recipeRepo: undefined,
    ...(stored ? {} : { secretSource: 'stored' as const, user: pg ? 'postgres' : 'root', secretRef: undefined }),
  };
  if (stored && source.secretRef && hasSecret(source.secretRef)) {
    conn.secretRef = o.secretRef;
    copySecret(source.secretRef, conn.secretRef);
  } else if (!stored && o.adminRef && hasSecret(o.adminRef)) {
    // Its superuser, with the password the base gave it.
    conn.secretRef = o.secretRef;
    copySecret(o.adminRef, conn.secretRef);
  }
  return conn;
}

/// A branch's connection made again from its record and its source — for
/// a branch whose connection went missing from the list.
export async function branchConnection(id: string, source: Connection): Promise<Connection | null> {
  const r = await readRecords(root());
  const t = r.tickets.find((x) => x.id === id);
  return t ? ticketConnection(source, t, baseOf(t, r.baselines)) : null;
}

export async function createTicket(args: { baselineId: string; name: string; note: string; source: Connection }): Promise<{ ticket: TicketState; connection: Connection }> {
  const base = (await readRecords(root())).baselines.find((b) => b.id === args.baselineId);
  if (!base) throw new Error('That base no longer exists.');
  const id = randomUUID();
  const datadir = path.join(root(), 'tickets', id, 'data');
  await instances.cloneDir(base.datadir, datadir);
  await instances.makeDistinct(datadir);
  const record: TicketRecord = {
    id,
    name: args.name.trim() || 'Ticket',
    note: args.note.trim(),
    baselineId: base.id,
    sourceConnectionId: base.sourceConnectionId,
    datadir,
    port: 0,
    connectionId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await updateRecords(root(), (r) => {
    r.tickets.push(record);
  });
  // Started by whoever runs copies, which picks its port.
  const ticket = await (await rt()).startTicket(id);
  return { ticket, connection: ticketConnection(args.source, ticket, base) };
}

/// The overdb connection for a proxy: what its services see, to query.
/// Read-only — its target changes under it, so writing belongs to a copy's
/// own connection. One per proxy; its name says where it points.
export function proxyConnection(source: Connection, port: number, targetName: string, adminRef?: string): Connection {
  const id = proxyConnectionId(source.id);
  return localCopyConnection(source, { id, name: `Services see · ${targetName}`, port, secretRef: id, writes: false, adminRef });
}

/// The same window when the proxy points a shared server at itself: the
/// server's own login, through the proxy's port, read-only. Same id as on a
/// branch, so switching never moves it — only where it looks. TLS passes
/// through the proxy, so the certificate names the server, not 127.0.0.1:
/// it is checked against the server's own name. Through an SSH tunnel
/// the proxy cannot reach the server, and there is none.
export function proxyServerConnection(source: Connection, port: number): Connection | null {
  if (source.tunnel?.target?.trim()) return null;
  const id = proxyConnectionId(source.id);
  const conn: Connection = {
    ...source,
    id,
    name: `Services see · ${source.name}`,
    host: '127.0.0.1',
    port,
    tlsServerName: source.host,
    writesEnabled: false,
    pinned: false,
    mcpExposed: false,
    lastOpenedAt: undefined,
    branchOf: source.id,
    repoPaths: undefined,
    repoSchemas: undefined,
    recipeRepo: undefined,
  };
  if ((!source.secretSource || source.secretSource === 'stored') && source.secretRef && hasSecret(source.secretRef)) {
    conn.secretRef = id;
    copySecret(source.secretRef, id);
  }
  return conn;
}

export async function startTicket(id: string): Promise<TicketState> {
  return (await rt()).startTicket(id);
}

export async function stopTicket(id: string): Promise<void> {
  return (await rt()).stopTicket(id);
}

export async function resetTicket(id: string): Promise<TicketState> {
  return (await rt()).resetTicket(id);
}

export async function deleteTicket(id: string): Promise<TicketRecord | null> {
  return (await rt()).deleteTicket(id);
}

// ---- the proxy -------------------------------------------------------------

export async function proxyStates(): Promise<ProxyState[]> {
  return (await rt()).proxyStates();
}

export async function configureProxy(source: string, next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState> {
  return (await rt()).configureProxy(source, next);
}

export async function routeProxy(source: string, target: ProxyTarget): Promise<ProxyState & { dropped: number }> {
  return (await rt()).routeProxy(source, target);
}

export async function proxyClients(source: string): Promise<ProxyClient[]> {
  return (await rt()).proxyClients(source);
}

/// What quitting would stop. Nothing, when the helper runs things: it
/// carries on without overdb.
export async function inUse(): Promise<{ proxy: boolean; connections: number; running: string[] }> {
  if (helperMode ?? (await helperInstall.isInstalled(root()))) return { proxy: false, connections: 0, running: [] };
  return (await rt()).inUse();
}

/// Bring the proxy back if it was on when overdb last quit — when overdb
/// runs it. The helper resumes its own.
export async function resumeProxy(): Promise<void> {
  const r = await rt();
  if (r instanceof LocalRuntime) await r.resume();
}

/// overdb is quitting. What it runs itself stops; what the helper runs
/// carries on.
export async function shutdown(): Promise<void> {
  if (local) await local.shutdown();
  await instances.stopAll();
}

/// What a copy of a server needs on this machine: the binary it would be
/// built with, or the Homebrew formula that would provide one.
export async function serverFor(engine: string, serverVersion: string): Promise<{
  flavor: instances.Flavor | null;
  version: string;
  found: { path: string; version: string } | null;
  formula: string | null;
  brew: boolean;
}> {
  const flavor = instances.copyFlavor(engine, serverVersion);
  const found = await instances.findMysqld(serverVersion, flavor);
  const formula = found ? null : await instances.serverFormula(serverVersion, flavor);
  // The version the copy runs: the server's own for MySQL and MariaDB; for
  // Postgres the one found or about to be installed — Redshift's "8.0.2"
  // is not a Postgres anyone runs.
  const version =
    flavor === 'postgres'
      ? (found?.version.split('.')[0] ?? formula?.split('@')[1] ?? 'a current version')
      : (serverVersion.match(/^(\d+\.\d+)/)?.[1] ?? serverVersion);
  return { flavor, version, found: found && { path: found.path, version: found.version }, formula, brew: !!(await instances.findBrew()) };
}
