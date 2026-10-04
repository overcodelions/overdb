import type { SchemaInfo, SchemaSnapshot } from './types';
import { jsonBody } from './seedSql';

// A map of a database and the code that uses it, made once and reused.
//
// Every seed used to rediscover the same things — which tables hold what,
// the values a status column takes, the links only the code makes — by
// reading the repos again. The map is that knowledge written down: one pass
// per linked repo reads the code for its schemas, and what it says is
// checked against the real catalog before it is kept. A seed then plans
// from the slice of the map its ticket touches, in one quick call, and
// reads the code live only when asked to dig deeper.

export const MAP_VERSION = 1;

export interface MapRef {
  /// `path:line`, relative to the repo.
  ref?: string;
}

export interface MapValues extends MapRef {
  column: string;
  values: string[];
}

export interface MapJson extends MapRef {
  column: string;
  shape: string;
}

export interface MapRule extends MapRef {
  text: string;
  /// Learned by a seed that read the code, rather than by the mapping pass.
  learnedAt?: string;
}

export interface MapTable {
  /// What the table is for, in a sentence.
  purpose: string;
  /// The repo whose code owns it, and where in it.
  repo?: string;
  module?: string;
  values: MapValues[];
  json: MapJson[];
  rules: MapRule[];
}

export interface MapLink extends MapRef {
  /// `schema.table.column`.
  from: string;
  to: string;
  why: string;
}

export interface MapRepo {
  path: string;
  /// The commit it was mapped at, when the repo is a git repo.
  head: string | null;
  mappedAt: string;
  schemas: string[];
}

export interface DbMap {
  version: number;
  /// What it maps: an env set or a lone connection.
  owner: { kind: 'envSet' | 'connection'; id: string; name: string };
  builtAt: string;
  updatedAt: string;
  repos: MapRepo[];
  /// A fingerprint of each schema's tables and columns when it was mapped.
  schemas: Record<string, string>;
  /// By `schema.table`, lower case.
  tables: Record<string, MapTable>;
  links: MapLink[];
  /// How the last build or refresh went, for judging its speed: what each
  /// repo's scan found and how long each pass took. Replaced by every run.
  lastRun?: MapRun;
}

export interface MapRun {
  startedAt: string;
  /// Absent while it runs, and when it was stopped.
  finishedAt?: string;
  model?: string;
  /// Passes run at once.
  concurrency: number;
  scans: Array<{ repo: string; named: number; total: number; parts: number; ms: number }>;
  passes: Array<{ repo: string; part: number; of: number; tables: number; files: number; ms: number; ok: boolean }>;
}

// ---- the catalog ---------------------------------------------------------

/// Tables and columns, so a change to either shows the map is behind.
/// Order-independent; types included, since a column turned JSON matters.
export function schemaFingerprint(schema: SchemaInfo): string {
  const parts = schema.tables
    .filter((t) => t.kind === 'table')
    .map((t) => `${t.name.toLowerCase()}(${t.columns.map((c) => `${c.name.toLowerCase()}:${c.typeName.toLowerCase()}`).sort().join(',')})`)
    .sort();
  let h = 2166136261;
  for (const ch of parts.join(';')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return `${parts.length}:${(h >>> 0).toString(16)}`;
}

/// The catalog as a prompt sees it: one line per table, columns with types.
/// Long tables are cut, and a very large catalog drops types first.
export function catalogLines(snapshot: SchemaSnapshot, schemas: readonly string[], budget = 120_000): string {
  const want = new Set(schemas.map((s) => s.toLowerCase()));
  const tables = snapshot.schemas
    .filter((s) => want.has(s.name.toLowerCase()))
    .flatMap((s) => s.tables.filter((t) => t.kind === 'table').map((t) => ({ schema: s.name, t })));
  const line = (x: (typeof tables)[number], typed: boolean) =>
    `${x.schema}.${x.t.name}(${x.t.columns
      .slice(0, 40)
      .map((c) => (typed ? `${c.name} ${c.typeName}` : c.name))
      .join(', ')}${x.t.columns.length > 40 ? ', …' : ''})`;
  const full = tables.map((x) => line(x, true)).join('\n');
  return full.length <= budget ? full : tables.map((x) => line(x, false)).join('\n').slice(0, budget);
}

interface Known {
  tables: Map<string, Set<string>>;
}

function known(snapshot: SchemaSnapshot): Known {
  const tables = new Map<string, Set<string>>();
  for (const s of snapshot.schemas)
    for (const t of s.tables) tables.set(`${s.name}.${t.name}`.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase())));
  return { tables };
}

// ---- reading an answer ---------------------------------------------------

const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown, max = 400): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const ref = (v: unknown): string | undefined => str(v, 200) || undefined;

/// A mapping pass's answer, kept only where it names real tables and
/// columns. `dropped` counts what was invented.
export function parseMapAnswer(
  raw: string,
  snapshot: SchemaSnapshot,
  repo: string,
): { tables: Record<string, MapTable>; links: MapLink[]; dropped: number } | { error: string } {
  const body = jsonBody(raw);
  if (!body) return { error: 'The answer had no JSON in it.' };
  let parsed: { tables?: unknown; links?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'The answer’s JSON did not parse.' };
  }
  const k = known(snapshot);
  let dropped = 0;
  const tables: Record<string, MapTable> = {};
  for (const raw of arr(parsed.tables, 2000)) {
    const t = raw as Record<string, unknown>;
    const key = str(t.table, 200).toLowerCase();
    const cols = k.tables.get(key);
    if (!cols) {
      dropped += 1;
      continue;
    }
    const column = (c: unknown) => {
      const name = str(c, 120).toLowerCase();
      if (cols.has(name)) return name;
      dropped += 1;
      return null;
    };
    const values: MapValues[] = [];
    for (const v of arr(t.values, 40)) {
      const o = v as Record<string, unknown>;
      const c = column(o.column);
      const vs = arr(o.values, 60).map((x) => (typeof x === 'number' ? String(x) : str(x, 120))).filter(Boolean);
      if (c && vs.length) values.push({ column: c, values: vs, ref: ref(o.ref) });
    }
    const json: MapJson[] = [];
    for (const v of arr(t.json, 20)) {
      const o = v as Record<string, unknown>;
      const c = column(o.column);
      const shape = str(o.shape, 1200);
      if (c && shape) json.push({ column: c, shape, ref: ref(o.ref) });
    }
    const rules: MapRule[] = arr(t.rules, 20)
      .map((v) => v as Record<string, unknown>)
      .map((o) => ({ text: str(o.text), ref: ref(o.ref) }))
      .filter((r) => r.text);
    tables[key] = { purpose: str(t.purpose, 300), repo, module: str(t.module, 200) || undefined, values, json, rules };
  }
  const links: MapLink[] = [];
  const col = (v: unknown): string | null => {
    const s = str(v, 260).toLowerCase();
    const i = s.lastIndexOf('.');
    if (i < 0) return null;
    const cols = k.tables.get(s.slice(0, i));
    return cols?.has(s.slice(i + 1)) ? s : null;
  };
  for (const raw of arr(parsed.links, 2000)) {
    const o = raw as Record<string, unknown>;
    const from = col(o.from);
    const to = col(o.to);
    if (!from || !to || from === to) {
      dropped += 1;
      continue;
    }
    links.push({ from, to, why: str(o.why, 300), ref: ref(o.ref) });
  }
  return { tables, links, dropped };
}

/// A pass's findings laid over the map: a table it described replaces what
/// that repo said before, rules learned by seeds are kept, and links are
/// unique by their two ends.
export function mergeInto(map: DbMap, part: { tables: Record<string, MapTable>; links: MapLink[] }): DbMap {
  const tables = { ...map.tables };
  for (const [key, t] of Object.entries(part.tables)) {
    const learned = tables[key]?.rules.filter((r) => r.learnedAt) ?? [];
    tables[key] = { ...t, rules: [...t.rules, ...learned.filter((l) => !t.rules.some((r) => r.text === l.text))] };
  }
  const links = new Map(map.links.map((l) => [`${l.from}>${l.to}`, l]));
  for (const l of part.links) links.set(`${l.from}>${l.to}`, l);
  return { ...map, tables, links: [...links.values()], updatedAt: new Date().toISOString() };
}

export function emptyMap(owner: DbMap['owner']): DbMap {
  const now = new Date().toISOString();
  return { version: MAP_VERSION, owner, builtAt: now, updatedAt: now, repos: [], schemas: {}, tables: {}, links: [] };
}

export function parseMap(raw: string): DbMap | null {
  try {
    const m = JSON.parse(raw) as DbMap;
    return m && m.version === MAP_VERSION && typeof m.tables === 'object' && Array.isArray(m.links) ? m : null;
  } catch {
    return null;
  }
}

// ---- how current it is ---------------------------------------------------

export interface MapFreshness {
  /// Repos whose code moved since they were mapped, with how far.
  repos: Array<{ path: string; behind: number | null; mapped: boolean }>;
  /// Schemas whose tables or columns changed since, or that were never mapped.
  schemas: string[];
  fresh: boolean;
}

export function freshness(
  map: DbMap,
  now: { repos: Array<{ path: string; head: string | null; behind: number | null }>; schemas: Record<string, string> },
): MapFreshness {
  const repos = now.repos.map((r) => {
    const was = map.repos.find((m) => m.path === r.path);
    if (!was) return { path: r.path, behind: null, mapped: false };
    return { path: r.path, behind: was.head && r.head && was.head !== r.head ? r.behind : was.head === r.head ? 0 : null, mapped: true };
  });
  const schemas = Object.entries(now.schemas)
    .filter(([s, fp]) => map.schemas[s] !== fp)
    .map(([s]) => s);
  const fresh = repos.every((r) => r.mapped && r.behind === 0) && schemas.length === 0;
  return { repos, schemas, fresh };
}

// ---- using it --------------------------------------------------------------

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

/// The tables a piece of text is about, best first: named outright, or
/// sharing distinctive words with the table's name or purpose.
export function tablesFor(map: DbMap, text: string, limit = 25): string[] {
  const said = new Set(words(text));
  const stem = (w: string) => w.slice(0, Math.max(4, w.length - 3));
  const saidStems = [...said].map(stem);
  const hit = (w: string) => said.has(w) || (w.length >= 5 && saidStems.some((s) => s.length >= 4 && w.startsWith(s)));
  const lower = text.toLowerCase();
  return Object.entries(map.tables)
    .map(([key, t]) => {
      const table = key.slice(key.indexOf('.') + 1);
      const named = lower.includes(table) ? 6 : 0;
      const nameHits = words(table).filter(hit).length * 2;
      const purposeHits = Math.min(3, words(t.purpose).filter(hit).length);
      return { key, score: named + nameHits + purposeHits };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((x) => x.key);
}

/// Which schemas a ticket is about, by where its tables live.
export function schemasFor(map: DbMap, text: string): string[] {
  const out: string[] = [];
  for (const key of tablesFor(map, text, 12)) {
    const s = key.slice(0, key.indexOf('.'));
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/// The part of the map a seed needs, as prompt text: the tables the ticket
/// is about, the tables linked to them, and what is known of each.
export function mapSlice(map: DbMap, text: string, schemas: readonly string[], limit = 40): { text: string; tables: string[] } {
  const inScope = new Set(schemas.map((s) => s.toLowerCase()));
  const core = tablesFor(map, text, 20).filter((k) => inScope.size === 0 || inScope.has(k.slice(0, k.indexOf('.'))));
  const picked = new Set(core);
  const tableOf = (c: string) => c.slice(0, c.lastIndexOf('.'));
  for (const l of map.links) {
    if (picked.size >= limit) break;
    const a = tableOf(l.from);
    const b = tableOf(l.to);
    if (picked.has(a) && map.tables[b]) picked.add(b);
    else if (picked.has(b) && map.tables[a]) picked.add(a);
  }
  const keys = [...picked].slice(0, limit);
  if (keys.length === 0) return { text: '', tables: [] };
  const at = (r?: string) => (r ? ` (${r})` : '');
  const blocks = keys.map((k) => {
    const t = map.tables[k];
    const lines = [`${k} — ${t.purpose || 'no description'}${t.repo ? ` [${t.repo.split('/').pop()}${t.module ? `: ${t.module}` : ''}]` : ''}`];
    for (const v of t.values) lines.push(`  ${v.column} ∈ {${v.values.join(', ')}}${at(v.ref)}`);
    for (const j of t.json) lines.push(`  ${j.column} JSON: ${j.shape}${at(j.ref)}`);
    for (const r of t.rules) lines.push(`  rule: ${r.text}${at(r.ref)}`);
    return lines.join('\n');
  });
  const set = new Set(keys);
  const links = map.links
    .filter((l) => set.has(tableOf(l.from)) || set.has(tableOf(l.to)))
    .slice(0, 60)
    .map((l) => `${l.from} → ${l.to}: ${l.why}${at(l.ref)}`);
  const body = [
    `What overdb's map of this database records about the tables this need touches.`,
    `It was made earlier by reading the application code; refs are path:line in the repo that owns each table.`,
    ``,
    ...blocks,
    ...(links.length ? ['', 'Links the code makes (not all are foreign keys):', ...links] : []),
  ].join('\n');
  return { text: body, tables: keys };
}

/// Findings a seed made by reading the code, kept as rules on the tables
/// they name, so the next seed knows them without reading.
export function learnFrom(
  map: DbMap,
  findings: ReadonlyArray<{ source: string; text: string; ref?: string }>,
): { map: DbMap; added: number } {
  const keys = Object.keys(map.tables);
  const tables = { ...map.tables };
  let added = 0;
  const now = new Date().toISOString();
  for (const f of findings) {
    if (f.source !== 'code') continue;
    const lower = f.text.toLowerCase();
    const hits = keys.filter((k) => lower.includes(k) || new RegExp(`\\b${k.slice(k.indexOf('.') + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
    for (const k of hits.slice(0, 3)) {
      const t = tables[k];
      if (t.rules.some((r) => r.text === f.text)) continue;
      tables[k] = { ...t, rules: [...t.rules, { text: f.text, ref: f.ref, learnedAt: now }] };
      added += 1;
    }
  }
  return { map: added ? { ...map, tables, updatedAt: now } : map, added };
}
