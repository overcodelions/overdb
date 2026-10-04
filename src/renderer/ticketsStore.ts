import { useEffect } from 'react';
import { create } from 'zustand';
import type { Connection } from '@shared/types';
import type { BaselineRecord, HelperStatus, ProxyClient, ProxyConfig, ProxyState, ProxyTarget, TicketState } from '@shared/instances';
import { isProxyConnectionId, proxyConnectionId } from '@shared/instances';
import { useStore } from './store';

// Ticket databases: the baselines built so far, the copies made from them,
// and the proxy your services connect through. See docs/design/baselines.md.
//
// A ticket copy comes with an overdb connection. Main makes it — it copies
// the stored credential, which never crosses to this side — and this store
// adds it to the connection list, the way every other connection is added.

interface TicketsState {
  loaded: boolean;
  baselines: BaselineRecord[];
  tickets: TicketState[];
  /// One per base, by the base's source connection.
  proxies: ProxyState[];
  helper: HelperStatus | null;
  /// Who is connected through each proxy, by source.
  clients: Record<string, ProxyClient[]>;
  busy: Record<string, string>;
  error: string | null;

  refresh(): Promise<void>;
  create(baselineId: string, name: string, note: string): Promise<TicketState | null>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  renameBaseline(id: string, label: string): Promise<void>;
  configure(source: string, next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<void>;
  route(source: string, target: ProxyTarget): Promise<number | null>;
  loadClients(source: string): Promise<void>;
  /// Hand the proxy and the copies to the background helper, or take them back.
  setBackground(on: boolean): Promise<void>;
}

async function addConnection(conn: Connection): Promise<void> {
  const { connections } = useStore.getState();
  const next = [...connections.filter((c) => c.id !== conn.id), conn];
  useStore.setState({ connections: next });
  await window.overdb.invoke('store:saveConnections', next);
}

async function patchConnection(id: string, patch: Partial<Connection>): Promise<void> {
  const { connections } = useStore.getState();
  if (!connections.some((c) => c.id === id)) return;
  const next = connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
  useStore.setState({ connections: next });
  await window.overdb.invoke('store:saveConnections', next);
}

async function dropConnection(id: string): Promise<void> {
  const { connections, selection } = useStore.getState();
  const next = connections.filter((c) => c.id !== id);
  useStore.setState({
    connections: next,
    selection: selection?.kind === 'connection' && selection.id === id ? null : selection,
  });
  await window.overdb.invoke('store:saveConnections', next);
}

/// Keep each proxy's "Services see" connection in step with it: there
/// while it runs, gone when it stops, renamed and reconnected when it points
/// somewhere else so the schema tree is never the last database's. The one
/// shared id from before there was a proxy per base is retired here.
async function syncProxyConnections(proxies: ProxyState[], retarget: boolean): Promise<void> {
  for (const c of useStore.getState().connections.filter((x) => isProxyConnectionId(x.id))) {
    if (proxies.some((p) => proxyConnectionId(p.source) === c.id)) continue;
    await window.overdb.invoke('conn:close', c.id).catch(() => undefined);
    await dropConnection(c.id);
  }
  for (const p of proxies) {
    const id = proxyConnectionId(p.source);
    const conn = await window.overdb.invoke('proxy:connection', p.source);
    const had = useStore.getState().connections.some((c) => c.id === id);
    if (!conn) {
      if (had) {
        await window.overdb.invoke('conn:close', id).catch(() => undefined);
        await dropConnection(id);
      }
      continue;
    }
    await addConnection(conn);
    if (had && retarget) {
      await window.overdb.invoke('conn:close', id).catch(() => undefined);
      const st = useStore.getState();
      if (st.schemas[id] || (st.selection?.kind === 'connection' && st.selection.id === id)) {
        await st.loadSchema(id, { force: true }).catch(() => undefined);
      }
    }
  }
}

export const useTickets = create<TicketsState>((set, get) => {
  const working = async (id: string, label: string, fn: () => Promise<void>) => {
    set({ busy: { ...get().busy, [id]: label }, error: null });
    try {
      await fn();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      const { [id]: _done, ...rest } = get().busy;
      set({ busy: rest });
    }
  };

  return {
    loaded: false,
    baselines: [],
    tickets: [],
    proxies: [],
    helper: null,
    clients: {},
    busy: {},
    error: null,

    async refresh() {
      const [r, helper] = await Promise.all([window.overdb.invoke('baseline:instances'), window.overdb.invoke('helper:status')]);
      set({ loaded: true, baselines: r.baselines, tickets: r.tickets, proxies: r.proxies, helper });
      void syncProxyConnections(r.proxies, false);
      // Branches were "ticket copies" once; their connections say so in
      // their names until renamed here.
      for (const t of r.tickets) {
        // A branch whose connection went missing from the list gets it back:
        // without it the branch can't be opened, seeded, or routed to.
        if (useStore.getState().ready && !useStore.getState().connections.some((x) => x.id === t.connectionId)) {
          const made = await window.overdb.invoke('ticket:connection', t.id);
          if (made) await addConnection(made);
        }
        const c = useStore.getState().connections.find((x) => x.id === t.connectionId);
        if (c?.name.endsWith(' · ticket copy')) await patchConnection(c.id, { name: c.name.replace(/ · ticket copy$/, ' · branch') });
        // A branch started by something other than its Start button — the
        // proxy, on a service's first connection — may have moved to a free
        // port; its connection follows, whatever started it.
        if (c && t.port && c.port !== t.port) {
          await window.overdb.invoke('conn:close', c.id).catch(() => undefined);
          await patchConnection(c.id, { port: t.port });
        }
        // Made before branches followed their source's repos.
        if (c && !c.branchOf) await patchConnection(c.id, { branchOf: t.sourceConnectionId, repoPaths: undefined });
      }
    },

    async create(baselineId, name, note) {
      let made: TicketState | null = null;
      await working('new', 'Cloning the base and starting it', async () => {
        const res = await window.overdb.invoke('ticket:create', { baselineId, name, note });
        if (!res.ok) throw new Error(res.error);
        await addConnection(res.connection);
        made = res.ticket;
        await get().refresh();
      });
      return made;
    },

    async start(id) {
      await working(id, 'Starting', async () => {
        const res = await window.overdb.invoke('ticket:start', id);
        if (!res.ok) throw new Error(res.error);
        // Its old port was taken, so it moved; the connection follows.
        await patchConnection(res.ticket.connectionId, { port: res.ticket.port });
        await get().refresh();
      });
    },

    async stop(id) {
      await working(id, 'Stopping', async () => {
        const t = get().tickets.find((x) => x.id === id);
        if (t) await window.overdb.invoke('conn:close', t.connectionId).catch(() => undefined);
        await window.overdb.invoke('ticket:stop', id);
        await get().refresh();
      });
    },

    async reset(id) {
      await working(id, 'Resetting', async () => {
        const conn = await window.overdb.invoke('ticket:reset', id);
        // Who it logs in as, and with what — the rest of it is yours.
        if (conn) await patchConnection(conn.id, { user: conn.user, secretSource: conn.secretSource, secretRef: conn.secretRef });
        await get().refresh();
        // Its tables are the base's again: what the window held is stale.
        const t = get().tickets.find((x) => x.id === id);
        const st = useStore.getState();
        if (t && st.schemas[t.connectionId]) await st.loadSchema(t.connectionId, { force: true }).catch(() => undefined);
      });
    },

    async remove(id) {
      await working(id, 'Deleting', async () => {
        const res = await window.overdb.invoke('ticket:delete', id);
        if (res.connectionId) await dropConnection(res.connectionId);
        await get().refresh();
      });
    },

    async renameBaseline(id, label) {
      await working(id, 'Renaming', async () => {
        await window.overdb.invoke('baseline:rename', { id, label });
        await get().refresh();
      });
    },

    async configure(source, next) {
      await working(`proxy:${source}`, 'Applying', async () => {
        const state = await window.overdb.invoke('proxy:configure', { source, next });
        const proxies = [...get().proxies.filter((p) => p.source !== source), state];
        set({ proxies });
        await syncProxyConnections(proxies, false);
      });
    },

    async route(source, target) {
      let dropped: number | null = null;
      await working(`proxy:${source}`, 'Switching', async () => {
        const res = await window.overdb.invoke('proxy:route', { source, target });
        if (!res.ok) throw new Error(res.error);
        dropped = res.state.dropped;
        await get().refresh();
        await syncProxyConnections(get().proxies, true);
      });
      return dropped;
    },

    async setBackground(on) {
      await working('helper', on ? 'Starting the background helper' : 'Removing the background helper', async () => {
        const res = await window.overdb.invoke(on ? 'helper:enable' : 'helper:disable');
        if (!res.ok) throw new Error(res.error);
        set({ helper: res.status });
        if (on && !res.status.running) throw new Error(res.status.error ?? 'The background helper did not start.');
        await get().refresh();
      });
    },

    async loadClients(source) {
      set({ clients: { ...get().clients, [source]: await window.overdb.invoke('proxy:clients', source) } });
    },
  };
});

/// Where one base's services can be sent, in menu order: its own server,
/// then each of its branches. Digits are shared across every base — ⌥⌘1 is
/// the oldest branch anywhere — so a shortcut keeps meaning the same branch
/// as more are made, whichever base it belongs to.
export interface TargetItem {
  source: string;
  target: ProxyTarget;
  label: string;
  detail: string;
  running: boolean;
  /// ⌥⌘ and this digit picks it.
  digit: number | null;
}

type Slice = Pick<TicketsState, 'tickets' | 'proxies'>;

export function proxyFor(s: Pick<TicketsState, 'proxies'>, source: string | undefined): ProxyState | null {
  return (source && s.proxies.find((p) => p.source === source)) || null;
}

/// Branches in the order their digits run: oldest first, across bases.
function digitOrder(s: Slice): TicketState[] {
  return [...s.tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function digitOf(s: Slice, ticketId: string): number | null {
  const i = digitOrder(s).findIndex((t) => t.id === ticketId);
  return i >= 0 && i < 9 ? i + 1 : null;
}

export function targetItems(s: Slice, source: string): TargetItem[] {
  const server = proxyFor(s, source)?.config.server;
  return [
    { source, target: { kind: 'server' }, label: 'Its own server', detail: server ? `${server.host}:${server.port} · all its data` : 'all its data', running: true, digit: null },
    ...digitOrder(s)
      .filter((t) => t.sourceConnectionId === source)
      .map((t) => ({
        source,
        target: { kind: 'ticket', id: t.id } as ProxyTarget,
        label: t.name,
        detail: t.running ? `branch · running · :${t.port}` : 'stopped · starts when chosen',
        running: t.running,
        digit: digitOf(s, t.id),
      })),
  ];
}

/// The branch a digit picks, wherever it lives.
export function itemForDigit(s: Slice, digit: number): TargetItem | null {
  const t = digitOrder(s)[digit - 1];
  return t ? targetItems(s, t.sourceConnectionId).find((i) => i.target.kind === 'ticket' && i.target.id === t.id) ?? null : null;
}

export function isTarget(s: Pick<TicketsState, 'proxies'>, source: string, target: ProxyTarget): boolean {
  const cur = proxyFor(s, source)?.config.target;
  if (!cur || cur.kind !== target.kind) return false;
  return target.kind === 'server' || (cur.kind === 'ticket' && cur.id === target.id);
}

/// Keep ticket state fresh while the window is open: the background helper
/// can start and stop copies on its own, and a copy's status is shown in
/// two places at once.
export function useTicketsLive(): void {
  useEffect(() => {
    const tick = () => void useTickets.getState().refresh().catch(() => undefined);
    tick();
    const timer = setInterval(tick, 10_000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
}

/// Send one base's services somewhere, saying what happened.
export async function routeTo(item: TargetItem): Promise<void> {
  const n = await useTickets.getState().route(item.source, item.target);
  if (n === null) return;
  useStore.getState().toast(
    n > 0 ? `Closed ${n} open connection${n === 1 ? '' : 's'}; they reconnect to ${item.label}.` : `Services now reach ${item.label}.`,
  );
}

/// Every running proxy back to its own server: ⌥⌘0.
export async function routeAllToServers(): Promise<void> {
  const st = useTickets.getState();
  let n = 0;
  for (const p of st.proxies.filter((x) => x.running && x.config.target.kind === 'ticket')) {
    n += (await st.route(p.source, { kind: 'server' })) ?? 0;
  }
  useStore.getState().toast(n > 0 ? `Closed ${n} open connection${n === 1 ? '' : 's'}; they reconnect to their own servers.` : 'Services now reach their own servers.');
}
