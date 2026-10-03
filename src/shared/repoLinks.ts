import type { Connection, EnvSet } from './types';
import type { RepoLinkOwner } from './overcliHandoff';

// Which repos hold the code for which schemas.
//
// A set (or a connection in no set) links any number of repos, and each
// repo says which schemas its code uses — one service per schema is the
// common shape. Reading the code for a seed or a base then reads the repos
// for the schemas in play, each labelled with what it owns, rather than
// whichever repo was linked first.

export interface RepoLink {
  path: string;
  /// null: not mapped yet, so it may use any schema.
  schemas: string[] | null;
  /// Where a base recipe is saved.
  home: boolean;
}

function holder(owner: RepoLinkOwner, connections: readonly Connection[], envSets: readonly EnvSet[]) {
  return owner.kind === 'envSet' ? envSets.find((s) => s.id === owner.id) : connections.find((c) => c.id === owner.id);
}

export function repoLinks(owner: RepoLinkOwner, connections: readonly Connection[], envSets: readonly EnvSet[]): RepoLink[] {
  const h = holder(owner, connections, envSets);
  const paths = h?.repoPaths ?? [];
  const home = h?.recipeRepo && paths.includes(h.recipeRepo) ? h.recipeRepo : paths[0];
  return paths.map((path) => ({ path, schemas: h?.repoSchemas?.[path] ?? null, home: path === home }));
}

/// The repos to read for work touching `schemas`: those mapped to any of
/// them first, then unmapped ones. A repo mapped only to other schemas is
/// left out. When nothing matches, every repo — reading too much beats
/// reading nothing. `schemas` null means all of them.
export function reposFor(links: readonly RepoLink[], schemas: readonly string[] | null): RepoLink[] {
  if (!schemas) return [...links];
  const want = new Set(schemas.map((s) => s.toLowerCase()));
  const hits = links.filter((l) => l.schemas?.some((s) => want.has(s.toLowerCase())));
  const open = links.filter((l) => l.schemas === null);
  const picked = [...hits, ...open];
  return picked.length ? picked : [...links];
}

/// Where a base recipe lives: the repo marked as its home, else the first.
export function recipeHome(links: readonly RepoLink[]): string | null {
  return (links.find((l) => l.home) ?? links[0])?.path ?? null;
}

/// For a prompt: which repo is which, so a model reading several knows
/// whose code answers a question about which schema.
export function reposNote(links: readonly RepoLink[], cwd: string): string {
  if (links.length <= 1 && !links[0]?.schemas) return '';
  const lines = links.map((l) => {
    const where = l.path === cwd ? `${l.path} (the working directory)` : l.path;
    return `- ${where}: ${l.schemas?.length ? `the code for schema${l.schemas.length === 1 ? '' : 's'} ${l.schemas.join(', ')}` : 'schemas not mapped'}`;
  });
  return `The code lives in ${links.length === 1 ? 'this repo' : 'these repos'}:\n${lines.join('\n')}\nRead the repo that owns a schema for questions about its tables.`;
}

/// Schemas no app keeps its data in.
const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'pg_catalog', 'pg_toast', 'public_test']);

export function appSchemas(schemas: readonly string[]): string[] {
  return schemas.filter((s) => !SYSTEM_SCHEMAS.has(s.toLowerCase()) && !s.toLowerCase().startsWith('pg_'));
}

/// Evidence that a repo's code uses a schema, gathered by a scan of it.
export interface SchemaEvidence {
  /// Named in a config file: a datasource URL, a yml/properties key.
  config: number;
  /// Written as `schema.table`, or quoted on its own, in code or SQL.
  code: number;
}

/// Which schemas a scan suggests, strongest first. Config is the strong
/// signal — a service names its database once, in its datasource — and
/// code needs a few mentions, because a short schema name is also a word.
/// The repo's own name matching counts too.
export function suggestSchemas(evidence: Record<string, SchemaEvidence>, repoPath: string): string[] {
  const base = repoPath.split('/').pop()?.toLowerCase().replace(/[-_.]/g, '') ?? '';
  return Object.entries(evidence)
    .map(([schema, e]) => {
      const named = base && base.includes(schema.toLowerCase().replace(/[-_.]/g, '')) ? 2 : 0;
      return { schema, score: e.config * 3 + e.code + named };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || a.schema.localeCompare(b.schema))
    .map((x) => x.schema);
}

/// Every repo, the ones for `schemas` first: a seed reads them all, because
/// the ticket may be about a service whose schema it did not start from.
export function reposInOrder(links: readonly RepoLink[], schemas: readonly string[]): RepoLink[] {
  const first = reposFor(links, schemas);
  return [...first, ...links.filter((l) => !first.includes(l))];
}

/// Schemas a piece of text seems to be about: a schema whose distinctive
/// word appears in it ("learning" for `acme_learning_management`). Words
/// most schemas share — a product prefix — say nothing, nor do short ones.
export function schemasMentioned(text: string, schemas: readonly string[], exclude: readonly string[] = []): string[] {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const seen = new Map<string, number>();
  for (const s of schemas) for (const w of new Set(words(s))) seen.set(w, (seen.get(w) ?? 0) + 1);
  const common = (w: string) => schemas.length >= 3 && (seen.get(w) ?? 0) / schemas.length >= 0.5;
  const said = words(text);
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  return schemas.filter((s) => {
    if (skip.has(s.toLowerCase())) return false;
    const own = words(s).filter((w) => w.length >= 4 && !common(w));
    // A stem, so "learners" and "learning" both find `learning`.
    return own.some((w) => said.some((t) => t.startsWith(w.slice(0, Math.max(4, w.length - 3)))));
  });
}
