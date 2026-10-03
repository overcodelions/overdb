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
import { randomUUID } from 'node:crypto';
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
import type { BuilderMessage, BuilderRequest, Endpoint } from '../builder/index';
import * as instances from './instances';
import { copySecret, hasSecret } from './secrets';
import { LocalRuntime, readRecords, updateRecords, type Runtime } from './runtime';
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
  return (local ??= new LocalRuntime(root()));
}


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
  local = new LocalRuntime(root());
  await local.resume().catch(() => undefined);
  return helperStatus();
}

// ---- building -------------------------------------------------------------

/// The builder is its own process, like a connection host: a build streams
/// hundreds of thousands of rows, and none of that belongs on main's loop.
function runBuilder(req: BuilderRequest, onProgress: (p: BuildProgress) => void, signal: { cancelled: boolean; kill?: () => void }): Promise<BuildReport> {
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(path.join(__dirname, '..', 'builder', 'index.js'), [], { serviceName: 'overdb-baseline-builder' });
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
    proc.on('exit', () => {
      if (!settled) reject(new Error(signal.cancelled ? 'Stopped.' : 'The builder stopped before it finished.'));
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
  onProgress(p: BuildProgress): void;
  signal: { cancelled: boolean; kill?: () => void };
}

/// Build a baseline into a fresh instance and freeze it. The previous
/// baseline for the same connection is replaced only once this one has
/// finished; ticket copies made from it are independent and stay.
export async function buildBaseline(args: BuildArgs): Promise<BaselineRecord> {
  if (args.source.engine !== 'mysql') throw new Error('Building a base is MySQL-only for now.');
  const bin = await instances.findMysqld(args.serverVersion);
  if (!bin) throw new Error('No mysqld found on this machine. Install one with `brew install mysql`, then build again.');

  const id = randomUUID();
  const dir = path.join(root(), 'baselines', id);
  const datadir = path.join(dir, 'data');
  const log = await openBuildLog();
  log.write(`Base for ${args.source.name}, from ${args.serverVersion}`);
  log.write(`mysqld ${bin.path} (${instances.flavorOf(bin)} ${bin.version})`);
  const kinds = args.plan.tables.reduce<Record<string, number>>((m, t) => ({ ...m, [t.rows.kind]: (m[t.rows.kind] ?? 0) + 1 }), {});
  log.write(
    `Plan: ${args.plan.schemas.length} schemas, ${args.plan.tables.length} tables (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), ${args.plan.fills.length} keys to complete`,
  );
  const say = (p: BuildProgress) => {
    log.write(`${p.stage.padEnd(8)} ${p.text}`);
    args.onProgress(p);
  };
  try {
    say({ stage: 'start', text: `Creating an empty ${instances.flavorOf(bin) === 'mariadb' ? 'MariaDB' : 'MySQL'} ${bin.version} instance` });
    await instances.initialize(bin, datadir);
    if (args.signal.cancelled) throw new Error('Stopped.');
    const inst = await instances.start(id, bin, datadir);
    say({ stage: 'start', text: `Started it on port ${inst.port}` });

    const report = await runBuilder(
      {
        op: 'build',
        source: args.endpoint,
        target: { host: '127.0.0.1', port: inst.port, user: 'root', password: '' },
        plan: args.plan,
        login: args.endpoint.user && args.endpoint.password !== undefined
          ? { user: args.endpoint.user, password: args.endpoint.password }
          : null,
      },
      say,
      args.signal,
    );

    say({ stage: 'finish', text: 'Stopping the instance — its data directory is the base' });
    await instances.stop(id);
    const prior = (await readRecords(root())).baselines.find((b) => b.sourceConnectionId === args.source.id && b.named);
    const record: BaselineRecord = {
      id,
      sourceConnectionId: args.source.id,
      sourceName: args.source.name,
      datadir,
      mysqld: bin.path,
      version: bin.version,
      builtAt: new Date().toISOString(),
      recipeSavedAt: args.recipeSavedAt,
      label: prior?.label ?? args.label,
      ...(prior ? { named: true } : {}),
      bytes: await instances.dirBytes(datadir),
      report,
    };
    log.write(`Built: ${report.tables} tables, ${report.rows} rows, ${report.filled} parent rows filled, in ${Math.round(report.durationMs / 1000)} s`);
    for (const x of report.skipped) log.write(`skipped  ${x.what}: ${x.reason}`);
    await log.close();
    const old = await updateRecords(root(), (r) => {
      const was = r.baselines.filter((b) => b.sourceConnectionId === args.source.id);
      r.baselines = [...r.baselines.filter((b) => b.sourceConnectionId !== args.source.id), record];
      return was;
    });
    for (const b of old) await fs.rm(path.dirname(b.datadir), { recursive: true, force: true });
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
function ticketConnection(source: Connection, t: TicketRecord): Connection {
  const conn: Connection = {
    ...source,
    id: t.connectionId,
    name: `${t.name} · branch`,
    env: 'local',
    host: '127.0.0.1',
    port: t.port,
    tunnel: undefined,
    pinned: false,
    mcpExposed: false,
    lastOpenedAt: undefined,
    writesEnabled: true,
    // Its repos are its source's, followed rather than copied.
    branchOf: source.id,
    repoPaths: undefined,
    repoSchemas: undefined,
    recipeRepo: undefined,
  };
  if (source.secretRef && hasSecret(source.secretRef)) {
    conn.secretRef = `ticket-${t.id}`;
    copySecret(source.secretRef, conn.secretRef);
  }
  return conn;
}

/// A branch's connection made again from its record and its source — for
/// a branch whose connection went missing from the list.
export async function branchConnection(id: string, source: Connection): Promise<Connection | null> {
  const t = (await readRecords(root())).tickets.find((x) => x.id === id);
  return t ? ticketConnection(source, t) : null;
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
  return { ticket, connection: ticketConnection(args.source, ticket) };
}

/// The overdb connection for the proxy: what your services see, to query.
/// Read-only — its target changes under it, so writing belongs to a copy's
/// own connection. One, with a fixed id; its name says where it points.
export const PROXY_CONNECTION_ID = 'overdb-proxy';

export function proxyConnection(source: Connection, port: number, targetName: string): Connection {
  const conn: Connection = {
    ...source,
    id: PROXY_CONNECTION_ID,
    name: `Services see · ${targetName}`,
    env: 'local',
    host: '127.0.0.1',
    port,
    tunnel: undefined,
    pinned: false,
    mcpExposed: false,
    lastOpenedAt: undefined,
    writesEnabled: false,
    branchOf: source.id,
    repoPaths: undefined,
    repoSchemas: undefined,
    recipeRepo: undefined,
  };
  if (source.secretRef && hasSecret(source.secretRef)) {
    conn.secretRef = PROXY_CONNECTION_ID;
    copySecret(source.secretRef, conn.secretRef);
  }
  return conn;
}

export async function startTicket(id: string): Promise<TicketState> {
  return (await rt()).startTicket(id);
}

export async function stopTicket(id: string): Promise<void> {
  return (await rt()).stopTicket(id);
}

export async function deleteTicket(id: string): Promise<TicketRecord | null> {
  return (await rt()).deleteTicket(id);
}

// ---- the proxy -------------------------------------------------------------

export async function proxyState(): Promise<ProxyState> {
  return (await rt()).proxyState();
}

export async function configureProxy(next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState> {
  return (await rt()).configureProxy(next);
}

export async function routeProxy(target: ProxyTarget): Promise<ProxyState & { dropped: number }> {
  return (await rt()).routeProxy(target);
}

export async function proxyClients(): Promise<ProxyClient[]> {
  return (await rt()).proxyClients();
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
