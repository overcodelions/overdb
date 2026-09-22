import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tlsOptions } from './tls';
import type { ConnectSpec } from './adapter';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-tls-'));
const caPath = path.join(dir, 'ca.pem');
const certPath = path.join(dir, 'client.pem');
const keyPath = path.join(dir, 'client.key');
fs.writeFileSync(caPath, 'CA-PEM');
fs.writeFileSync(certPath, 'CERT-PEM');
fs.writeFileSync(keyPath, 'KEY-PEM');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const base: ConnectSpec = {
  engine: 'postgres',
  host: 'db.example.com',
  readOnly: true,
  statementTimeoutMs: null,
};

describe('tlsOptions', () => {
  it('is off when SSL is off', () => {
    expect(tlsOptions(base)).toBeUndefined();
    expect(tlsOptions({ ...base, ssl: 'disable' })).toBeUndefined();
  });

  // `require` is the mode everyone reaches for, and it verifies nothing.
  // That is a deliberate meaning, so it is asserted rather than assumed.
  it('encrypts without verifying on require', () => {
    expect(tlsOptions({ ...base, ssl: 'require' })).toMatchObject({ rejectUnauthorized: false });
  });

  it('verifies the chain and the hostname on verify-full', () => {
    const o = tlsOptions({ ...base, ssl: 'verify-full' })!;
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.servername).toBe('db.example.com');
    expect(o.checkServerIdentity).toBeUndefined();
  });

  it('verifies the chain but not the hostname on verify-ca', () => {
    const o = tlsOptions({ ...base, ssl: 'verify-ca' })!;
    expect(o.rejectUnauthorized).toBe(true);
    // Node has no flag for this; returning undefined from the identity
    // check is how you accept the name while the chain check still applies.
    expect(o.checkServerIdentity?.()).toBeUndefined();
  });

  it('reads the CA, certificate and key from disk', () => {
    const o = tlsOptions({
      ...base,
      ssl: 'verify-full',
      sslRootCert: caPath,
      sslCert: certPath,
      sslKey: keyPath,
    })!;
    expect(o).toMatchObject({ ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM' });
  });

  // The point of tlsServerName: through a tunnel the socket goes to
  // 127.0.0.1, and without this verify-full compares the certificate to
  // "127.0.0.1", fails, and pushes everyone down to `require` permanently.
  it('verifies against the real hostname when the address is a tunnel', () => {
    const o = tlsOptions({
      ...base,
      host: '127.0.0.1',
      tlsServerName: 'orders.prod.internal',
      ssl: 'verify-full',
    })!;
    expect(o.servername).toBe('orders.prod.internal');
  });

  it('refuses a half-configured client identity', () => {
    expect(() => tlsOptions({ ...base, ssl: 'require', sslCert: certPath })).toThrow(/private key/i);
    expect(() => tlsOptions({ ...base, ssl: 'require', sslKey: keyPath })).toThrow(/certificate/i);
  });

  // Silently ignoring it would leave someone believing they were
  // authenticating with a certificate that was never presented.
  it('refuses a client certificate with TLS switched off', () => {
    expect(() =>
      tlsOptions({ ...base, ssl: 'disable', sslCert: certPath, sslKey: keyPath }),
    ).toThrow(/only be presented over TLS/i);
  });

  it('names the file it could not read, and nothing else', () => {
    const missing = path.join(dir, 'nope.pem');
    expect(() => tlsOptions({ ...base, ssl: 'verify-full', sslRootCert: missing })).toThrow(
      // Not a RegExp: a Windows path is all backslashes, which a pattern reads
      // as escapes. toThrow(string) is a substring match, which is the intent.
      `CA certificate file was not found at ${missing}`,
    );
  });
});

// mysql2 ignores `checkServerIdentity` and uses a flag of its own, so the
// same four modes have to be built differently for it. Getting this wrong
// is invisible: the connection succeeds either way.
describe('tlsOptions for MySQL', () => {
  const my: ConnectSpec = { ...base, engine: 'mysql' };

  it('checks the hostname only on verify-full', () => {
    expect(tlsOptions({ ...my, ssl: 'verify-full' })).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
    expect(tlsOptions({ ...my, ssl: 'verify-ca' })).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: false,
    });
    expect(tlsOptions({ ...my, ssl: 'require' })).toMatchObject({
      rejectUnauthorized: false,
      verifyIdentity: false,
    });
  });

  it('refuses verify-full through a tunnel rather than silently not verifying', () => {
    expect(() =>
      tlsOptions({ ...my, host: '127.0.0.1', tlsServerName: 'db.prod', ssl: 'verify-full' }),
    ).toThrow(/Verify full through an SSH tunnel/);
    // Verify CA is honest about what it checks, so it is allowed.
    expect(
      tlsOptions({ ...my, host: '127.0.0.1', tlsServerName: 'db.prod', ssl: 'verify-ca' }),
    ).toMatchObject({ rejectUnauthorized: true, verifyIdentity: false });
  });
});
