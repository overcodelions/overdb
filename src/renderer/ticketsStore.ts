import { useEffect } from 'react';
import { create } from 'zustand';
import type { Connection } from '@shared/types';
import type { BaselineRecord, HelperStatus, ProxyClient, ProxyConfig, ProxyState, ProxyTarget, TicketState } from '@shared/instances';
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
  proxy: ProxyState | null;
  helper: HelperStatus | null;
  clients: ProxyClient[];
  busy: Record<string, string>;
  error: string | null;

  refresh(): Promise<void>;
  create(baselineId: string, name: string, note: string): Promise<TicketState | null>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  renameBaseline(id: string, label: string): Promise<void>;
  configure(next: Partial<ProxyConfig> & { enabled?: boolean }): Promise<void>;
  route(target: ProxyTarget): Promise<number | null>;
  loadClients(): Promise<void>;
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

const PROXY_CONNECTION_ID = 'overdb-proxy';

/// Keep the sidebar's "Services see" connection in step with the proxy:
/// there while it runs, gone when it stops, renamed and reconnected when it
/// points somewhere else so the schema tree is never the last database's.
async function syncProxyConnection(retarget: boolean): Promise<void> {
  const conn = await window.overdb.invoke('proxy:connection');
  const had = useStore.getState().connections.some((c) => c.id === PROXY_CONNECTION_ID);
  if (!conn) {
    if (had) {
      await window.overdb.invoke('conn:close', PROXY_CONNECTION_ID).catch(() => undefined);
      await dropConnection(PROXY_CONNECTION_ID);
    }
    return;
  }
  await addConnection(conn);
  if (had && retarget) {
    await window.overdb.invoke('conn:close', PROXY_CONNECTION_ID).catch(() => undefined);
    const st = useStore.getState();
    if (st.schemas[PROXY_CONNECTION_ID] || (st.selection?.kind === 'connection' && st.selection.id === PROXY_CONNECTION_ID)) {
      await st.loadSchema(PROXY_CONNECTION_ID, { force: true }).catch(() => undefined);
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
    proxy: null,
    helper: null,
    clients: [],
    busy: {},
    error: null,

    async refresh() {
      const [r, helper] = await Promise.all([window.overdb.invoke('baseline:instances'), window.overdb.invoke('helper:status')]);
      set({ loaded: true, baselines: r.baselines, tickets: r.tickets, proxy: r.proxy, helper });
      void syncProxyConnection(false);
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

    async configure(next) {
      await working('proxy', 'Applying', async () => {
        const state = await window.overdb.invoke('proxy:configure', next);
        set({ proxy: state });
        await syncProxyConnection(false);
      });
    },

    async route(target) {
      let dropped: number | null = null;
      await working('proxy', 'Switching', async () => {
        const res = await window.overdb.invoke('proxy:route', target);
        if (!res.ok) throw new Error(res.error);
        dropped = res.state.dropped;
        await get().refresh();
        await syncProxyConnection(true);
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

    async loadClients() {
      set({ clients: await window.overdb.invoke('proxy:clients') });
    },
  };
});

/// Where services can be sent, in menu order: your own server, then each
/// copy, oldest first so ⌥⌘1 stays the same copy as more are made.
export interface TargetItem {
  target: ProxyTarget;
  label: string;
  detail: string;
  running: boolean;
  /// ⌥⌘ and this digit picks it.
  digit: number | null;
}

export function targetItems(s: Pick<TicketsState, 'tickets' | 'proxy'>): TargetItem[] {
  const server = s.proxy?.config.server;
  const copies = [...s.tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [
    { target: { kind: 'server' }, label: 'Your own server', detail: server ? `${server.host}:${server.port} · all your data` : 'all your data', running: true, digit: 0 },
    ...copies.map((t, i) => ({
      target: { kind: 'ticket', id: t.id } as ProxyTarget,
      label: t.name,
      detail: t.running ? `branch · running · :${t.port}` : 'stopped · starts when chosen',
      running: t.running,
      digit: i < 9 ? i + 1 : null,
    })),
  ];
}

export function isTarget(s: Pick<TicketsState, 'proxy'>, target: ProxyTarget): boolean {
  const cur = s.proxy?.config.target;
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

/// Send services somewhere, saying what happened.
export async function routeTo(item: TargetItem): Promise<void> {
  const n = await useTickets.getState().route(item.target);
  if (n === null) return;
  useStore.getState().toast(
    n > 0 ? `Closed ${n} open connection${n === 1 ? '' : 's'}; they reconnect to ${item.label}.` : `Services now reach ${item.label}.`,
  );
}
