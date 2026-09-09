// Memoized catalogs, so the AI layer doesn't re-introspect 400 tables on
// every question. Mirrors the LRU-by-reinsertion idiom overgit uses for its
// landing-check preflight.

import type { SchemaSnapshot } from '../shared/types';

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 8;

interface Entry {
  at: number;
  snapshot: SchemaSnapshot;
}
const cache = new Map<string, Entry>();

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

export function putCached(connectionId: string, snapshot: SchemaSnapshot): void {
  cache.delete(connectionId);
  cache.set(connectionId, { at: Date.now(), snapshot });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function invalidate(connectionId: string): void {
  cache.delete(connectionId);
}
