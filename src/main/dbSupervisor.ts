// Owns one connection-host child process per open connection, and is the
// ONLY file that bridges Electron and the engine layer. Everything in
// src/db stays electron-free so the same code can run under the CLI.

import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectSpec } from '../db/adapter';
import type { HostRequest, HostRequestBody, HostResponse } from '../dbhost/protocol';
import { isLostSession } from '../db/lostSession';

type Emit = (event: HostResponse) => void;

interface Host {
  proc: UtilityProcess;
  pending: Map<string, { resolve(v: unknown): void; reject(e: Error): void }>;
  spec: ConnectSpec;
  /// Cancel backstop timers (see cancelRun), keyed by runId. A signal being
  /// accepted does not mean it was obeyed — the run's own terminal event
  /// (done/failed), handled in doOpen's message listener, is what disarms
  /// the timer for that run before it kills the host.
  cancelTimers: Map<string, ReturnType<typeof setTimeout>>;
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

type StateEmit = (connectionId: string, state: 'open' | 'closed' | 'error') => void;
let emitState: StateEmit = () => undefined;

/// Connection lifecycle, pushed to the renderer so the sidebar can show
/// which connections are actually alive. Separate from onHostEvent, which
/// carries a host's replies rather than its existence.
export function onConnectionState(fn: StateEmit): void {
  emitState = fn;
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
  // Reopening, not closing: the 'open' or 'error' below is the state the
  // renderer should see. Announcing 'closed' on the way through would put
  // a hollow dot on screen for the length of a connect.
  await closeConnection(connectionId, { reopening: true });
  applyChosenSchema(connectionId, spec);

  const proc = utilityProcess.fork(hostEntry(), [], { serviceName: `overdb-${connectionId}` });
  const host: Host = { proc, pending: new Map(), spec, cancelTimers: new Map() };
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
    // A run's terminal event is what proves a cancel actually landed — the
    // engine accepting the signal only means it was sent. Disarm that run's
    // backstop timer here rather than trusting the signal.
    if (msg.kind === 'done' || msg.kind === 'failed') {
      const timer = host.cancelTimers.get(msg.runId);
      if (timer) {
        clearTimeout(timer);
        host.cancelTimers.delete(msg.runId);
      }
    }
    // Streaming events are not replies — forward them to the renderer.
    emit(msg);
  });

  proc.on('exit', () => {
    for (const waiter of host.pending.values()) {
      waiter.reject(new Error('connection host exited'));
    }
    host.pending.clear();
    for (const timer of host.cancelTimers.values()) clearTimeout(timer);
    host.cancelTimers.clear();

    // Only if THIS host is still the current one. `exit` arrives well after
    // proc.kill() returns, so on a reopen the dead host's exit lands after
    // its replacement is already registered — and an unguarded delete here
    // removed the LIVE host from the map and reported the connection closed
    // while it was busy serving a query. The visible symptom was a status
    // dot that went hollow on a connection you were querying; the invisible
    // one was the next request failing with "connection is not open" and
    // reopening — killing the host mid-query.
    if (hosts.get(connectionId) !== host) return;
    hosts.delete(connectionId);
    emitState(connectionId, 'closed');
  });

  /// A host that never got a working adapter must not stay registered.
  /// It used to: `hosts` is populated before the handshake, so a failed
  /// connect left a live process behind whose adapter was null — isOpen
  /// went on saying true, nothing tried to reopen, and every later request
  /// came back "adapter is not connected" forever. Killing it here makes
  /// isOpen honest, which is what puts the Connect button back.
  const discard = () => {
    if (hosts.get(connectionId) !== host) return;
    hosts.delete(connectionId);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };

  try {
    const ping = (await request(connectionId, { op: 'connect', spec })) as { ok?: boolean };
    if (!ping?.ok) discard();
    emitState(connectionId, ping?.ok ? 'open' : 'error');
    return ping;
  } catch (err) {
    discard();
    emitState(connectionId, 'error');
    throw err;
  }
}

/// Open a throwaway host, ask it to connect, and throw it away.
///
/// Deliberately NOT a `hosts` entry: a test is run against a connection you
/// are still editing, and registering it would emit lifecycle events for a
/// connection the sidebar knows nothing about — or, worse, replace the live
/// host of the connection being edited with a half-configured one. Nothing
/// here can disturb an open session.
export function probe(
  spec: ConnectSpec,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; serverVersion?: string; variant?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(hostEntry(), [], { serviceName: 'overdb-probe' });
    const id = randomUUID();
    let settled = false;

    const finish = (value: { ok: boolean; serverVersion?: string; variant?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    // The engines have their own connect timeouts and they are not short.
    // A test the user watches needs an end, so this is the outer bound.
    const timer = setTimeout(
      () => finish({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)}s.` }),
      timeoutMs,
    );

    proc.on('message', (msg: HostResponse) => {
      if (msg.kind !== 'reply' || msg.id !== id) return;
      if (!msg.ok) return finish({ ok: false, error: msg.error });
      const ping = msg.value as { ok?: boolean; serverVersion?: string; variant?: string; error?: string };
      finish({
        ok: !!ping?.ok,
        serverVersion: ping?.serverVersion,
        variant: ping?.variant,
        error: ping?.error,
      });
    });
    // A driver that dies rather than rejecting (a segfault in a native
    // client) would otherwise hang until the timeout with nothing to say.
    proc.on('exit', () => finish({ ok: false, error: 'The connection host exited before answering.' }));

    proc.postMessage({ op: 'connect', spec, id } as HostRequest);
  });
}

/// Ops that may be re-issued verbatim against a replacement session.
///
/// Everything here is a read the app makes on its own behalf, so running
/// it twice costs nothing. `run` is deliberately absent: the statement is
/// the user's and may be a write, and a silent second attempt at one is
/// worse than any error message. `txn` is absent too — a reconnect ends
/// the transaction, and pretending otherwise would leave the user typing
/// into a session that no longer holds their work.
const HEALABLE = new Set([
  'ping',
  'introspect',
  'listSchemas',
  'listTables',
  'currentSchema',
  'useSchema',
  'slowQuerySupport',
  'slowQueries',
  'slowQueryExample',
  'health',
]);

function healable(req: HostRequestBody): boolean {
  // EXPLAIN ANALYZE runs the statement. Only the planning form is a read.
  if (req.op === 'explain') return !req.analyze;
  return HEALABLE.has(req.op);
}

export function request(
  connectionId: string,
  req: HostRequestBody,
): Promise<unknown> {
  // The host this request is about to go to, captured before it does, so
  // the catch below can tell a session that is still the current one from
  // one another request has already replaced.
  const sent = hosts.get(connectionId);
  return send(connectionId, req).catch(async (err: Error) => {
    // A session dies for reasons that have nothing to do with the request
    // — a MySQL wait_timeout, a server restart, a laptop that slept — and
    // the host process survives it, so `isOpen` goes on saying true and
    // main's ensureOpen sees nothing to fix. The result was the driver's
    // own "Can't add new command when connection is in closed state"
    // arriving in the log once per background poll, forever, for a
    // connection the user could have fixed by reconnecting if anything had
    // told them to. Replace the session and ask again, once.
    if (!healable(req) || shuttingDown) throw err;
    if (!isLostSession(err.message)) throw err;
    // A dead socket kills every request on it, not one: the schema load
    // and the schema list both run on mount, so both arrive here together.
    // Whoever gets here second must not reopen again — `opening` only
    // dedupes opens that overlap, so a second doOpen would close the
    // replacement the first heal just made and reject the request it had
    // re-issued on it, with "connection closed". Wait for an open that is
    // still running, then ask the session we ended up with.
    const inFlight = opening.get(connectionId);
    if (inFlight) await inFlight.catch(() => null);
    // Not for a connection the user closed, and not for a reopen that
    // failed: the host is gone from the map the moment either happens, and
    // reopening here would resurrect it behind their back.
    const host = hosts.get(connectionId);
    if (!host) throw err;
    if (inFlight || (sent && host !== sent)) return send(connectionId, req);
    const ping = (await openConnection(connectionId, host.spec).catch(() => null)) as {
      ok?: boolean;
    } | null;
    // The server is still down. The original error is the honest one.
    if (!ping?.ok) throw err;
    return send(connectionId, req);
  });
}

function send(connectionId: string, req: HostRequestBody): Promise<unknown> {
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
    settled = true;
    host.cancelTimers.delete(runId);
    host.proc.kill();
    hosts.delete(connectionId);
    void openConnection(connectionId, host.spec);
  }, 3000);
  host.cancelTimers.set(runId, killTimer);

  try {
    const res = (await request(connectionId, { op: 'cancel', runId })) as { interrupted: boolean };
    if (res.interrupted) {
      // KILL QUERY / pg_cancel_backend accepted; the statement dies server
      // side and the stream ends on its own.
      // Timer stays armed: the signal was sent, not necessarily obeyed. The run's terminal event is what proves it died.
      return;
    }
    // No out-of-band interrupt (SQLite): kill and reconnect immediately
    // rather than waiting out the timer.
    settled = true;
    clearTimeout(killTimer);
    host.cancelTimers.delete(runId);
    host.proc.kill();
    hosts.delete(connectionId);
    await openConnection(connectionId, host.spec);
  } catch {
    // Deliberately NOT clearing the timer here. The previous version did,
    // which meant a cancel that errored left the query running with no
    // backstop at all — the one case where the backstop matters most.
  }
}

/// The adapter updates its own spec when the schema changes, but that spec
/// lives in the child process. Main holds a separate copy and hands it to
/// `openConnection` on every restart — including the cancel backstop's kill
/// and reconnect — so without this, cancelling a query silently threw you
/// back to the connection's saved database.
/// The schema the user switched to, kept OUTSIDE the host so it survives
/// the host dying. Mutating host.spec alone was not enough: a host can be
/// reopened from anywhere — the renderer's own `conn:open` after a crash,
/// the cancel backstop — and every one of those paths resolved a fresh
/// spec from the saved connection, silently putting the session back on the
/// database the connection was created with while the picker went on
/// showing the one you chose.
const chosenSchema = new Map<string, string>();

export function rememberSchema(connectionId: string, name: string): void {
  chosenSchema.set(connectionId, name);
  const host = hosts.get(connectionId);
  if (!host) return;
  applyChosenSchema(connectionId, host.spec);
}

/// Overlay the chosen schema onto a freshly resolved spec. Called on every
/// open, so it does not matter who asked for one.
function applyChosenSchema(connectionId: string, spec: ConnectSpec): ConnectSpec {
  const chosen = chosenSchema.get(connectionId);
  if (!chosen) return spec;
  if (spec.engine === 'postgres') spec.searchPath = [chosen];
  else if (spec.engine === 'dynamodb') spec.region = chosen;
  else spec.database = chosen;
  return spec;
}

/// Editing a connection changes which database it points at, so the
/// session's override stops meaning anything.
export function forgetSchema(connectionId: string): void {
  chosenSchema.delete(connectionId);
}

/// Set once the app is on its way out. Two things change: pending replies
/// are abandoned rather than rejected — a rejection during quit surfaces as
/// "Error occurred in handler for 'conn:listTables': connection closed" in
/// a terminal nobody can act on, for a window that no longer exists — and
/// callers stop reopening connections we are in the middle of closing.
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function isOpen(connectionId: string): boolean {
  return hosts.has(connectionId);
}

/// Every connection with a live host, for a renderer that has just loaded.
///
/// Connection state reaches the window as pushes, and a reload throws away
/// everything pushed before it while the hosts here go on serving queries.
/// Without a way to ask, the sidebar drew every dot hollow for connections
/// it was actively querying.
export function openConnectionIds(): string[] {
  return [...hosts.keys()];
}

export async function closeConnection(
  connectionId: string,
  opts?: { reopening?: boolean },
): Promise<void> {
  const host = hosts.get(connectionId);
  if (!host) return;
  // Unregistered first, so nothing new can be routed to a host that is on
  // its way out — and the goodbye goes straight to the process rather than
  // through request(), which resolves through the map we just cleared.
  hosts.delete(connectionId);
  if (!shuttingDown) {
    for (const waiter of host.pending.values()) {
      waiter.reject(new Error('connection closed'));
    }
  }
  host.pending.clear();
  try {
    host.proc.postMessage({ op: 'close', id: 'closing' } as HostRequest);
  } catch {
    /* the host may already be gone */
  }
  host.proc.kill();
  // The exit handler cannot do this for us: it only reports a host that is
  // still the registered one, and we just unregistered this one. That guard
  // is what stops a dead host's late exit from reporting its live
  // replacement as closed — so an explicit close has to speak for itself,
  // or the dot stays green on a connection the user just shut.
  if (!opts?.reopening && !shuttingDown) emitState(connectionId, 'closed');
}

export async function closeAll(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...hosts.keys()].map((id) => closeConnection(id)));
}
