// Connection hosts under plain node, for `node dist/mcp/headless.js`.
//
// The same src/dbhost/index.js the app runs as a utilityProcess, forked
// with child_process instead — the host speaks to either (see its
// `transport()`). Smaller than src/main/dbSupervisor.ts on purpose: an
// agent's statements are bounded by a server-side timeout and nobody
// cancels them, so there is no cancel backstop, and a dead session is
// reopened by the next call's ensureOpen rather than healed in place.
//
// The child's stdout is pointed at our stderr. A stdio MCP server's stdout
// is the protocol, and a driver that prints one line there would end the
// session.

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ConnectSpec } from '../db/adapter';
import type { HostRequest, HostRequestBody, HostResponse } from '../dbhost/protocol';
import type { Supervisor } from './wiring';

interface Host {
  proc: ChildProcess;
  pending: Map<string, { resolve(v: unknown): void; reject(e: Error): void }>;
}

export function createNodeSupervisor(hostEntry: string): Supervisor & { closeAll(): Promise<void> } {
  const hosts = new Map<string, Host>();
  const opening = new Map<string, Promise<unknown>>();
  let emit: (event: HostResponse) => void = () => undefined;
  let emitState: (connectionId: string, state: 'open' | 'closed' | 'error') => void = () => undefined;

  function send(connectionId: string, req: HostRequestBody): Promise<unknown> {
    const host = hosts.get(connectionId);
    if (!host) return Promise.reject(new Error('connection is not open'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      host.pending.set(id, { resolve, reject });
      host.proc.send({ ...req, id } as HostRequest);
    });
  }

  async function closeConnection(connectionId: string): Promise<void> {
    const host = hosts.get(connectionId);
    if (!host) return;
    hosts.delete(connectionId);
    for (const waiter of host.pending.values()) waiter.reject(new Error('connection closed'));
    host.pending.clear();
    try {
      host.proc.send({ op: 'close', id: 'closing' } as HostRequest);
    } catch {
      /* the host may already be gone */
    }
    host.proc.kill();
    emitState(connectionId, 'closed');
  }

  async function doOpen(connectionId: string, spec: ConnectSpec): Promise<unknown> {
    await closeConnection(connectionId);
    const proc = fork(hostEntry, [], { stdio: ['ignore', 2, 2, 'ipc'] });
    const host: Host = { proc, pending: new Map() };
    hosts.set(connectionId, host);

    proc.on('message', (msg: HostResponse) => {
      if (msg.kind !== 'reply') return emit(msg);
      const waiter = host.pending.get(msg.id);
      host.pending.delete(msg.id);
      if (!waiter) return;
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error));
    });
    proc.on('exit', () => {
      for (const waiter of host.pending.values()) waiter.reject(new Error('connection host exited'));
      host.pending.clear();
      // Only if this host is still the current one — see the same guard in
      // src/main/dbSupervisor.ts for what an unguarded delete did.
      if (hosts.get(connectionId) !== host) return;
      hosts.delete(connectionId);
      emitState(connectionId, 'closed');
    });

    const discard = () => {
      if (hosts.get(connectionId) !== host) return;
      hosts.delete(connectionId);
      proc.kill();
    };
    try {
      const ping = (await send(connectionId, { op: 'connect', spec })) as { ok?: boolean };
      if (!ping?.ok) discard();
      emitState(connectionId, ping?.ok ? 'open' : 'error');
      return ping;
    } catch (err) {
      discard();
      emitState(connectionId, 'error');
      throw err;
    }
  }

  return {
    openConnection(connectionId, spec) {
      const inFlight = opening.get(connectionId);
      if (inFlight) return inFlight;
      const task = doOpen(connectionId, spec).finally(() => opening.delete(connectionId));
      opening.set(connectionId, task);
      return task;
    },
    request: send,
    notify(connectionId, req) {
      hosts.get(connectionId)?.proc.send({ ...req, id: 'notify' } as HostRequest);
    },
    onHostEvent(fn) {
      emit = fn;
    },
    onConnectionState(fn) {
      emitState = fn;
    },
    isOpen: (connectionId) => hosts.has(connectionId),
    openConnectionIds: () => [...hosts.keys()],
    closeConnection,
    async closeAll() {
      await Promise.all([...hosts.keys()].map((id) => closeConnection(id)));
    },
  };
}
