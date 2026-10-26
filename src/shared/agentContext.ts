// What an agent is told about a database before it writes SQL against it:
// the tenancy rule, the person's own notes, and overdb's map of the code.
//
// Worked out, then adjustable. For each part, the first of these that says
// anything wins:
//
//   tenant   the person's setting  →  their base recipe. Nothing else
//            reaches an agent: most databases have no tenants, and one
//            whose users table every other table points at would otherwise
//            be announced as multi-tenant. A tenant detected from the
//            catalog is only a SUGGESTION, shown to the person to confirm.
//            Its caveats — tables every tenant shares, tenants to leave
//            out, levels inside a tenant, more columns that mean it — are
//            the person's alone, and ride on whichever tenant wins.
//   notes    the person's setting, or none
//   map      the database map when there is one, unless turned off
//
// The setting lives where repo links do: on the env set when the connection
// is in one (tenancy does not change between local and prod), else on the
// connection.
//
// None of this enforces anything. An agent told to scope by `client_id`
// usually will, and nothing stops one that does not; keeping tenants apart
// is the database's job — a view, row-level security, a narrower login.

import type { SchemaSnapshot } from './types';
import { findLinks, loginTables, tableKey, tenancyLevels, tenantCandidates, type Link, type TableRef } from './baseline';
import { mapSlice, schemaFingerprint, type DbMap } from './dbMap';

export type TenantRef = TableRef & { column: string };

/// A level inside a tenant — `partner` within `client` — and the columns
/// rows point at it through.
export type TenancyLevelRef = TenantRef & { via: string[] };

/// What the plain rule gets wrong about a particular database.
export interface TenancyCaveats {
  /// Tables every tenant shares, as `schema.table`: lookups, config. They
  /// have no tenant to filter on.
  shared?: string[];
  /// Tenants to leave out unless asked for, by the value queries filter on:
  /// test and internal accounts.
  excluded?: string[];
  levels?: TenancyLevelRef[];
  /// More columns that mean the tenant, where the catalog did not say.
  alsoFilterOn?: string[];
}

export interface AgentContextSetting {
  /// Unset: worked out. 'none': this database has no tenants.
  tenant?: TenantRef | 'none';
  caveats?: TenancyCaveats;
  notes?: string;
  /// false leaves the map out. Unset: included when there is one.
  map?: boolean;
}

export type TenantSource = 'set' | 'recipe';

export interface AgentContext {
  /// `via`: the columns other tables point at the tenant through, most used
  /// first (`client_id`) — what a query actually filters on. The tenant's
  /// own `column` is its key (`id`), which filters nothing but itself.
  /// Empty when the catalog has not been read.
  tenant: (TenantRef & { source: TenantSource; via: string[]; caveats: Required<TenancyCaveats> }) | null;
  /// Detected from the catalog while nothing is known: for the person to
  /// confirm or dismiss. Never told to an agent.
  suggestion: (TenantRef & { via: string[] }) | null;
  /// Someone said there are no tenants — the setting, or a base recipe made
  /// without one — as against nothing being found.
  noTenant: { source: 'set' | 'recipe' } | null;
  notes: string | null;
  map: {
    available: boolean;
    included: boolean;
    builtAt?: string;
    /// Schemas whose tables or columns changed since the map was made.
    changed: string[];
  };
}

/// A hub this widely referenced, and clearly ahead of the next, is worth
/// mentioning. Anything less and a single-tenant app's `users` table would
/// be announced as the tenant.
export const DETECT_MIN_SHARE = 0.25;
export const DETECT_MIN_TABLES = 3;

const NO_CAVEATS: Required<TenancyCaveats> = { shared: [], excluded: [], levels: [], alsoFilterOn: [] };

const word = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const words = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x) => word(x)).map((x) => (x as string).trim()))].slice(0, cap) : [];

/// Caveats as they may be kept: from the app's IPC, a saved store or a
/// published file alike. What doesn't check out is dropped, not refused.
export function cleanCaveats(raw: unknown): TenancyCaveats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const levels = (Array.isArray(r.levels) ? r.levels : [])
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .filter((l) => word(l.schema) && word(l.table) && word(l.column))
    .slice(0, 5)
    .map((l) => ({ schema: (l.schema as string).trim(), table: (l.table as string).trim(), column: (l.column as string).trim(), via: words(l.via, 5) }));
  const out: TenancyCaveats = {
    ...(words(r.shared, 500).length ? { shared: words(r.shared, 500) } : {}),
    ...(words(r.excluded, 50).length ? { excluded: words(r.excluded, 50) } : {}),
    ...(levels.length ? { levels } : {}),
    ...(words(r.alsoFilterOn, 5).length ? { alsoFilterOn: words(r.alsoFilterOn, 5) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/// For the person setting caveats on `tenant`: the levels inside it, and
/// tables that look shared — referenced by others, but neither pointing at
/// the tenant (or a level) nor carrying a column that means it.
export function caveatHints(
  snapshot: SchemaSnapshot,
  links: Link[],
  tenant: TenantRef,
  limit = 8,
): { levels: TenancyLevelRef[]; shared: string[] } {
  const levels = tenancyLevels(snapshot, links, tenant).map((l) => {
    const ref = { ...l.ref, column: l.column };
    return { ...ref, via: tenantVia(snapshot, ref) };
  });
  const chain = new Set([tableKey(tenant), ...levels.map((l) => tableKey(l))]);
  const scoped = new Set(links.filter((l) => !l.audit && chain.has(tableKey(l.to))).map((l) => tableKey(l.from)));
  const means = new Set([...tenantVia(snapshot, tenant), tenant.column].map((c) => c.toLowerCase()));
  const pointedAt = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.audit || tableKey(l.from) === tableKey(l.to)) continue;
    const to = tableKey(l.to);
    pointedAt.set(to, (pointedAt.get(to) ?? new Set()).add(tableKey(l.from)));
  }
  const shared: Array<[string, number]> = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table') continue;
      const k = tableKey({ schema: s.name, table: t.name });
      const n = pointedAt.get(k)?.size ?? 0;
      if (n < 2 || chain.has(k) || scoped.has(k)) continue;
      if (t.columns.some((c) => means.has(c.name.toLowerCase()) && c.name.toLowerCase() !== 'id')) continue;
      shared.push([k, n]);
    }
  }
  shared.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { levels, shared: shared.slice(0, limit).map(([k]) => k) };
}

export function detectTenant(snapshot: SchemaSnapshot): TenantRef | null {
  // People are not tenants: a users table every row is stamped with is the
  // commonest hub in a single-tenant app.
  const logins = new Set(loginTables(snapshot).map((t) => tableKey(t)));
  const [top, next] = tenantCandidates(snapshot, findLinks(snapshot), 6).filter((c) => !logins.has(tableKey(c.ref)));
  if (!top || top.share < DETECT_MIN_SHARE || top.tables < DETECT_MIN_TABLES) return null;
  if (next && next.tables * 2 > top.tables) return null;
  return { ...top.ref, column: top.column };
}

/// The columns other tables reference the tenant by, most used first.
export function tenantVia(snapshot: SchemaSnapshot, tenant: TenantRef, limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const l of findLinks(snapshot)) {
    if (l.audit || l.when || l.columns.length !== 1) continue;
    if (tableKey(l.to) !== tableKey(tenant) || l.refColumns[0] !== tenant.column) continue;
    counts.set(l.columns[0], (counts.get(l.columns[0]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([c]) => c);
}

/// Schemas the map describes whose live shape no longer matches it.
export function changedSince(map: DbMap, snapshot: SchemaSnapshot): string[] {
  return snapshot.schemas.filter((s) => map.schemas[s.name] !== undefined && map.schemas[s.name] !== schemaFingerprint(s)).map((s) => s.name);
}

export function resolveAgentContext(input: {
  setting?: AgentContextSetting;
  /// undefined: no recipe. null: a recipe made with no tenant.
  recipeTenant?: TenantRef | null;
  detected?: TenantRef | null;
  map?: DbMap | null;
  changed?: string[];
  /// From the catalog, when there is one: see `tenantVia`.
  via?: (tenant: TenantRef) => string[];
}): AgentContext {
  const { setting, recipeTenant, detected, map } = input;
  let tenant: AgentContext['tenant'] = null;
  let noTenant: AgentContext['noTenant'] = null;
  const via = (t: TenantRef) => input.via?.(t) ?? [];
  const c = setting?.caveats;
  const caveats: Required<TenancyCaveats> = {
    shared: c?.shared ?? [],
    excluded: c?.excluded ?? [],
    // A level saved without its columns gets them from the catalog when
    // there is one.
    levels: (c?.levels ?? []).map((l) => ({ ...l, via: l.via.length ? l.via : via(l) })),
    alsoFilterOn: c?.alsoFilterOn ?? [],
  };
  if (setting?.tenant === 'none') noTenant = { source: 'set' };
  else if (setting?.tenant) tenant = { ...setting.tenant, source: 'set', via: via(setting.tenant), caveats };
  else if (recipeTenant === null) noTenant = { source: 'recipe' };
  else if (recipeTenant) tenant = { ...recipeTenant, source: 'recipe', via: via(recipeTenant), caveats };
  return {
    tenant,
    noTenant,
    suggestion: !tenant && !noTenant && detected ? { ...detected, via: via(detected) } : null,
    notes: setting?.notes?.trim() || null,
    map: {
      available: Boolean(map),
      included: Boolean(map) && setting?.map !== false,
      ...(map ? { builtAt: map.builtAt } : {}),
      changed: input.changed ?? [],
    },
  };
}

const qualified = (t: TenantRef) => `${t.schema}.${t.table}`;

/// `brief` cuts long lists, for the server's instructions; describe_database
/// gives them whole.
function listed(items: string[], brief: boolean): string {
  const cap = brief ? 15 : items.length;
  const shown = items.slice(0, cap).join(', ');
  return items.length > cap ? `${shown} and ${items.length - cap} more (describe_database lists them)` : shown;
}

/// The tenancy rule, then its caveats; null when there is nothing to say.
export function tenancySentence(name: string, ctx: AgentContext, opts: { brief?: boolean } = {}): string | null {
  if (ctx.noTenant) return `${name} is not multi-tenant.`;
  const t = ctx.tenant;
  if (!t) return null;
  const brief = Boolean(opts.brief);
  const key = `${qualified(t)}.${t.column}`;
  const { shared, excluded, levels, alsoFilterOn } = t.caveats ?? NO_CAVEATS;
  const columns = [...new Set([...t.via, ...alsoFilterOn])];
  const filter = columns.length ? `filter on ${columns.join(' or ')}` : `filter on the column that points at ${key}`;
  const out = [
    `${name} is multi-tenant: ${shared.length ? 'most rows belong' : 'every row belongs'} to one tenant in ${qualified(t)}${columns.length ? `, through ${columns.join(' / ')}` : ` (${key})`}. Scope every query to one tenant — ${filter}, or join through a table that has it — unless the question is explicitly about all tenants.`,
  ];
  if (shared.length) out.push(`Shared by every tenant, so not filtered by one: ${listed(shared, brief)}.`);
  for (const l of levels) {
    out.push(
      `Within a tenant, rows also belong to a ${l.table} (${qualified(l)}${l.via.length ? `, through ${l.via.join(' / ')}` : ''}): a question about one ${l.table} filters on that as well.`,
    );
  }
  if (excluded.length) {
    out.push(`Leave out ${columns[0] ?? key} ${listed(excluded, brief)} — test or internal tenants — unless the question asks for them.`);
  }
  return out.join(' ');
}

/// Where each part came from, for the person reading the setting.
export function tenantOrigin(ctx: AgentContext): string {
  if (ctx.noTenant) return ctx.noTenant.source === 'set' ? 'you said so' : 'from your base recipe';
  if (!ctx.tenant) return 'not set';
  return { set: 'you set it', recipe: 'from your base recipe' }[ctx.tenant.source];
}

const NOTES_IN_INSTRUCTIONS = 600;

/// The MCP server's instructions: read once by the client when it
/// connects, so short — the tenancy rule for each connection and a pointer
/// to describe_database for the rest.
export function serverInstructions(list: Array<{ name: string; ctx: AgentContext }>): string {
  const lines = [
    'overdb gives read-only access to the databases below. Before writing SQL for one, call describe_database with your question:',
    'it returns what the application code says about the relevant tables (what each is for, the values status columns take,',
    "links the schema doesn't declare) and the rules to follow. Prefer it over guessing from column names.",
  ];
  for (const { name, ctx } of list) {
    const parts = [tenancySentence(name, ctx, { brief: true }), ctx.notes ? `Notes on ${name}: ${ctx.notes.slice(0, NOTES_IN_INSTRUCTIONS)}` : null].filter(Boolean);
    if (parts.length) lines.push('', ...parts as string[]);
  }
  return lines.join('\n');
}

const OVERVIEW_TABLES = 60;

/// describe_database's answer: the rules, then what the map says — about
/// the question's tables when there is a question, else an overview.
export function describeText(name: string, ctx: AgentContext, map: DbMap | null, question?: string): string {
  const out: string[] = [];
  const rule = tenancySentence(name, ctx);
  if (rule) out.push(rule);
  if (ctx.notes) out.push(`Notes from the people who run ${name}:\n${ctx.notes}`);

  if (!ctx.map.included || !map) {
    out.push(
      ctx.map.available
        ? `The map of ${name} is turned off for agents. list_tables and describe_table show the catalog.`
        : `overdb has no map of ${name}'s code yet. list_tables and describe_table show the catalog.`,
    );
    return out.join('\n\n');
  }

  if (ctx.map.changed.length) {
    out.push(
      `The map was made ${map.builtAt.slice(0, 10)}; since then ${ctx.map.changed.join(', ')} changed. Where the map and describe_table disagree, the catalog is right.`,
    );
  }
  if (question?.trim()) {
    const slice = mapSlice(map, question, []);
    out.push(slice.text || `The map has nothing on tables matching that question. Try other words, or list_tables.`);
  } else {
    const keys = Object.keys(map.tables).sort();
    const shown = keys.slice(0, OVERVIEW_TABLES).map((k) => `${k} — ${map.tables[k].purpose || 'no description'}`);
    out.push(
      [
        `What overdb's map (read from the application code) says each table is for. Ask describe_database with a question for detail.`,
        ...shown,
        ...(keys.length > shown.length ? [`… and ${keys.length - shown.length} more.`] : []),
      ].join('\n'),
    );
  }
  return out.join('\n\n');
}
