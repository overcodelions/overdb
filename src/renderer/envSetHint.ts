// Noticing that two connections are one database.
//
// An environment set is the thing overdb is built around, and nobody makes
// one on day one: they add `orders local`, then `orders staging`, and query
// each in turn the way every other client taught them to. By the second
// connection the app can see what they have — the same database name in two
// environments — and say so once, with the set already filled in.
//
// Deliberately conservative. A wrong suggestion teaches people to ignore the
// card, so this only speaks when the names agree once the environment words
// are taken out, the engines match, and the environments differ.

import type { Connection, EnvKind, EnvSet } from '@shared/types';

export interface EnvSetSuggestion {
  /// Stable for the same members, so "Not now" sticks to this suggestion and
  /// a new connection that joins the group asks again.
  id: string;
  name: string;
  memberIds: string[];
  baselineId: string;
}

/// Words that name WHERE a database runs rather than WHAT it is.
const ENV_WORDS = new Set([
  'local', 'localhost', 'dev', 'develop', 'development', 'sandbox', 'sbx', 'test', 'qa', 'uat',
  'stage', 'staging', 'stg', 'preprod', 'prod', 'production', 'prd', 'live', 'copy', 'replica',
]);

/// The truth first: a baseline is what the others are compared against.
const BASELINE_ORDER: EnvKind[] = ['prod', 'staging', 'sandbox', 'dev', 'local', 'other'];

/// What a connection's database is called with the environment taken out.
/// `orders_staging`, `orders-prod` and `orders` all come out as `orders`.
export function logicalName(c: Connection): string {
  const raw =
    c.database ||
    (c.file ? (c.file.split(/[\\/]/).pop() ?? '').replace(/\.(sqlite3?|db3?)$/i, '') : '') ||
    c.name;
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !ENV_WORDS.has(w))
    .join('-');
}

export function suggestEnvSet(
  connections: Connection[],
  envSets: EnvSet[],
  dismissed: string[],
): EnvSetSuggestion | null {
  const groups = new Map<string, Connection[]>();
  for (const c of connections) {
    const name = logicalName(c);
    if (!name) continue;
    const key = `${c.engine}:${name}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  for (const [key, members] of groups) {
    if (new Set(members.map((c) => c.env)).size < 2) continue;
    const ids = members.map((c) => c.id).sort();
    // Already covered: some live set holds every one of them.
    if (envSets.some((e) => !e.archived && ids.every((id) => e.memberIds.includes(id)))) continue;
    const id = `envset:${ids.join(',')}`;
    if (dismissed.includes(id)) continue;
    const baseline = [...members].sort(
      (a, b) => BASELINE_ORDER.indexOf(a.env) - BASELINE_ORDER.indexOf(b.env),
    )[0];
    return {
      id,
      name: key.slice(key.indexOf(':') + 1),
      memberIds: members.map((c) => c.id),
      baselineId: baseline.id,
    };
  }
  return null;
}
