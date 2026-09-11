import { describe, expect, it } from 'vitest';
import { PostgresAdapter } from './postgres';

/// A failed statement is the ordinary case on Redshift — half of Postgres'
/// syntax is missing there — so the connection has to survive one. These
/// tests drive the real pg-cursor object through a fake client, because the
/// bug being guarded against lives in pg-cursor's own state machine.

interface FakeCursor {
  state: string;
  _error?: Error;
  close(cb: () => void): void;
}

function fakeClient(onCursor: (c: FakeCursor) => void) {
  const sql: string[] = [];
  const client = {
    sql,
    query(arg: unknown) {
      if (typeof arg === 'string') {
        sql.push(arg);
        return Promise.resolve({ rows: [] });
      }
      onCursor(arg as FakeCursor);
      return arg;
    },
  };
  return client;
}

function adapterOn(client: unknown): PostgresAdapter {
  const a = new PostgresAdapter();
  (a as unknown as { client: unknown }).client = client;
  (a as unknown as { spec: unknown }).spec = { readOnly: true };
  return a;
}

describe('the transaction a statement opens for itself', () => {
  it('is rolled back when the statement fails, even though close() hangs', async () => {
    // pg-cursor in state 'error' waits on a ReadyForQuery that has already
    // been sent, so its close() callback never fires. If we awaited it, the
    // read-only transaction would stay open and aborted and every later
    // statement on the connection — currentSchema included — would fail
    // with "current transaction is aborted".
    const client = fakeClient((c) => {
      c.state = 'error';
      c._error = new Error('syntax error at or near "lateral"');
      c.close = () => undefined; // never calls back, exactly like the real one
    });
    const adapter = adapterOn(client);

    const handle = await adapter.stream('select bad');
    await expect(handle.next(100)).rejects.toThrow(/syntax error/);
    await handle.close();

    expect(client.sql).toEqual(['begin read only', 'rollback']);
  });

  it('is committed once, not once per close', async () => {
    const client = fakeClient((c) => {
      c.state = 'done';
    });
    const adapter = adapterOn(client);

    const handle = await adapter.stream('select 1');
    // The caller closes on the happy path and a finally closes again;
    // ending the transaction twice would end the next statement's one.
    await handle.close();
    await handle.close();

    expect(client.sql).toEqual(['begin read only', 'commit']);
  });

  it('is left alone when the user owns the transaction', async () => {
    const client = fakeClient((c) => {
      c.state = 'error';
      c._error = new Error('nope');
      c.close = () => undefined;
    });
    const adapter = adapterOn(client);
    await adapter.beginTransaction();

    const handle = await adapter.stream('select bad');
    await expect(handle.next(100)).rejects.toThrow(/nope/);
    await handle.close();

    // Aborted or not, it is theirs to commit or roll back.
    expect(client.sql).toEqual(['begin']);
    expect(adapter.inTransaction()).toBe(true);
  });
});

describe('a read that meets someone else\'s aborted transaction', () => {
  it('ends it and asks again', async () => {
    let attempts = 0;
    const client = {
      query(sql: string) {
        attempts += 1;
        if (sql.startsWith('select current_schema') && attempts === 1) {
          return Promise.reject(
            Object.assign(new Error('current transaction is aborted'), { code: '25P02' }),
          );
        }
        return Promise.resolve({ rows: [{ s: 'public' }] });
      },
    };
    const adapter = adapterOn(client);

    await expect(adapter.currentSchema()).resolves.toBe('public');
  });

  it('does not end a transaction the user opened', async () => {
    const client = {
      query(sql: string) {
        if (sql.startsWith('select current_schema')) {
          return Promise.reject(
            Object.assign(new Error('current transaction is aborted'), { code: '25P02' }),
          );
        }
        return Promise.resolve({ rows: [] });
      },
    };
    const adapter = adapterOn(client);
    await adapter.beginTransaction();

    await expect(adapter.currentSchema()).rejects.toThrow(/aborted/);
    expect(adapter.inTransaction()).toBe(true);
  });
});
