// Turns a stored `Connection` (which holds no password) into a
// `ConnectSpec` (which does). Main-process only: the result goes straight
// into the connection host's first message and never crosses ipcMain.

import type { Connection, SecretSource } from '../shared/types';
import type { ConnectSpec } from '../db/adapter';
import { getSecret } from './secrets';
import { readOpSecret } from './credentialImport/onePassword';

/// Read-only is the default and the safe direction. Callers opt out only
/// through an explicit, expiring arm (v0.2).
export async function resolve(
  conn: Connection,
  opts: { readOnly?: boolean } = {},
): Promise<ConnectSpec> {
  return {
    engine: conn.engine,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: await resolvePassword(conn),
    ssl: conn.ssl,
    file: conn.file,
    searchPath: conn.defaultSchema ? [conn.defaultSchema] : undefined,
    readOnly: opts.readOnly ?? true,
    statementTimeoutMs: statementTimeoutFor(conn),
  };
}

async function resolvePassword(conn: Connection): Promise<string | undefined> {
  // Older records predate secretSource; a stored ref means 'stored'.
  const source: SecretSource = conn.secretSource ?? (conn.secretRef ? 'stored' : 'none');
  switch (source) {
    case 'none':
      return undefined;
    case 'stored':
      return conn.secretRef ? getSecret(conn.secretRef) : undefined;
    case 'env':
      return conn.secretEnvVar ? process.env[conn.secretEnvVar] : undefined;
    case 'op': {
      if (!conn.secretCommand) return undefined;
      const result = await readOpSecret(conn.secretCommand);
      if (!result.ok) throw new Error(`1Password: ${result.error}`);
      return result.value;
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
