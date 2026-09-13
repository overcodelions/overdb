import { describe, expect, it } from 'vitest';
import { cleanError } from './cleanError';

/// The one answer this must never give is an empty string: it becomes
/// `new Error('')` in main and reaches the user as the literal word
/// "Error", which reads as a bug in overdb rather than a server that
/// would not let it in.
describe('cleanError', () => {
  it('uses the message when there is one', () => {
    expect(cleanError(new Error('Access denied for user'))).toBe('Access denied for user');
  });

  it("prefers the server's own words to a code", () => {
    const err = Object.assign(new Error(''), {
      sqlMessage: "Unknown column 'rows_read' in 'field list'",
      code: 'ER_BAD_FIELD_ERROR',
    });
    expect(cleanError(err)).toBe("Unknown column 'rows_read' in 'field list'");
  });

  it('reads a refused socket the way node describes one', () => {
    const err = Object.assign(new Error(''), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 3306,
    });
    expect(cleanError(err)).toBe('connect ECONNREFUSED 127.0.0.1:3306');
  });

  it('never hands back an empty string', () => {
    expect(cleanError(new Error(''))).not.toBe('');
    expect(cleanError('')).not.toBe('');
    expect(cleanError({})).not.toBe('');
    expect(cleanError(undefined)).not.toBe('');
  });
});
