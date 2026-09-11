import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as gate from './writeGate';
import type { Connection } from '../shared/types';

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'c1', name: 'localhost', engine: 'mysql', env: 'local', ...over,
});

beforeEach(() => {
  gate.forget('c1');
  gate.configure({ rollback: async () => undefined, notify: () => undefined });
});

describe('shouldWrite', () => {
  it('refuses every statement while writes are off', () => {
    for (const kind of ['read', 'write', 'ddl'] as const) {
      expect(gate.shouldWrite(conn(), kind)).toBe(false);
    }
  });

  it('lets writes and DDL through once they are enabled, and no reads', () => {
    const c = conn({ writesEnabled: true });
    expect(gate.shouldWrite(c, 'write')).toBe(true);
    expect(gate.shouldWrite(c, 'ddl')).toBe(true);
    // A read has no reason to leave the read-only envelope, and leaving it
    // there costs nothing.
    expect(gate.shouldWrite(c, 'read')).toBe(false);
  });

  it('puts EVERY statement inside an open transaction, reads included', () => {
    // Otherwise a SELECT opens its own read-only transaction and cannot see
    // the uncommitted rows the user opened this one to check.
    gate.opened('c1');
    expect(gate.shouldWrite(conn({ writesEnabled: true }), 'read')).toBe(true);
  });

  it('refuses when there is no such connection', () => {
    expect(gate.shouldWrite(undefined, 'write')).toBe(false);
  });
});

describe('shouldBeginTransaction', () => {
  it('opens one only in manual mode, and only for a write', () => {
    const manual = conn({ writesEnabled: true, txnMode: 'manual' });
    expect(gate.shouldBeginTransaction(manual, 'write')).toBe(true);
    expect(gate.shouldBeginTransaction(manual, 'ddl')).toBe(true);
    // Browsing should not take locks or start the idle clock.
    expect(gate.shouldBeginTransaction(manual, 'read')).toBe(false);
  });

  it('never opens one in auto-commit mode', () => {
    expect(gate.shouldBeginTransaction(conn({ writesEnabled: true, txnMode: 'auto' }), 'write'))
      .toBe(false);
    expect(gate.shouldBeginTransaction(conn({ writesEnabled: true }), 'write')).toBe(false);
  });

  it('does not open a second one over the first', () => {
    const manual = conn({ writesEnabled: true, txnMode: 'manual' });
    gate.opened('c1');
    expect(gate.shouldBeginTransaction(manual, 'write')).toBe(false);
  });

  it('never opens one while writes are off', () => {
    expect(gate.shouldBeginTransaction(conn({ txnMode: 'manual' }), 'write')).toBe(false);
  });
});

describe('the idle rollback', () => {
  it('rolls back an untouched transaction and reports it closed', async () => {
    vi.useFakeTimers();
    const rollback = vi.fn(async () => undefined);
    const seen: boolean[] = [];
    gate.configure({ rollback, notify: (_id, s) => seen.push(s.open) });

    gate.opened('c1');
    expect(gate.isOpen('c1')).toBe(true);

    await vi.advanceTimersByTimeAsync(gate.IDLE_ROLLBACK_MS + 10);
    expect(rollback).toHaveBeenCalledWith('c1', 'idle');
    expect(gate.isOpen('c1')).toBe(false);
    expect(seen.at(-1)).toBe(false);
    vi.useRealTimers();
  });

  it('pushes the deadline out on every statement', async () => {
    vi.useFakeTimers();
    const rollback = vi.fn(async () => undefined);
    gate.configure({ rollback, notify: () => undefined });

    gate.opened('c1');
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(gate.IDLE_ROLLBACK_MS * 0.6);
      gate.touched('c1');
    }
    // Well past the raw timeout, but never idle for it.
    expect(rollback).not.toHaveBeenCalled();
    expect(gate.state('c1').statements).toBe(4);
    vi.useRealTimers();
  });

  it('stops the timer when the transaction closes, and when its host dies', async () => {
    vi.useFakeTimers();
    const rollback = vi.fn(async () => undefined);
    gate.configure({ rollback, notify: () => undefined });

    gate.opened('c1');
    gate.closed('c1');
    await vi.advanceTimersByTimeAsync(gate.IDLE_ROLLBACK_MS * 2);
    expect(rollback).not.toHaveBeenCalled();

    gate.opened('c1');
    gate.forget('c1');
    await vi.advanceTimersByTimeAsync(gate.IDLE_ROLLBACK_MS * 2);
    expect(rollback).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
