// Owns one connection-host child process per open connection, and is the
// ONLY file that bridges Electron and the engine layer. Everything in
// src/db stays electron-free so the same code can run under the CLI.

import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectSpec } from '../db/adapter';
import type { HostRequest, HostRequestBody, HostResponse } from '../dbhost/protocol';

type Emit = (event: HostResponse) => void;

interface Host {
  proc: UtilityProcess;
  pending: Map<string, { resolve(v: unknown): void; reject(e: Error): void }>;
  spec: ConnectSpec;
}

const hosts = new Map<string, Host>();
/// In-flight opens, keyed by connection. Several places legitimately want a
/// connection at once — the schema load and the schema list both do, on
/// mount — and because openConnection starts by closing any existing host,
/// two concurrent calls had the second one killing the first's process
/// mid-introspect. The failure was invisible: completion simply never
/// arrived. Sharing one promise makes concurrent opens idempotent.
const opening = new Map<string, Promise<unknown>>();
let emit: Emit = () => undefined;

/// Main installs the renderer forwarder once at startup.
export function onHostEvent(fn: Emit): void {
  emit = fn;
}

function hostEntry(): string {
  // dist/main/dbSupervisor.js -> dist/dbhost/index.js
  return path.join(__dirname, '..', 'dbhost', 'index.js');
}

export function openConnection(connectionId: string, spec: ConnectSpec): Promise<unknown> {
  const inFlight = opening.get(connectionId);
  if (inFlight) return inFlight;
  const task = doOpen(connectionId, spec).finally(() => opening.delete(connectionId));
  opening.set(connectionId, task);
  return task;
}

async function doOpen(connectionId: string, spec: ConnectSpec): Promise<unknown> {
  await closeConnection(connectionId);

  const proc = utilityProcess.fork(hostEntry(), [], { serviceName: `overdb-${connectionId}` });
  const host: Host = { proc, pending: new Map(), spec };
  hosts.set(connectionId, host);

  proc.on('message', (msg: HostResponse) => {
    if (msg.kind === 'reply') {
      const waiter = host.pending.get(msg.id);
      host.pending.delete(msg.id);
      if (!waiter) return;
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error));
      return;
    }
    // Streaming events are not replies — forward them to the renderer.
    emit(msg);
  });

  proc.on('exit', () => {
    for (const waiter of host.pending.values()) {
      waiter.reject(new Error('connection host exited'));
    }
    host.pending.clear();
    hosts.delete(connectionId);
  });

  return request(connectionId, { op: 'connect', spec });
}

export function request(
  connectionId: string,
  req: HostRequestBody,
): Promise<unknown> {
  const host = hosts.get(connectionId);
  if (!host) return Promise.reject(new Error('connection is not open'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    host.pending.set(id, { resolve, reject });
    host.proc.postMessage({ ...req, id } as HostRequest);
  });
}

/// Fire-and-forget: acks must not allocate a pending-reply slot, or the
/// map grows by one entry per chunk for the life of a large query.
export function notify(connectionId: string, req: HostRequestBody): void {
  const host = hosts.get(connectionId);
  if (!host) return;
  host.proc.postMessage({ ...req, id: 'notify' } as HostRequest);
}

/// Cancel, with the universal backstop: if the engine has no interrupt
/// (SQLite) or doesn't land the cancel in time, kill the host. Reopening a
/// connection is cheap; a wedged query the user can't stop is not.
export async function cancelRun(connectionId: string, runId: string): Promise<void> {
  const host = hosts.get(connectionId);
  if (!host) return;

  // The backstop: if the engine's own cancel does not land within three
  // seconds, the host process is killed. Cancel has to be believable — a
  // Cancel button that leaves the query running is worse than none, because
  // the user stops watching.
  let settled = false;
  const killTimer = setTimeout(() => {
    if (settled) return;
    host.proc.kill();
    hosts.delete(connectionId);
    void openConnection(connectionId, host.spec);
  }, 3000);

  try {
    const res = (await request(connectionId, { op: 'cancel', runId })) as { interrupted: boolean };
    if (res.interrupted) {
      // KILL QUERY / pg_cancel_backend accepted; the statement dies server
      // side and the stream ends on its own.
      settled = true;
      clearTimeout(killTimer);
      return;
    }
    // No out-of-band interrupt (SQLite): kill and reconnect immediately
    // rather than waiting out the timer.
    settled = true;
    clearTimeout(killTimer);
    host.proc.kill();
    hosts.delete(connectionId);
    await openConnection(connectionId, host.spec);
  } catch {
    // Deliberately NOT clearing the timer here. The previous version did,
    // which meant a cancel that errored left the query running with no
    // backstop at all — the one case where the backstop matters most.
  }
}

export function isOpen(connectionId: string): boolean {
  return hosts.has(connectionId);
}

export async function closeConnection(connectionId: string): Promise<void> {
  const host = hosts.get(connectionId);
  if (!host) return;
  try {
    await request(connectionId, { op: 'close' });
  } catch {
    /* the host may already be gone */
  }
  host.proc.kill();
  hosts.delete(connectionId);
}

export async function closeAll(): Promise<void> {
  await Promise.all([...hosts.keys()].map((id) => closeConnection(id)));
}
