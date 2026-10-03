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
import path from 'node:path';
import {
  DEFAULT_PROXY,
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

export interface Records {
  baselines: BaselineRecord[];
  tickets: TicketRecord[];
  proxy: ProxyConfig & { enabled: boolean; configured?: boolean };
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
  return {
    baselines: parsed.baselines ?? [],
    tickets: parsed.tickets ?? [],
    proxy: { ...DEFAULT_PROXY, enabled: false, ...(parsed.proxy ?? {}) },
  };
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
  proxyState(): Promise<ProxyState>;
  configureProxy(next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState>;
  routeProxy(target: ProxyTarget): Promise<ProxyState & { dropped: number }>;
  proxyClients(): Promise<ProxyClient[]>;
  /// What stopping would take away from something using it.
  inUse(): Promise<{ proxy: boolean; connections: number; running: string[] }>;
  /// Bring the proxy back if it was on.
  resume(): Promise<void>;
  /// Stop the proxy and every copy.
  shutdown(): Promise<void>;
}

function binFor(r: Records, t: TicketRecord): instances.Mysqld | null {
  const base = r.baselines.find((b) => b.id === t.baselineId);
  return base ? { path: base.mysqld, version: base.version } : null;
}

export class LocalRuntime implements Runtime {
  private proxyError: string | null = null;
  private proxyConflict: ProxyState['conflict'] = null;

  constructor(private readonly root: string) {}

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
    let port = t.port;
    try {
      if (!port) throw new Error('no port yet');
      await instances.start(t.id, bin, t.datadir, port);
    } catch {
      port = (await instances.start(t.id, bin, t.datadir)).port;
      await updateRecords(this.root, (rr) => {
        const x = rr.tickets.find((y) => y.id === id);
        if (x) x.port = port;
      });
    }
    return { ...t, port, running: true };
  }

  async stopTicket(id: string): Promise<void> {
    await instances.stop(id);
    const r = await readRecords(this.root);
    if (r.proxy.target.kind === 'ticket' && r.proxy.target.id === id) proxy.dropConnections();
  }

  async deleteTicket(id: string): Promise<TicketRecord | null> {
    const r = await readRecords(this.root);
    const t = r.tickets.find((x) => x.id === id);
    if (!t) return null;
    await instances.stop(id);
    await fs.rm(path.dirname(t.datadir), { recursive: true, force: true });
    const wasTarget = await updateRecords(this.root, (rr) => {
      rr.tickets = rr.tickets.filter((x) => x.id !== id);
      if (rr.proxy.target.kind === 'ticket' && rr.proxy.target.id === id) {
        rr.proxy.target = { kind: 'server' };
        return true;
      }
      return false;
    });
    if (wasTarget) proxy.dropConnections();
    return t;
  }

  private async upstream(): Promise<proxy.Upstream> {
    const r = await readRecords(this.root);
    const target = r.proxy.target;
    if (target.kind === 'ticket' && r.tickets.some((x) => x.id === target.id)) {
      const running = instances.runningInstance(target.id);
      const port = running?.port ?? (await this.startTicket(target.id)).port;
      return { host: '127.0.0.1', port };
    }
    return r.proxy.server;
  }

  async proxyState(): Promise<ProxyState> {
    const r = await readRecords(this.root);
    const { enabled: _enabled, configured, ...config } = r.proxy;
    return {
      config,
      running: proxy.proxyRunning(),
      error: this.proxyError,
      conflict: this.proxyConflict,
      connections: proxy.proxyConnections(),
      configured: !!configured,
    };
  }

  async configureProxy(next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<ProxyState> {
    const cfg = await updateRecords(this.root, (r) => {
      r.proxy = { ...r.proxy, ...next, configured: true };
      return r.proxy;
    });
    this.proxyError = null;
    this.proxyConflict = null;
    if (cfg.enabled) {
      try {
        await proxy.startProxy({ port: cfg.port, socket: cfg.socket, upstream: () => this.upstream() });
      } catch (err) {
        this.proxyError = err instanceof Error ? err.message : String(err);
        if (/in use/i.test(this.proxyError)) {
          const owner = await portOwner(cfg.port).catch(() => null);
          this.proxyConflict = { port: cfg.port, process: owner?.process ?? null };
        }
        // Not listening is off: a conflict must not be retried at every start.
        await updateRecords(this.root, (r) => {
          r.proxy.enabled = false;
        });
      }
    } else {
      await proxy.stopProxy();
    }
    return this.proxyState();
  }

  async routeProxy(target: ProxyTarget): Promise<ProxyState & { dropped: number }> {
    await updateRecords(this.root, (r) => {
      r.proxy.target = target;
    });
    if (target.kind === 'ticket' && !instances.runningInstance(target.id)) await this.startTicket(target.id);
    const dropped = proxy.dropConnections();
    return { ...(await this.proxyState()), dropped };
  }

  proxyClients(): Promise<ProxyClient[]> {
    return proxy.proxyClients();
  }

  async inUse(): Promise<{ proxy: boolean; connections: number; running: string[] }> {
    const r = await readRecords(this.root);
    return {
      proxy: proxy.proxyRunning(),
      connections: proxy.proxyConnections(),
      running: r.tickets.filter((t) => instances.runningInstance(t.id)).map((t) => t.name),
    };
  }

  async resume(): Promise<void> {
    const r = await readRecords(this.root);
    if (r.proxy.enabled) await this.configureProxy({});
  }

  async shutdown(): Promise<void> {
    await proxy.stopProxy();
    await instances.stopAll();
  }
}
