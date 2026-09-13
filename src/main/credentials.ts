// Turns a stored `Connection` (which holds no password) into a
// `ConnectSpec` (which does). Main-process only: the result goes straight
// into the connection host's first message and never crosses ipcMain.
//
// Every credential source converges here, and the shape of each is the
// same: the connection stores a REFERENCE — a keychain key, a variable
// name, an `op://` path, an argv, an IAM identity — and the value is
// produced at connect time and dropped. Only 'stored' keeps a copy, and it
// keeps it in the OS keychain rather than in the settings file.

import type { Connection, SecretSource } from '../shared/types';
import type { ConnectSpec } from '../db/adapter';
import { getSecret } from './secrets';
import { readOpSecret } from './credentialImport/onePassword';
import { runSecretCommand } from './credentialImport/command';
import { readEnvFileVar } from './credentialImport/envFile';
import { awsIamToken } from './credentialImport/awsIam';
import { openTunnel } from './tunnel';

/// Read-only is the default and the safe direction. Callers opt out only
/// through an explicit, expiring arm (v0.2).
export async function resolve(
  conn: Connection,
  opts: { readOnly?: boolean } = {},
): Promise<ConnectSpec> {
  const credential = await resolveCredential(conn);

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

/// `resolve`, plus the SSH tunnel if this connection has one.
///
/// Ordering is load-bearing twice over. The credential is minted against
/// the REAL hostname — an IAM token signed for 127.0.0.1 is signed for the
/// wrong endpoint — and TLS is verified against the real hostname too, via
/// `tlsServerName`, so a tunnel does not force anyone down to `require`.
///
/// `key` is what the tunnel's lifetime is tied to: a connection id for a
/// real session, something throwaway for a test.
export async function resolveWithTunnel(
  conn: Connection,
  key: string,
  opts: { readOnly?: boolean } = {},
): Promise<ConnectSpec> {
  const spec = await resolve(conn, opts);
  if (!conn.tunnel?.target?.trim() || !conn.host) return spec;

  const endpoint = await openTunnel(key, conn.tunnel, {
    host: conn.host,
    port: conn.port ?? defaultPort(conn),
  });
  spec.tlsServerName = conn.tunnel.remoteHost?.trim() || conn.host;
  spec.host = endpoint.host;
  spec.port = endpoint.port;
  return spec;
}

function defaultPort(conn: Connection): number {
  return conn.engine === 'mysql' ? 3306 : 5432;
}

export interface ResolvedCredential {
  password?: string;
  /// Only ever set by a source that ISSUES an identity rather than
  /// authenticating the one you typed.
  user?: string;
}

async function resolveCredential(conn: Connection): Promise<ResolvedCredential> {
  // Older records predate secretSource; a stored ref means 'stored'.
  const source: SecretSource = conn.secretSource ?? (conn.secretRef ? 'stored' : 'none');
  switch (source) {
    case 'none':
      return {};
    case 'stored':
      return { password: conn.secretRef ? getSecret(conn.secretRef) : undefined };
    case 'env': {
      const fromProcess = conn.secretEnvVar ? process.env[conn.secretEnvVar] : undefined;
      if (fromProcess) return { password: fromProcess };
      // The fallback that makes this source usable from the Dock.
      if (conn.secretEnvVar && conn.secretEnvFile) {
        const file = readEnvFileVar(conn.secretEnvFile, conn.secretEnvVar);
        if (!file.ok) throw new Error(`Environment: ${file.error}`);
        return { password: file.value };
      }
      return { password: undefined };
    }
    case 'op': {
      if (!conn.secretCommand) return {};
      const result = await readOpSecret(conn.secretCommand);
      if (!result.ok) throw new Error(`1Password: ${result.error}`);
      return { password: result.value };
    }
    case 'command': {
      if (!conn.secretArgv?.length) return {};
      const result = await runSecretCommand(conn.secretArgv);
      if (!result.ok) throw new Error(`Command: ${result.error}`);
      return { password: result.value };
    }
    case 'aws-iam': {
      if (!conn.host) throw new Error('AWS IAM: this connection has no host to sign a token for.');
      const result = await awsIamToken({
        host: conn.host,
        port: conn.port ?? defaultPort(conn),
        user: conn.user,
        database: conn.database,
        region: conn.region,
        profile: conn.awsProfile,
      });
      if (!result.ok) throw new Error(result.error);
      return { password: result.password, user: result.user };
    }
  }
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
