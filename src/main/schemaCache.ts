// Memoized catalogs, so the AI layer doesn't re-introspect 400 tables on
// every question. Mirrors the LRU-by-reinsertion idiom overgit uses for its
// landing-check preflight.

import type { SchemaSnapshot } from '../shared/types';

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 8;

interface Entry {
  at: number;
  snapshot: SchemaSnapshot;
  /// Which schemas this snapshot was introspected FOR — not which ones came
  /// back. A schema that turned out to be empty, or misread as one when it
  /// was really a table alias, still counts as covered; otherwise every
  /// question re-introspects a catalog that will never contain it.
  requested: string[];
  /// Tables whose shape was explicitly asked for. A pin added after the
  /// snapshot was taken has to invalidate it — otherwise pinning a table
  /// appears to do nothing for the next five minutes.
  requestedTables: string[];
}
const cache = new Map<string, Entry>();

/// True when the cached snapshot was built asking for every one of
/// `schemas` and every one of `tables`.
export function cachedCovers(
  connectionId: string,
  schemas: string[],
  tables: string[] = [],
): boolean {
  const hit = cache.get(connectionId);
  if (!hit) return false;
  const have = new Set(hit.requested.map((s) => s.toLowerCase()));
  const haveTables = new Set((hit.requestedTables ?? []).map((t) => t.toLowerCase()));
  return (
    schemas.every((s) => have.has(s.toLowerCase())) &&
    tables.every((t) => haveTables.has(t.toLowerCase()))
  );
}

export function cachedSchemaNames(connectionId: string): string[] {
  return cache.get(connectionId)?.requested ?? [];
}

export function getCached(connectionId: string): SchemaSnapshot | undefined {
  const hit = cache.get(connectionId);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(connectionId);
    return undefined;
  }
  // Re-insert so the most recently used entry is last, making the eviction
  // below drop the coldest rather than an arbitrary one.
  cache.delete(connectionId);
  cache.set(connectionId, hit);
  return hit.snapshot;
}

export function putCached(
  connectionId: string,
  snapshot: SchemaSnapshot,
  requested: string[] = snapshot.schemas.map((s) => s.name),
  requestedTables: string[] = [],
): void {
  cache.delete(connectionId);
  cache.set(connectionId, { at: Date.now(), snapshot, requested, requestedTables });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function invalidate(connectionId: string): void {
  cache.delete(connectionId);
}
