// The status dot in the sidebar is drawn from `conn:state` pushes and
// nothing else, so a lifecycle change the supervisor keeps to itself is
// invisible to the user. Both of these were:
//
//   - closing emitted nothing at all. The only 'closed' lived in the host's
//     `exit` handler, behind a guard that ignores a host which is no longer
//     the registered one — and closeConnection unregisters before it kills,
//     so the guard always bailed. A connection you shut stayed green.
//   - reopening emitted 'closed' where it should say nothing, once that
//     first bug was fixed, because doOpen closes before it forks.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from './dbSupervisor';

/// A connection host that answers `connect` with a successful ping and
/// nothing else. `postMessage` replies on the next tick, the way the real
/// utility process does, so awaits in the supervisor behave as they do in
/// the app.
class FakeProc extends EventEmitter {
  killed = false;
  postMessage(msg: { op: string; id: string }): void {
    if (msg.op !== 'connect') return;
    queueMicrotask(() => this.emit('message', { kind: 'reply', id: msg.id, ok: true, value: { ok: true } }));
  }
  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.emit('exit'));
  }
}

const forked: FakeProc[] = [];

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const proc = new FakeProc();
      forked.push(proc);
      return proc;
    },
  },
}));

const SPEC = { engine: 'sqlite', file: ':memory:' } as never;

describe('connection state reaching the renderer', () => {
  let seen: Array<[string, string]>;

  beforeEach(async () => {
    // The supervisor's host map is module state; leaving a host open would
    // show up in the next test's `openConnectionIds`.
    for (const id of db.openConnectionIds()) await db.closeConnection(id);
    forked.length = 0;
    seen = [];
    db.onConnectionState((id, state) => seen.push([id, state]));
  });

  it('says open on a successful connect', async () => {
    await db.openConnection('a', SPEC);
    expect(seen).toEqual([['a', 'open']]);
    expect(db.openConnectionIds()).toEqual(['a']);
  });

  it('says closed when the connection is closed', async () => {
    await db.openConnection('b', SPEC);
    seen = [];
    await db.closeConnection('b');
    expect(seen).toEqual([['b', 'closed']]);
    expect(db.openConnectionIds()).toEqual([]);
  });

  it('does not flash closed while reopening', async () => {
    await db.openConnection('c', SPEC);
    seen = [];
    await db.openConnection('c', SPEC);
    // The pre-close inside the reopen is not a state the user should see —
    // a hollow dot for the length of a connect reads as a disconnection.
    expect(seen).toEqual([['c', 'open']]);
  });

  it('reports every live host to a window that just loaded', async () => {
    await db.openConnection('d', SPEC);
    await db.openConnection('e', SPEC);
    expect(db.openConnectionIds().sort()).toEqual(['d', 'e']);
    await db.closeConnection('d');
    expect(db.openConnectionIds()).toEqual(['e']);
  });
});
