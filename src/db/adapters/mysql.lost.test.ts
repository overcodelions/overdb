import { describe, expect, it } from 'vitest';
import { MysqlAdapter } from './mysql';
import { isLostSession } from '../lostSession';

/// mysql2 only bubbles a dead socket to the connection's 'error' event when
/// no command was in flight to receive it, so the adapter cannot rely on
/// that event alone to know the session is gone. These hold it to reading
/// the driver's own state instead — the difference between a sentence the
/// user can act on and "Can't add new command when connection is in closed
/// state" once per background poll.
function withConn(conn: unknown): MysqlAdapter {
  const adapter = new MysqlAdapter();
  (adapter as unknown as { conn: unknown }).conn = conn;
  return adapter;
}

describe('MysqlAdapter lost-session detection', () => {
  it('reports a connection the driver has closed, with no error event', async () => {
    const adapter = withConn({ _closing: true });
    await expect(adapter.currentSchema()).rejects.toThrow(/connection was lost/);
  });

  it('reports a destroyed socket', async () => {
    const adapter = withConn({ stream: { destroyed: true } });
    await expect(adapter.currentSchema()).rejects.toThrow(/connection was lost/);
  });

  it('carries the driver own reason when it has one', async () => {
    const adapter = withConn({ _protocolError: new Error('Connection lost: The server closed the connection.') });
    await expect(adapter.currentSchema()).rejects.toThrow(/server closed the connection/);
  });

  // The supervisor heals on this message, so the two have to agree.
  it('produces a message the supervisor recognises as healable', async () => {
    const adapter = withConn({ _closing: true });
    const err = await adapter.currentSchema().catch((e: Error) => e);
    expect(isLostSession((err as Error).message)).toBe(true);
  });

  it('leaves a live connection alone', () => {
    const adapter = withConn({ stream: { destroyed: false } });
    expect(() => (adapter as unknown as { require(): unknown }).require()).not.toThrow();
  });
});
