// Real driver strings in, an actionable sentence out.
//
// Every message below is one a driver actually produces; they are the point
// of the module, so they are the test.

import { describe, expect, it } from 'vitest';
import { diagnose } from './connectDiagnosis';

const pg = { engine: 'postgres' as const, host: 'db.internal', port: 5432, user: 'app', database: 'orders' };
const my = { engine: 'mysql' as const, host: 'db.internal', port: 3306, user: 'app', database: 'orders' };

function labels(d: ReturnType<typeof diagnose>): string[] {
  return d.fixes.map((f) => f.label);
}

describe('reaching the server', () => {
  it('names the host and port on a refused connection', () => {
    const d = diagnose({ ...pg, error: 'connect ECONNREFUSED 127.0.0.1:5433', port: 5433 });
    expect(d.cause).toContain('db.internal:5433');
    // The standard port is offered only when it is not the one being used.
    expect(d.fixes[0].set).toEqual({ port: 5432 });
  });

  it('does not offer the standard port when it is already set', () => {
    const d = diagnose({ ...pg, error: 'connect ECONNREFUSED 127.0.0.1:5432' });
    expect(d.fixes.some((f) => f.set?.port)).toBe(false);
  });

  it('separates a timeout from a refusal', () => {
    const d = diagnose({ ...pg, error: 'connect ETIMEDOUT 10.0.0.4:5432' });
    expect(d.cause).toMatch(/dropped, not refused/);
  });

  it('reports an unresolvable host as a name problem', () => {
    const d = diagnose({ ...pg, error: 'getaddrinfo ENOTFOUND db.internal' });
    expect(d.cause).toContain('db.internal');
    expect(labels(d)).toEqual(['Check the host name']);
  });
});

describe('TLS', () => {
  it('turns pg_hba "no encryption" into a Require SSL fix', () => {
    const d = diagnose({
      ...pg,
      ssl: 'disable',
      error: 'no pg_hba.conf entry for host "10.0.0.9", user "app", database "orders", no encryption',
    });
    expect(d.fixes[0].set).toEqual({ ssl: 'require' });
  });

  // Turning verification off is offered LAST, on purpose. It is one click,
  // it always works, and a great many connections stayed on `require`
  // forever because it was the only button on the panel.
  it('offers the CA before offering to stop verifying', () => {
    const d = diagnose({ ...pg, ssl: 'verify-full', error: 'self signed certificate in certificate chain' });
    expect(d.fixes[0].label).toMatch(/CA/);
    expect(d.fixes.map((f) => f.set?.ssl)).toEqual([undefined, 'verify-ca', 'require']);
    expect(d.cause).toMatch(/trust store/);
  });

  // A name mismatch means the chain verified and only the hostname did not,
  // so dropping to `require` would throw away a check that just passed.
  it('offers Verify CA when the certificate names another host', () => {
    const d = diagnose({ ...pg, ssl: 'verify-full', error: "Hostname/IP does not match certificate's altnames" });
    expect(d.fixes[0].set).toEqual({ ssl: 'verify-ca' });
  });

  it('offers to disable when the server has no TLS at all', () => {
    const d = diagnose({ ...pg, ssl: 'require', error: 'The server does not support SSL connections' });
    expect(d.fixes[0].set).toEqual({ ssl: 'disable' });
  });

  it('reads MySQL insecure-transport as a Require SSL fix', () => {
    const d = diagnose({ ...my, ssl: 'disable', error: 'Connections using insecure transport are prohibited while --require_secure_transport=ON.' });
    expect(d.fixes[0].set).toEqual({ ssl: 'require' });
  });
});

// Each of these sources fails BEFORE the network, with a prefix of its
// own, and the prefix is what lets the panel say which of them it was
// rather than showing a driver error that never happened.
describe('sources that fail before the database is reached', () => {
  it('separates the tunnel from the database', () => {
    const d = diagnose({ ...pg, error: 'SSH tunnel: ssh exited before the forward was open.' });
    expect(d.cause).toMatch(/never reached/);
  });

  it('names the credential command', () => {
    const d = diagnose({ ...pg, secretSource: 'command', error: 'Command: vault exited with status 2' });
    expect(d.cause).toMatch(/command that produces the password/);
    expect(d.fixes[0].detail).toMatch(/PATH|Dock/);
  });

  it('sends an IAM failure to AWS rather than to the password field', () => {
    const d = diagnose({ ...pg, secretSource: 'aws-iam', error: 'AWS IAM: the AWS session has expired.' });
    expect(d.cause).toMatch(/IAM token/);
    expect(d.fixes[0].detail).toMatch(/sso login/);
  });

  it('points a certificate problem at the file, not at the server', () => {
    const d = diagnose({ ...pg, ssl: 'verify-full', error: 'TLS: the CA certificate file was not found at /tmp/ca.pem.' });
    expect(d.cause).toMatch(/certificate or key file/);
  });

  it('explains an env file that did not resolve', () => {
    const d = diagnose({ ...pg, secretSource: 'env', error: 'Environment: PGPASSWORD is not defined in ~/.env.' });
    expect(d.cause).toMatch(/environment variable/);
  });
});

describe('authentication', () => {
  it('distinguishes "wrong password" from "no password sent"', () => {
    const wrong = diagnose({ ...pg, secretSource: 'stored', error: 'password authentication failed for user "app"' });
    expect(wrong.cause).toMatch(/rejected the password/);

    const none = diagnose({ ...my, secretSource: 'none', error: "Access denied for user 'app'@'10.0.0.9' (using password: NO)" });
    expect(none.cause).toMatch(/none was sent/);
  });

  it('offers every OTHER source, never the one already chosen', () => {
    const d = diagnose({ ...pg, secretSource: 'env', error: 'password authentication failed for user "app"' });
    const sources = d.fixes.map((f) => f.set?.secretSource).filter(Boolean);
    expect(sources).toEqual(['stored', 'op', 'command', 'aws-iam', 'none']);
  });

  it('explains a source that resolved to nothing', () => {
    const d = diagnose({ ...pg, secretSource: 'env', error: 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string' });
    expect(d.cause).toMatch(/produced no password/);
    expect(d.fixes[0].detail).toMatch(/Dock/);
  });

  it('knows caching_sha2 needs TLS before it will talk', () => {
    const d = diagnose({ ...my, ssl: 'disable', error: 'ER_NOT_SUPPORTED_AUTH_MODE: Client does not support authentication protocol requested by server' });
    expect(d.fixes[0].set).toEqual({ ssl: 'require' });
  });

  it('treats a bare pg_hba refusal as both a TLS and an auth question', () => {
    const d = diagnose({ ...pg, error: 'no pg_hba.conf entry for host "10.0.0.9", user "app", database "orders", SSL on' });
    expect(d.fixes[0].set).toEqual({ ssl: 'require' });
    expect(labels(d)).toContain('Ask for a pg_hba rule');
  });
});

describe('right server, wrong thing', () => {
  it('reports a missing database as such', () => {
    const d = diagnose({ ...pg, error: 'database "ordrs" does not exist' });
    expect(d.cause).toContain('orders');
    expect(d.fixes[0].detail).toMatch(/Authentication succeeded/);
  });

  it('reports a missing role', () => {
    const d = diagnose({ ...pg, error: 'role "app" does not exist' });
    expect(labels(d)).toEqual(['Check the user name']);
  });

  it('reads MySQL ER_BAD_DB_ERROR the same way', () => {
    const d = diagnose({ ...my, error: "ER_BAD_DB_ERROR: Unknown database 'ordrs'" });
    expect(d.cause).toContain('orders');
  });
});

describe('engines that authenticate elsewhere', () => {
  const dyn = { engine: 'dynamodb' as const };

  it('sends you to the AWS chain, not to a password field', () => {
    const d = diagnose({ ...dyn, error: 'CredentialsProviderError: Could not load credentials from any providers' });
    expect(labels(d)).toEqual(['Sign in to AWS', 'Check the profile name']);
  });

  it('names an expired SSO session', () => {
    const d = diagnose({ ...dyn, error: 'ExpiredTokenException: The security token included in the request is expired' });
    expect(d.cause).toMatch(/expired/);
  });

  it('separates "not allowed" from "not signed in"', () => {
    const d = diagnose({ ...dyn, error: 'AccessDeniedException: User is not authorized to perform: dynamodb:ListTables' });
    expect(labels(d)).toEqual(['Needs an IAM policy']);
  });

  it('never offers a password source for an engine that has none', () => {
    for (const engine of ['dynamodb', 'sqlite'] as const) {
      const d = diagnose({ engine, error: 'something nobody has seen before' });
      expect(d.fixes.some((f) => f.set?.secretSource)).toBe(false);
    }
  });
});

describe('the unrecognized case', () => {
  it('still offers the auth options, because it is usually one of them', () => {
    const d = diagnose({ ...pg, ssl: 'disable', secretSource: 'none', error: 'Error: connection terminated unexpectedly' });
    expect(d.fixes[0].set).toEqual({ ssl: 'require' });
    expect(d.fixes.some((f) => f.set?.secretSource === 'stored')).toBe(true);
  });
});
