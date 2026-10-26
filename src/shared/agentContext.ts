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
import { findLinks, loginTables, tableKey, tenantCandidates, type TableRef } from './baseline';
import { mapSlice, schemaFingerprint, type DbMap } from './dbMap';

export type TenantRef = TableRef & { column: string };

export interface AgentContextSetting {
  /// Unset: worked out. 'none': this database has no tenants.
  tenant?: TenantRef | 'none';
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
  tenant: (TenantRef & { source: TenantSource; via: string[] }) | null;
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
  if (setting?.tenant === 'none') noTenant = { source: 'set' };
  else if (setting?.tenant) tenant = { ...setting.tenant, source: 'set', via: via(setting.tenant) };
  else if (recipeTenant === null) noTenant = { source: 'recipe' };
  else if (recipeTenant) tenant = { ...recipeTenant, source: 'recipe', via: via(recipeTenant) };
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

/// The tenancy rule in a sentence, or null when there is nothing to say.
export function tenancySentence(name: string, ctx: AgentContext): string | null {
  if (ctx.noTenant) return `${name} is not multi-tenant.`;
  const t = ctx.tenant;
  if (!t) return null;
  const key = `${qualified(t)}.${t.column}`;
  const filter = t.via.length
    ? `filter on ${t.via.join(' or ')}`
    : `filter on the column that points at ${key}`;
  return `${name} is multi-tenant: every row belongs to one tenant in ${qualified(t)}${t.via.length ? `, through ${t.via.join(' / ')}` : ` (${key})`}. Scope every query to one tenant — ${filter}, or join through a table that has it — unless the question is explicitly about all tenants.`;
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
    const parts = [tenancySentence(name, ctx), ctx.notes ? `Notes on ${name}: ${ctx.notes.slice(0, NOTES_IN_INSTRUCTIONS)}` : null].filter(Boolean);
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
