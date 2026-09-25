// Importing connections from DBeaver.
//
// DBeaver keeps each project's connections in plain JSON:
// `<workspace>/<project>/.dbeaver/data-sources*.json`. This reads those.
//
// What it does NOT read is `credentials-config.json`. DBeaver encrypts that
// file with a key baked into every copy of DBeaver, so it could be opened —
// and that is exactly why it isn't: same stance as the JetBrains import,
// another application's secrets are not overdb's to take. A username that
// DBeaver kept outside that file still transfers; you supply the password
// once per connection.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJdbcUrl } from '../../shared/jdbcUrl';
import type { Engine, EnvKind, SslMode } from '../../shared/types';
import { variantFromDriver } from '../../shared/engines';
import { envForGroup, type ImportCandidate } from './jetbrains';

interface DbeaverHandler {
  enabled?: boolean;
  properties?: Record<string, unknown>;
}

interface DbeaverConnection {
  provider?: string;
  driver?: string;
  name?: string;
  folder?: string;
  configuration?: {
    host?: string;
    port?: string | number;
    database?: string;
    url?: string;
    user?: string;
    type?: string;
    'auth-model'?: string;
    handlers?: Record<string, DbeaverHandler>;
  };
}

const DEFAULT_PORT: Partial<Record<Engine, number>> = { postgres: 5432, mysql: 3306 };

/// DBeaver's provider id says the family outright; the driver id refines it
/// (a Redshift connection can sit under the postgresql provider).
function engineFor(provider: string, driver: string): Engine | null {
  const p = provider.toLowerCase();
  const d = driver.toLowerCase();
  if (p === 'postgresql' || p === 'redshift' || p === 'cockroachdb' || d.includes('redshift')) return 'postgres';
  if (p === 'mysql' || p === 'mariadb') return 'mysql';
  if (p === 'sqlite') return 'sqlite';
  return null;
}

/// DBeaver's own connection type. Only 'prod' is a deliberate signal —
/// every connection starts as 'dev', so that one says nothing.
function envFor(conn: DbeaverConnection, name: string): EnvKind {
  const type = conn.configuration?.type?.toLowerCase();
  if (type === 'prod') return 'prod';
  const guessed = envForGroup(conn.folder, name);
  if (guessed === 'other' && type === 'test') return 'dev';
  return guessed;
}

const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

function sslFor(handlers: Record<string, DbeaverHandler> | undefined): SslMode | undefined {
  for (const [id, handler] of Object.entries(handlers ?? {})) {
    if (!/ssl/i.test(id) || !handler.enabled) continue;
    const mode = handler.properties?.sslMode ?? handler.properties?.['ssl.mode'];
    if (typeof mode === 'string' && (SSL_MODES as string[]).includes(mode)) return mode as SslMode;
    return 'require';
  }
  return undefined;
}

export function parseDbeaverDataSources(json: string, origin: string): ImportCandidate[] {
  let doc: { connections?: Record<string, DbeaverConnection> };
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  const out: ImportCandidate[] = [];

  for (const [id, conn] of Object.entries(doc.connections ?? {})) {
    const cfg = conn.configuration ?? {};
    const name = conn.name ?? id;
    const provider = conn.provider ?? '';
    const driver = conn.driver || provider || 'unknown';
    // The URL is authoritative when the connection was set up by URL; the
    // separate fields are what the dialog writes otherwise.
    const parsed = cfg.url ? parseJdbcUrl(cfg.url) : null;
    const engine = engineFor(provider, driver) ?? parsed?.engine ?? null;
    const redshift = /redshift/i.test(`${provider} ${driver}`);
    const port = cfg.port !== undefined && cfg.port !== '' ? Number(cfg.port) : parsed?.port;

    const notes: string[] = [];
    if (redshift) notes.push('Redshift speaks the Postgres wire protocol — imported as Postgres.');
    else if (!engine) notes.push(`${provider || driver} is not supported yet.`);
    if (cfg.handlers?.ssh_tunnel?.enabled) notes.push('Uses an SSH tunnel in DBeaver — set it up again in the connection form.');

    out.push({
      sourceId: `dbeaver:${id}`,
      name,
      origin,
      engine,
      variant: variantFromDriver(driver),
      driver,
      env: envFor(conn, name),
      group: conn.folder,
      host: engine === 'sqlite' ? undefined : (cfg.host || parsed?.host),
      port: engine === 'sqlite' ? undefined : (port ?? (engine ? DEFAULT_PORT[engine] : undefined)),
      database: cfg.database || parsed?.database,
      user: cfg.user || undefined,
      ssl: sslFor(cfg.handlers),
      note: notes.length > 0 ? notes.join(' ') : undefined,
    });
  }
  return out;
}

/// DBeaver's workspace, per platform. `workspace6` has been the name since
/// DBeaver 6; nothing older is worth chasing.
function workspaceDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, 'Library', 'DBeaverData', 'workspace6'),
    path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'DBeaverData', 'workspace6'),
  ];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'DBeaverData', 'workspace6'));
  return dirs;
}

export function scanDbeaver(roots: string[] = workspaceDirs()): ImportCandidate[] {
  const seen = new Map<string, ImportCandidate>();
  for (const root of roots) {
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.name.startsWith('.')) continue;
      const dir = path.join(root, project.name, '.dbeaver');
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => /^data-sources.*\.json$/.test(f));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const json = fs.readFileSync(path.join(dir, file), 'utf-8');
          for (const candidate of parseDbeaverDataSources(json, project.name)) {
            if (!seen.has(candidate.sourceId)) seen.set(candidate.sourceId, candidate);
          }
        } catch {
          // One unreadable file skips that file, not the scan.
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
