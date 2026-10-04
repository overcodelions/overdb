// What keeps ticket copies and the proxy running: the one owner of every
// copy's mysqld and of the proxy's port. See docs/design/baselines.md.
//
// Electron-free, because it runs in one of two places and never both: in
// overdb itself, or — when you ask for it to keep running while overdb is
// closed — in the background helper (src/helper/index.ts), which overdb
// then drives over a local socket (src/main/helperClient.ts). Two owners
// would mean two mysqld processes on one data directory.
//
// Records are read from disk for every change and written back whole, so
// overdb and the helper never write over each other with a stale copy.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROXY,
  baseOf,
  type BaselineRecord,
  type ProxyClient,
  type ProxyConfig,
  type ProxyState,
  type ProxyTarget,
  type TicketRecord,
  type TicketState,
} from '../shared/instances';
import * as instances from './instances';
import * as proxy from './proxy';
import { portOwner } from './portOwner';

export type ProxyEntry = ProxyConfig & { enabled: boolean; configured?: boolean };

export interface Records {
  baselines: BaselineRecord[];
  tickets: TicketRecord[];
  /// One proxy per base, by the base's source connection.
  proxies: Record<string, ProxyEntry>;
}

export function recordsFile(root: string): string {
  return path.join(root, 'records.json');
}

export async function readRecords(root: string): Promise<Records> {
  const raw = await fs.readFile(recordsFile(root), 'utf-8').catch(() => null);
  let parsed: Partial<Records> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Partial<Records>) : {};
  } catch {
    parsed = {};
  }
  const baselines = parsed.baselines ?? [];
  let proxies = parsed.proxies ?? {};
  // Records from before there could be more than one proxy kept a single
  // `proxy`: it belonged to the base it was set up for, the first one.
  const legacy = (parsed as { proxy?: Partial<ProxyEntry> }).proxy;
  if (!parsed.proxies && legacy && baselines[0]) proxies = { [baselines[0].sourceConnectionId]: { ...DEFAULT_PROXY, enabled: false, ...legacy } };
  return { baselines, tickets: parsed.tickets ?? [], proxies };
}

/// A proxy's entry, or the defaults for one never set up.
export function proxyEntry(r: Records, source: string): ProxyEntry {
  return r.proxies[source] ?? { ...DEFAULT_PROXY, enabled: false };
}

/// Read, change, write — whole and atomically.
export async function updateRecords<T>(root: string, fn: (r: Records) => T): Promise<T> {
  const r = await readRecords(root);
  const out = fn(r);
  await fs.mkdir(root, { recursive: true });
  const tmp = `${recordsFile(root)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(r, null, 2));
  await fs.rename(tmp, recordsFile(root));
  return out;
}

/// What a runtime does, wherever it runs.
export interface Runtime {
  tickets(): Promise<TicketState[]>;
  startTicket(id: string): Promise<TicketState>;
  stopTicket(id: string): Promise<void>;
  /// Stop it, delete its data and its record.
  deleteTicket(id: string): Promise<TicketRecord | null>;
  /// The branch made again from its base as the base is now: its changes
  /// gone, its name, port and connection kept.
  resetTicket(id: string): Promise<TicketState>;
  /// One per base, configured or not.
  proxyStates(): Promise<ProxyState[]>;
  configureProxy(source: string, next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState>;
  /// Point one base's proxy at its own server or at one of its branches.
  routeProxy(source: string, target: ProxyTarget): Promise<ProxyState & { dropped: number }>;
  proxyClients(source: string): Promise<ProxyClient[]>;
  /// What stopping would take away from something using it.
  inUse(): Promise<{ proxy: boolean; connections: number; running: string[] }>;
  /// Bring the proxy back if it was on.
  resume(): Promise<void>;
  /// Stop the proxy and every copy.
  shutdown(): Promise<void>;
}

function binFor(r: Records, t: TicketRecord): instances.Mysqld | null {
  const base = r.baselines.find((b) => b.id === t.baselineId);
  return base ? { path: base.mysqld, version: base.version, ...(base.flavor ? { flavor: base.flavor } : {}) } : null;
}

/// What a proxy may be set to, whoever asks — the window or the helper's
/// socket: a real port, a server named plainly, and a socket only in the
/// temporary directory, where a database's own socket lives.
export function checkProxyConfig(next: Partial<ProxyConfig>): void {
  const port = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536;
  if (next.port !== undefined && !port(next.port)) throw new Error('The proxy needs a port from 1 to 65535.');
  if (next.server !== undefined && (!/^[\w.:-]+$/.test(next.server.host) || !port(next.server.port))) throw new Error('That server address is not one the proxy can use.');
  if (next.socket) {
    const at = path.resolve(next.socket);
    const dirs = ['/tmp/', '/private/tmp/', `${path.resolve(os.tmpdir())}/`];
    if (!dirs.some((d) => at.startsWith(d)) || !at.endsWith('.sock')) throw new Error('The proxy’s socket must be a .sock file in the temporary directory, like /tmp/mysql.sock.');
  }
}

export class LocalRuntime implements Runtime {
  private readonly proxies = new Map<string, proxy.ByteProxy>();
  private readonly problems = new Map<string, { error: string; conflict: ProxyState['conflict'] }>();
  /// Branches being reset or deleted: the proxy starts none of them.
  private readonly changing = new Set<string>();

  constructor(private readonly root: string) {}

  private proxyOf(source: string): proxy.ByteProxy {
    let p = this.proxies.get(source);
    if (!p) this.proxies.set(source, (p = new proxy.ByteProxy()));
    return p;
  }

  /// The proxy whose current target is this branch, if any.
  private routedTo(r: Records, ticketId: string): string | null {
    for (const [source, e] of Object.entries(r.proxies)) if (e.target.kind === 'ticket' && e.target.id === ticketId) return source;
    return null;
  }

  async tickets(): Promise<TicketState[]> {
    const r = await readRecords(this.root);
    return r.tickets.map((t) => ({ ...t, running: !!instances.runningInstance(t.id) }));
  }

  /// Start a stopped copy on its own port. If something took that port in
  /// the meantime it moves, and the record follows.
  async startTicket(id: string): Promise<TicketState> {
    const r = await readRecords(this.root);
    const t = r.tickets.find((x) => x.id === id);
    if (!t) throw new Error('That branch no longer exists.');
    const bin = binFor(r, t) ?? (await instances.findMysqld(''));
    if (!bin) throw new Error('No mysqld found to run this branch with.');
    // The source server's settings, kept with its base, every start.
    const settings = r.baselines.find((b) => b.id === t.baselineId)?.report?.settings;
    let port = t.port;
    try {
      if (!port) throw new Error('no port yet');
      await instances.start(t.id, bin, t.datadir, port, settings);
    } catch {
      port = (await instances.start(t.id, bin, t.datadir, undefined, settings)).port;
      await updateRecords(this.root, (rr) => {
        const x = rr.tickets.find((y) => y.id === id);
        if (x) x.port = port;
      });
    }
    return { ...t, port, running: true };
  }

  async stopTicket(id: string): Promise<void> {
    await instances.stop(id);
    const source = this.routedTo(await readRecords(this.root), id);
    if (source) this.proxies.get(source)?.drop();
  }

  async deleteTicket(id: string): Promise<TicketRecord | null> {
    const r = await readRecords(this.root);
    const t = r.tickets.find((x) => x.id === id);
    if (!t) return null;
    this.changing.add(id);
    try {
      // Services go back to the server first, so none restarts it mid-delete.
      const was = await updateRecords(this.root, (rr) => {
        const source = this.routedTo(rr, id);
        if (source) rr.proxies[source].target = { kind: 'server' };
        return source;
      });
      if (was) this.proxies.get(was)?.drop();
      await instances.stop(id);
      await instances.stopStray(t.datadir);
      await fs.rm(path.dirname(t.datadir), { recursive: true, force: true });
      await updateRecords(this.root, (rr) => {
        rr.tickets = rr.tickets.filter((x) => x.id !== id);
      });
    } finally {
      this.changing.delete(id);
    }
    return t;
  }

  async resetTicket(id: string): Promise<TicketState> {
    const r = await readRecords(this.root);
    const t = r.tickets.find((x) => x.id === id);
    if (!t) throw new Error('That branch no longer exists.');
    const base = baseOf(t, r.baselines);
    if (!base) throw new Error('Its base is gone, so there is nothing to reset it to. Make a new branch from another base.');
    // While its files are replaced, the proxy does not start it for a
    // service that happens to connect.
    this.changing.add(id);
    try {
      const source = this.routedTo(r, id);
      if (source) this.proxies.get(source)?.drop();
      await instances.stop(id);
      await instances.stopStray(t.datadir);
      await fs.rm(t.datadir, { recursive: true, force: true });
      await instances.cloneDir(base.datadir, t.datadir);
      await instances.makeDistinct(t.datadir);
      await updateRecords(this.root, (rr) => {
        const x = rr.tickets.find((y) => y.id === id);
        if (x) {
          x.resetAt = new Date().toISOString();
          x.baselineId = base.id;
        }
      });
    } finally {
      this.changing.delete(id);
    }
    return this.startTicket(id);
  }

  private async upstream(source: string): Promise<proxy.Upstream> {
    const r = await readRecords(this.root);
    const e = proxyEntry(r, source);
    const target = e.target;
    if (target.kind === 'ticket' && r.tickets.some((x) => x.id === target.id && x.sourceConnectionId === source)) {
      if (this.changing.has(target.id)) throw new Error('That branch is being reset or deleted; connect again in a moment.');
      const running = instances.runningInstance(target.id);
      const port = running?.port ?? (await this.startTicket(target.id)).port;
      return { host: '127.0.0.1', port };
    }
    return e.server;
  }

  private stateOf(r: Records, source: string): ProxyState {
    const { enabled: _enabled, configured, ...config } = proxyEntry(r, source);
    const p = this.proxies.get(source);
    const problem = this.problems.get(source);
    return {
      source,
      config,
      running: !!p?.running,
      error: problem?.error ?? null,
      conflict: problem?.conflict ?? null,
      connections: p?.connections ?? 0,
      configured: !!configured,
    };
  }

  async proxyStates(): Promise<ProxyState[]> {
    const r = await readRecords(this.root);
    const sources = [...new Set([...r.baselines.map((b) => b.sourceConnectionId), ...Object.keys(r.proxies)])];
    return sources.map((s) => this.stateOf(r, s));
  }

  async configureProxy(source: string, next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState> {
    checkProxyConfig(next);
    const all = await readRecords(this.root);
    const cfg = await updateRecords(this.root, (r) => {
      r.proxies[source] = { ...proxyEntry(r, source), ...next, configured: true };
      return r.proxies[source];
    });
    this.problems.delete(source);
    const p = this.proxyOf(source);
    if (cfg.enabled) {
      // Two proxies cannot share a port; say so before the OS does it less clearly.
      const clash = Object.entries(all.proxies).find(([s, e]) => s !== source && e.enabled && e.port === cfg.port);
      try {
        if (clash) throw new Error(`Port ${cfg.port} is already another base's proxy. Give this one its own port.`);
        await p.start({ port: cfg.port, socket: cfg.socket, upstream: () => this.upstream(source) });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        let conflict: ProxyState['conflict'] = null;
        if (/in use/i.test(error)) {
          const owner = await portOwner(cfg.port).catch(() => null);
          conflict = { port: cfg.port, process: owner?.process ?? null };
        }
        this.problems.set(source, { error, conflict });
        // Not listening is off: a conflict must not be retried at every start.
        await updateRecords(this.root, (r) => {
          r.proxies[source].enabled = false;
        });
      }
    } else {
      await p.stop();
    }
    return this.stateOf(await readRecords(this.root), source);
  }

  async routeProxy(source: string, target: ProxyTarget): Promise<ProxyState & { dropped: number }> {
    const r0 = await readRecords(this.root);
    if (target.kind === 'ticket' && !r0.tickets.some((t) => t.id === target.id && t.sourceConnectionId === source)) {
      throw new Error('That branch belongs to another base.');
    }
    await updateRecords(this.root, (r) => {
      r.proxies[source] = { ...proxyEntry(r, source), target };
    });
    if (target.kind === 'ticket' && !instances.runningInstance(target.id)) await this.startTicket(target.id);
    const dropped = this.proxies.get(source)?.drop() ?? 0;
    return { ...this.stateOf(await readRecords(this.root), source), dropped };
  }

  async proxyClients(source: string): Promise<ProxyClient[]> {
    return proxy.proxyClients(this.proxies.get(source)?.port ?? null);
  }

  async inUse(): Promise<{ proxy: boolean; connections: number; running: string[] }> {
    const r = await readRecords(this.root);
    const live = [...this.proxies.values()].filter((p) => p.running);
    return {
      proxy: live.length > 0,
      connections: live.reduce((n, p) => n + p.connections, 0),
      running: r.tickets.filter((t) => instances.runningInstance(t.id)).map((t) => t.name),
    };
  }

  /// Bring back every proxy that was on.
  async resume(): Promise<void> {
    const r = await readRecords(this.root);
    for (const [source, e] of Object.entries(r.proxies)) if (e.enabled) await this.configureProxy(source, {});
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.proxies.values()].map((p) => p.stop()));
    await instances.stopAll();
  }
}
