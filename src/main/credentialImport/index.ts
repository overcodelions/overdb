// Everything overdb can import a connection from.
//
// Each source is read-only and additive: nothing here modifies another
// application's files, and nothing is imported without the user ticking it.

import { scanJetBrains, scanJetBrainsProjects, type ImportCandidate } from './jetbrains';
import { readPgpass } from './pgpass';
import { scanEnvironment } from './envUrl';

/// Passwords found during a scan, main-side only, keyed by sourceId.
/// The renderer receives `hasPassword` and never the value; `import:commit`
/// resolves it here and writes it straight to the keychain.
const scanned = new Map<string, string>();

export function takeScannedPassword(sourceId: string): string | undefined {
  return scanned.get(sourceId);
}

export interface ImportScan {
  /// Grouped by where they came from, because "17 connections" from four
  /// IDEs is a different proposition to 17 from one.
  sources: Array<{
    id: string;
    label: string;
    detail: string;
    candidates: ImportCandidate[];
  }>;
}

export function scanAll(projectRoot?: string): ImportScan {
  scanned.clear();
  const sources: ImportScan['sources'] = [];

  const jetbrains = scanJetBrains();
  if (jetbrains.length > 0) {
    sources.push({
      id: 'jetbrains',
      label: 'DataGrip / DataSpell / IntelliJ',
      detail: 'Passwords stay in the IDE — you supply those once per connection.',
      candidates: jetbrains,
    });
  }

  if (projectRoot) {
    const projects = scanJetBrainsProjects(projectRoot);
    // The same connection often exists globally and per-project; only show
    // the ones the global scan didn't already cover.
    const known = new Set(jetbrains.map((c) => c.sourceId));
    const extra = projects.filter((c) => !known.has(c.sourceId));
    if (extra.length > 0) {
      sources.push({
        id: 'jetbrains-projects',
        label: 'Project .idea configs',
        detail: `Found under ${projectRoot}`,
        candidates: extra,
      });
    }
  }

  const pgpass = readPgpass();
  if (pgpass.ok && pgpass.entries.length > 0) {
    sources.push({
      id: 'pgpass',
      label: '~/.pgpass',
      detail: 'Includes passwords — they move into your OS keychain on import.',
      candidates: pgpass.entries
        // A wildcard host is a rule, not a connection; there is nothing to
        // connect to and guessing a hostname would be worse than skipping.
        .filter((e) => !e.wildcard.host)
        .map((e, i) => { const sourceId = `pgpass:${i}:${e.host}:${e.database}`; if (e.password) scanned.set(sourceId, e.password); return ({
          sourceId,
          name: `${e.database === '*' ? 'postgres' : e.database}@${e.host}`,
          origin: '.pgpass',
          engine: 'postgres' as const,
          driver: 'postgresql',
          env: /prod/i.test(e.host) ? ('prod' as const) : /stag/i.test(e.host) ? ('staging' as const) : e.host === 'localhost' ? ('local' as const) : ('other' as const),
          host: e.host,
          port: e.port ?? 5432,
          ssl: (e.host === 'localhost' || e.host === '127.0.0.1' || e.host === '::1') ? undefined : ('verify-full' as const),
          database: e.wildcard.database ? undefined : e.database,
          user: e.wildcard.user ? undefined : e.user,
          hasPassword: !!e.password,
        }); }),
    });
  }

  const env = scanEnvironment();
  if (env.length > 0) {
    sources.push({
      id: 'env',
      label: 'Environment variables',
      detail: 'Read from overdb’s own environment — a Dock launch does not inherit your shell.',
      candidates: env.map((e) => ({
        sourceId: `env:${e.variable}`,
        name: e.variable,
        origin: 'environment',
        engine: e.engine,
        driver: e.engine ?? 'unknown',
        env: 'other' as const,
        host: e.host,
        port: e.port,
        ssl: (e.host === 'localhost' || e.host === '127.0.0.1' || e.host === '::1') ? undefined : ('verify-full' as const),
        database: e.database,
        user: e.user,
        note: e.hasPassword
          ? 'The URL contains a password; it moves into your OS keychain on import.'
          : undefined,
      })),
    });
  }

  return { sources };
}

export type { ImportCandidate };
