// Who is allowed to write, and what happens to an open transaction.
//
// Two separate things, deliberately:
//
//   * WRITES ENABLED is per connection and persists, because "this is my
//     local scratch database" is a durable fact, not a mood. Turning it on
//     for a `prod` connection asks you to type the connection's name — not
//     as ceremony, but because the whole class of accident this prevents is
//     doing the right thing to the wrong server.
//
//   * TRANSACTION MODE is auto-commit or manual. Auto-commit wraps each
//     write in its own transaction and closes it. Manual holds one open
//     across statements so you can look before you commit — which is the
//     only way to make a DELETE reviewable, and also the only way to leave
//     locks sitting on a busy server. Hence the idle timeout below.
//
// None of this is the security boundary. The server still refuses a write
// outside an armed statement — Postgres with 25006, MySQL with
// ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION — and that refusal is what
// actually protects the database. This module decides what to ASK for.

import type { Connection } from '../shared/types';

/// An open transaction holds locks. Nobody means to leave one open, and on
/// a busy server the first sign is somebody else's query hanging — so it
/// rolls back on its own, loudly, rather than waiting to be noticed.
export const IDLE_ROLLBACK_MS = 90_000;

export interface TxnState {
  open: boolean;
  /// Statements run inside the current transaction, so the UI can say
  /// "3 statements" rather than just "open".
  statements: number;
  /// When the idle timeout will fire, so the UI can count down.
  expiresAt: number | null;
}

const CLOSED: TxnState = { open: false, statements: 0, expiresAt: null };

interface Entry {
  statements: number;
  timer: NodeJS.Timeout;
  expiresAt: number;
}

const open = new Map<string, Entry>();
type Rollback = (connectionId: string, reason: 'idle') => Promise<void>;
type Notify = (connectionId: string, state: TxnState) => void;

let doRollback: Rollback = async () => undefined;
let notify: Notify = () => undefined;

export function configure(opts: { rollback: Rollback; notify: Notify }): void {
  doRollback = opts.rollback;
  notify = opts.notify;
}

export function state(connectionId: string): TxnState {
  const entry = open.get(connectionId);
  if (!entry) return CLOSED;
  return { open: true, statements: entry.statements, expiresAt: entry.expiresAt };
}

export function isOpen(connectionId: string): boolean {
  return open.has(connectionId);
}

/// Whether this statement should run outside the read-only envelope.
///
/// `kind` comes from src/shared/sqlGuard.ts, which classifies for UX and
/// says so in its own header: a misclassified write simply meets the
/// server's refusal instead of ours.
export function shouldWrite(
  conn: Connection | undefined,
  kind: 'read' | 'write' | 'ddl' | 'txn' | 'unknown',
): boolean {
  if (!conn) return false;
  // Everything rides an open transaction, reads included — otherwise a
  // SELECT would open its own read-only transaction and fail to see the
  // uncommitted rows the user opened this one to check.
  if (isOpen(conn.id)) return true;
  if (!conn.writesEnabled) return false;
  return kind === 'write' || kind === 'ddl';
}

/// Whether a manual transaction needs opening before this statement.
export function shouldBeginTransaction(
  conn: Connection | undefined,
  kind: 'read' | 'write' | 'ddl' | 'txn' | 'unknown',
): boolean {
  if (!conn?.writesEnabled) return false;
  if (conn.txnMode !== 'manual') return false;
  if (isOpen(conn.id)) return false;
  // A read does not open a transaction. Opening one on a SELECT would take
  // locks nobody asked for and start the idle clock on a browse.
  return kind === 'write' || kind === 'ddl';
}

export function opened(connectionId: string): void {
  clear(connectionId);
  arm(connectionId, 0);
}

/// Called for every statement that runs inside the transaction, which both
/// counts it and pushes the idle deadline out.
export function touched(connectionId: string): void {
  const entry = open.get(connectionId);
  if (!entry) return;
  const count = entry.statements + 1;
  clearTimeout(entry.timer);
  arm(connectionId, count);
}

function arm(connectionId: string, statements: number): void {
  const expiresAt = Date.now() + IDLE_ROLLBACK_MS;
  const timer = setTimeout(() => {
    // Deliberately not awaited into anything: the rollback either lands or
    // the connection is already gone, and both end with the transaction
    // closed here.
    open.delete(connectionId);
    void doRollback(connectionId, 'idle').finally(() => notify(connectionId, CLOSED));
  }, IDLE_ROLLBACK_MS);
  // A timer that keeps the app alive to roll something back would stop
  // Electron quitting cleanly.
  timer.unref?.();
  open.set(connectionId, { statements, timer, expiresAt });
  notify(connectionId, state(connectionId));
}

export function closed(connectionId: string): void {
  clear(connectionId);
  notify(connectionId, CLOSED);
}

function clear(connectionId: string): void {
  const entry = open.get(connectionId);
  if (entry) clearTimeout(entry.timer);
  open.delete(connectionId);
}

/// A host that died takes its transaction with it, whatever we thought.
export function forget(connectionId: string): void {
  clear(connectionId);
}
