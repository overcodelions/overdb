import { describe, expect, it } from 'vitest';
import { isLostSession } from './lostSession';

describe('isLostSession', () => {
  it('recognises the mysql2 closed-socket message that started this', () => {
    expect(isLostSession("Can't add new command when connection is in closed state")).toBe(true);
  });

  it('recognises the other drivers', () => {
    for (const m of [
      'Connection lost: The server closed the connection.',
      'Client has encountered a connection error and is not queryable',
      'Connection terminated unexpectedly',
      'terminating connection due to administrator command',
      'read ECONNRESET',
      'the mysql connection was lost (read ECONNRESET) — reconnect to continue',
    ]) {
      expect(isLostSession(m), m).toBe(true);
    }
  });

  it('recognises a host that died under the request', () => {
    expect(isLostSession('connection host exited')).toBe(true);
    expect(isLostSession('connection is not open')).toBe(true);
  });

  // The point of the whole predicate: a statement that failed on its own
  // merits must be reported, never quietly re-run against a new session.
  it('leaves real errors alone', () => {
    for (const m of [
      "You have an error in your SQL syntax near 'slect 1'",
      'relation "users" does not exist',
      'Duplicate entry \'7\' for key \'PRIMARY\'',
      'permission denied for table orders',
      'Query execution was interrupted',
      'closed the cursor',
    ]) {
      expect(isLostSession(m), m).toBe(false);
    }
  });
});
