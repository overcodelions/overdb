// Importing connections from DataGrip / DataSpell / IntelliJ.
//
// Retyping twenty connections is the reason people don't try a new database
// client. JetBrains keeps them in a readable XML file, so this reads it.
//
// What it does NOT read is passwords: those live in the IDE's own credential
// store, not the XML. That is the right outcome anyway — overdb asking the
// OS keychain for another application's secrets would be a poor way to
// introduce itself. Everything else transfers, and you supply the password
// once per connection.
//
// The name/host/database are split across two files: `dataSources.xml` holds
// the connection, `dataSources.local.xml` holds the username, joined on uuid.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJdbcUrl } from '../../shared/jdbcUrl';
import type { EnvKind, Engine } from '../../shared/types';

export interface ImportCandidate {
  /// Only ever set by sources that legitimately hold one (a .pgpass the
  /// user owns, a URL in their own environment). Never read from another
  /// application's keychain.
  password?: string;
  /// Stable across re-scans, so re-importing does not duplicate.
  sourceId: string;
  name: string;
  origin: string;
  engine: Engine | null;
  driver: string;
  env: EnvKind;
  group?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /// Set when the source driver is not natively supported but speaks a
  /// protocol overdb does — Redshift over the Postgres wire.
  note?: string;
}

/// JetBrains group names are free text, but in practice they say exactly
/// what environment they are. Anything unrecognised stays 'other' rather
/// than being guessed into prod.
export function envForGroup(group: string | undefined, name: string): EnvKind {
  const text = `${group ?? ''} ${name}`.toLowerCase();
  if (/\bprod|production\b/.test(text)) return 'prod';
  if (/\bstag|staging|stg\b/.test(text)) return 'staging';
  if (/\blocal|localhost\b/.test(text)) return 'local';
  if (/\bdev|sandbox|sbox|test\b/.test(text)) return 'dev';
  return 'other';
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

function element(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m?.[1];
}

/// Split on data-source boundaries. A regex rather than an XML parser
/// because this is one machine-generated file shape, and adding a
/// dependency to read it would not make it more correct.
function dataSourceBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<data-source\b[^>]*>[\s\S]*?<\/data-source>|<data-source\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}

/// uuid -> username, from the companion .local.xml.
function usernames(localXml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of dataSourceBlocks(localXml)) {
    const uuid = attr(block, 'uuid');
    const user = element(block, 'user-name');
    if (uuid && user) map.set(uuid, user);
  }
  return map;
}

export function parseDataSources(
  xml: string,
  localXml: string,
  origin: string,
): ImportCandidate[] {
  const users = usernames(localXml);
  const out: ImportCandidate[] = [];

  for (const block of dataSourceBlocks(xml)) {
    const name = attr(block, 'name');
    const uuid = attr(block, 'uuid');
    const group = attr(block, 'group');
    const url = element(block, 'jdbc-url');
    if (!name || !url) continue;

    const parsed = parseJdbcUrl(url);
    out.push({
      sourceId: uuid ?? `${origin}:${name}`,
      name,
      origin,
      engine: parsed?.engine ?? null,
      driver: parsed?.driver ?? element(block, 'driver-ref') ?? 'unknown',
      env: envForGroup(group, name),
      group,
      host: parsed?.host,
      port: parsed?.port,
      database: parsed?.database,
      user: uuid ? users.get(uuid) : undefined,
      note: parsed?.viaCompatibleProtocol
        ? `${parsed.driver} speaks the Postgres wire protocol — imported as Postgres.`
        : parsed?.engine === null
          ? `${parsed.driver} is not supported yet.`
          : undefined,
    });
  }
  return out;
}

/// Every JetBrains product config on this machine, newest-looking last.
function jetbrainsConfigDirs(): string[] {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'JetBrains'),
    path.join(os.homedir(), '.config', 'JetBrains'),
  ];
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const options = path.join(root, entry, 'options');
      if (fs.existsSync(path.join(options, 'dataSources.xml'))) out.push(options);
    }
  }
  return out.sort();
}

export function scanJetBrains(): ImportCandidate[] {
  const seen = new Map<string, ImportCandidate>();
  for (const dir of jetbrainsConfigDirs()) {
    const origin = path.basename(path.dirname(dir));
    try {
      const xml = fs.readFileSync(path.join(dir, 'dataSources.xml'), 'utf-8');
      let localXml = '';
      try {
        localXml = fs.readFileSync(path.join(dir, 'dataSources.local.xml'), 'utf-8');
      } catch {
        // Usernames are optional; the connection still imports without one.
      }
      for (const candidate of parseDataSources(xml, localXml, origin)) {
        // The same connection appears in every IDE that has it. Keep one,
        // preferring whichever copy carries a username.
        const existing = seen.get(candidate.sourceId);
        if (!existing || (!existing.user && candidate.user)) seen.set(candidate.sourceId, candidate);
      }
    } catch {
      // An unreadable product config skips that product, not the scan.
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/// Project-level configs: `<repo>/.idea/dataSources.xml`. These hold the
/// connections someone actually uses for that service, and are often richer
/// than the global list.
export function scanJetBrainsProjects(root: string, maxDepth = 3): ImportCandidate[] {
  const found: ImportCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Never descend into these: they are large, and no config we want
      // lives inside them.
      if (['node_modules', '.git', 'dist', 'build', 'target', 'vendor'].includes(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === '.idea') {
        const file = path.join(child, 'dataSources.xml');
        if (fs.existsSync(file)) {
          try {
            const localFile = path.join(child, 'dataSources.local.xml');
            const localXml = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf-8') : '';
            found.push(
              ...parseDataSources(
                fs.readFileSync(file, 'utf-8'),
                localXml,
                path.basename(dir),
              ),
            );
          } catch {
            // One unreadable project should not stop the scan.
          }
        }
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}
