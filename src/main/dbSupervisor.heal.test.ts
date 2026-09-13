// A dead socket does not kill one request, it kills every request on that
// session — and the app always has at least two in the air, because the
// schema load and the schema list both run when a pane mounts. Healing
// them independently meant the second heal closed the host the first had
// just made and rejected the request re-issued on it, so a wake from
// sleep showed up as "Error occurred in handler for 'conn:listSchemas':
// Error: connection closed". The pair, healed together, is the point.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from './dbSupervisor';

/// Answers `connect` with a good ping always, and every other op either
/// with its own name or — once `dead` is set, the way a socket dies under
/// a host that is still running — with the bare errno macOS raises when
/// the interface the connection was bound to goes away.
class FakeProc extends EventEmitter {
  dead = false;
  killed = false;
  postMessage(msg: { op: string; id: string }): void {
    if (msg.op === 'close') return;
    queueMicrotask(() => {
      if (msg.op === 'connect') {
        this.emit('message', { kind: 'reply', id: msg.id, ok: true, value: { ok: true } });
      } else if (this.dead) {
        this.emit('message', { kind: 'reply', id: msg.id, ok: false, error: 'read EADDRNOTAVAIL' });
      } else {
        this.emit('message', { kind: 'reply', id: msg.id, ok: true, value: msg.op });
      }
    });
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
const introspect = { op: 'introspect', schemas: [] } as never;
const listSchemas = { op: 'listSchemas' } as never;

describe('healing a session two requests died on', () => {
  beforeEach(async () => {
    for (const id of db.openConnectionIds()) await db.closeConnection(id);
    forked.length = 0;
  });

  it('replaces the session once and answers both requests', async () => {
    await db.openConnection('h', SPEC);
    forked[0].dead = true;

    const answers = await Promise.all([db.request('h', introspect), db.request('h', listSchemas)]);

    expect(answers).toEqual(['introspect', 'listSchemas']);
    // Two hosts total: the original and one replacement. A third means the
    // second heal reopened on its own, which is what used to reject the
    // first heal's re-issued request.
    expect(forked).toHaveLength(2);
    expect(db.openConnectionIds()).toEqual(['h']);
  });

  it('leaves a statement error alone rather than reconnecting under it', async () => {
    await db.openConnection('r', SPEC);
    const proc = forked[0];
    proc.postMessage = (msg: { op: string; id: string }) => {
      if (msg.op === 'close') return;
      queueMicrotask(() =>
        proc.emit('message', {
          kind: 'reply',
          id: msg.id,
          ok: false,
          error: 'relation "users" does not exist',
        }),
      );
    };

    await expect(db.request('r', introspect)).rejects.toThrow(/does not exist/);
    expect(forked).toHaveLength(1);
  });
});
