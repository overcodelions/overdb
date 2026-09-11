import { describe, expect, it } from 'vitest';
import { isPostgresSslReply, parseMysqlGreeting } from './discoverLocal';

/// A real MariaDB greeting: 4-byte header, protocol version 10, then the
/// NUL-terminated version string.
function greeting(version: string, protocol = 10): Buffer {
  const body = Buffer.concat([Buffer.from([protocol]), Buffer.from(version, 'latin1'), Buffer.from([0])]);
  const header = Buffer.alloc(4);
  header.writeUIntLE(body.length, 0, 3);
  return Buffer.concat([header, body]);
}

describe('parseMysqlGreeting', () => {
  it('reads the version a MySQL or MariaDB server volunteers', () => {
    expect(parseMysqlGreeting(greeting('10.6.16-MariaDB'))).toBe('10.6.16-MariaDB');
    expect(parseMysqlGreeting(greeting('8.0.32'))).toBe('8.0.32');
  });

  it('rejects anything that is not speaking the MySQL protocol', () => {
    // Something else listening on 3306 — an SSH tunnel, a proxy, a web
    // server. Offering it as a database would be worse than finding nothing.
    expect(parseMysqlGreeting(Buffer.from('SSH-2.0-OpenSSH_9.0\r\n'))).toBeNull();
    expect(parseMysqlGreeting(greeting('9.9', 9))).toBeNull();
    expect(parseMysqlGreeting(Buffer.alloc(0))).toBeNull();
    expect(parseMysqlGreeting(Buffer.from([0, 0, 0, 0, 10]))).toBeNull();
  });

  it('refuses a version string with no terminator rather than reading past it', () => {
    const runaway = Buffer.concat([Buffer.from([1, 0, 0, 0, 10]), Buffer.alloc(200, 0x41)]);
    expect(parseMysqlGreeting(runaway)).toBeNull();
  });
});

describe('isPostgresSslReply', () => {
  it('accepts both answers a Postgres server can give', () => {
    expect(isPostgresSslReply(Buffer.from('S'))).toBe(true);
    expect(isPostgresSslReply(Buffer.from('N'))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPostgresSslReply(Buffer.from('H'))).toBe(false);
    expect(isPostgresSslReply(Buffer.alloc(0))).toBe(false);
  });
});
