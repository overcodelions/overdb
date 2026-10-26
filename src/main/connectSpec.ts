// A `Connection` plus a credential, as the `ConnectSpec` a connection host
// is handed. Split out of credentials.ts so that `node dist/mcp/headless.js`
// — which has no keychain, no 1Password and no tunnels, and so cannot use
// credentials.ts — still builds exactly the spec the app builds.
//
// Electron-free: src/db/noElectron.test.ts walks the headless entry's
// imports and reaches this file.

import type { Connection } from '../shared/types';
import type { ConnectSpec } from '../db/adapter';

export function defaultPort(conn: Connection): number {
  return conn.engine === 'mysql' ? 3306 : 5432;
}

export function specFor(
  conn: Connection,
  credential: { password?: string; user?: string },
  opts: { readOnly?: boolean } = {},
): ConnectSpec {
  const spec: ConnectSpec = {
    engine: conn.engine,
    host: conn.host,
    port: conn.port,
    // MySQL has no schema/database distinction, so a connection's
    // defaultSchema IS its database — but the form lets you set one
    // without the other, and `defaultSchema` below only reaches postgres,
    // as searchPath. A mysql connection saved with an empty database and a
    // defaultSchema therefore came up on no database at all: every
    // unqualified statement failed with "No database selected" while the
    // picker showed the schema you had chosen. Same engine mapping as the
    // supervisor's applyChosenSchema — postgres gets a search path,
    // dynamodb a region, everything else a database.
    database: conn.engine === 'mysql' ? conn.database || conn.defaultSchema : conn.database,
    // Redshift's IAM path issues a temporary user as well as a password,
    // and it is not the one in the form: `IAM:alice`, not `alice`. Using
    // the typed name there fails with a message about the password.
    user: credential.user ?? conn.user,
    password: credential.password,
    ssl: conn.ssl,
    ...(conn.tlsServerName ? { tlsServerName: conn.tlsServerName } : {}),
    sslRootCert: conn.sslRootCert,
    sslCert: conn.sslCert,
    sslKey: conn.sslKey,
    file: conn.file,
    region: conn.region,
    profile: conn.awsProfile,
    tableFilter: conn.tableFilter,
    searchPath: conn.defaultSchema ? [conn.defaultSchema] : undefined,
    readOnly: opts.readOnly ?? true,
    statementTimeoutMs: statementTimeoutFor(conn),
  };

  // An IAM token is a bearer credential with a fifteen-minute life, sitting
  // in the password field. Sending one over a plaintext socket hands it to
  // anyone on the path. This is not a preference, so it is not a checkbox:
  // the connection is encrypted or the token is not sent.
  if (conn.secretSource === 'aws-iam' && (!spec.ssl || spec.ssl === 'disable')) {
    spec.ssl = 'require';
  }

  return spec;
}

/// Timeouts follow the environment, a small place the env-first model pays
/// off: a runaway query on your laptop is an annoyance, and on prod it is
/// an incident.
export function statementTimeoutFor(conn: Connection): number | null {
  switch (conn.env) {
    case 'local':
      return null;
    case 'prod':
      return 30_000;
    default:
      return 60_000;
  }
}
