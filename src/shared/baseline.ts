// Discovery for a baseline: from a catalog and its table statistics to a
// recipe a person can review — which table is the tenant, how tables link,
// and what each table contributes to a small copy that is still enough to
// log in and use the app. See docs/design/baselines.md.
//
// Pure and database-free. Nothing in here is configured for one product:
// the tenant, the links and every table's action are read off the shape of
// the schema and its names, and offered for confirmation. Main reads the
// catalog and runs the bounded searches; the window draws the result.

import type { Engine } from './engines';
import type { ColumnInfo, SchemaSnapshot, TableInfo } from './types';
import { canonicalType } from './typeEquiv';
import { quoteIdent } from './orderBy';

export interface TableRef {
  schema: string;
  table: string;
}

/// `schema.table`, the key every map in a recipe uses.
export function tableKey(ref: TableRef): string {
  return `${ref.schema}.${ref.table}`;
}

export function parseTableKey(key: string): TableRef {
  const dot = key.indexOf('.');
  return dot < 0 ? { schema: '', table: key } : { schema: key.slice(0, dot), table: key.slice(dot + 1) };
}

/// The server's own idea of a table's size, read from its statistics: one
/// catalog query per server, never a scan. Null where it keeps none.
export interface TableStat {
  schema: string;
  table: string;
  rows: number | null;
  bytes: number | null;
}

// ---------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------

/// A foreign key the server holds, one proposed from a column's name, or
/// one the database map read from the code (see src/shared/mapLinks.ts).
/// Name and code links choose rows; they are never drawn as foreign keys.
export type LinkSource = 'fk' | 'name' | 'poly' | 'code';

export interface Link {
  from: TableRef;
  columns: string[];
  to: TableRef;
  refColumns: string[];
  source: LinkSource;
  /// Written by whoever last touched the row (`created_by_user_id`), not
  /// who owns it. Scoping through one would empty a lookup table of every
  /// row someone else edited, so these never decide what is kept.
  audit: boolean;
  /// Other tables the same column name could mean, for a name link whose
  /// target was a guess between several.
  alternatives: TableRef[];
  /// A polymorphic link holds only for rows whose type column names the
  /// target: `commentable_id → posts` when `commentable_type = 'Post'`.
  when?: { column: string; value: string };
  /// Where the code makes this link, when the database map says so: a name
  /// guess it confirmed or corrected, or a link only the code knew.
  cited?: { why: string; ref?: string };
}

/// `schema.table(col) → schema.table(col)`, stable across runs: the key a
/// recipe uses to remember a link was turned off.
export function linkKey(link: Pick<Link, 'from' | 'columns' | 'to' | 'refColumns' | 'when'>): string {
  const when = link.when ? `[${link.when.column}=${link.when.value}]` : '';
  return `${tableKey(link.from)}(${link.columns.join(',')})${when}→${tableKey(link.to)}(${link.refColumns.join(',')})`;
}

/// `createdByUserId` and `created_by_user_id` both become
/// ['created', 'by', 'user', 'id'].
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type TypeFamily = 'int' | 'text' | 'uuid' | 'other';

function typeFamily(typeName: string): TypeFamily {
  const t = canonicalType(typeName);
  if (/^(smallint|int|bigint|tinyint|serial|bigserial|integer)\b/.test(t)) return 'int';
  if (/^uuid\b/.test(t)) return 'uuid';
  if (/^(varchar|char|text|character|nvarchar|nchar|citext|binary\(16\)|varbinary)/.test(t)) return 'text';
  return 'other';
}

function compatible(a: ColumnInfo | undefined, b: ColumnInfo | undefined): boolean {
  if (!a || !b) return true;
  const fa = typeFamily(a.typeName);
  const fb = typeFamily(b.typeName);
  return fa === 'other' || fb === 'other' || fa === fb;
}

/// Plural spellings a table holding `name`s might go by.
const IRREGULAR: Record<string, string> = { person: 'people', child: 'children', man: 'men', woman: 'women', datum: 'data', index: 'indices' };

function spellings(name: string): string[] {
  const out = [name, `${name}s`, `${name}es`];
  if (name.endsWith('y')) out.push(`${name.slice(0, -1)}ies`);
  const last = name.split('_').pop() ?? name;
  if (IRREGULAR[last]) out.push(`${name.slice(0, name.length - last.length)}${IRREGULAR[last]}`);
  return out;
}

/// Words that mark a column as pointing at another row, at either end of
/// its name: `client_id`, `tenant_uuid`, `client_ref`, `client_fk`,
/// `fk_client`, `id_client`. What is left is the table's name.
const KEY_SUFFIX = new Set(['id', 'uuid', 'guid', 'ref', 'fk']);
const KEY_PREFIX = new Set(['fk', 'id']);

/// The name a reference column leaves once its key marker is gone, or null
/// for a column that does not look like a reference.
export function referenceBase(column: string): string[] | null {
  const tokens = nameTokens(column);
  if (tokens.length < 2) return null;
  if (KEY_SUFFIX.has(tokens[tokens.length - 1])) return tokens.slice(0, -1);
  if (KEY_PREFIX.has(tokens[0])) return tokens.slice(1);
  return null;
}

const AUDIT_TOKENS = new Set(['by', 'last', 'modifier', 'editor', 'updater', 'creator']);

interface Keyed {
  ref: TableRef;
  table: TableInfo;
  pk: string;
}

/// Every link in the catalog: the foreign keys the server holds, plus one
/// proposed for each `…_id` column that names a table with a single-column
/// key of a compatible type. Same schema first; a name several schemas
/// could mean picks the first and lists the rest.
export function findLinks(snapshot: SchemaSnapshot): Link[] {
  const keyed: Keyed[] = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      // A backup is never what a column means, even with the key it copied.
      if (t.kind !== 'table' || t.primaryKey.length !== 1 || looksLikeBackup(t.name)) continue;
      keyed.push({ ref: { schema: s.name, table: t.name }, table: t, pk: t.primaryKey[0] });
    }
  }
  const byName = new Map<string, Keyed[]>();
  const byPk = new Map<string, Keyed[]>();
  for (const k of keyed) {
    const n = k.ref.table.toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), k]);
    // `client.client_id` is findable by its key's own name. A bare `id` is
    // every table's key and says nothing.
    const p = k.pk.toLowerCase();
    if (p !== 'id') byPk.set(p, [...(byPk.get(p) ?? []), k]);
  }

  const out: Link[] = [];
  const seen = new Set<string>();
  const push = (l: Link) => {
    const key = linkKey(l);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };

  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table') continue;
      const from = { schema: s.name, table: t.name };
      // Only a single-column key settles what a column means. A composite
      // one — (tenant_id, project_id) → projects — leaves tenant_id free to
      // be read as the tenant's key, which is what it is.
      const covered = new Set<string>();
      for (const fk of t.foreignKeys) {
        if (fk.columns.length === 1) covered.add(fk.columns[0].toLowerCase());
        push({
          from,
          columns: fk.columns,
          to: { schema: fk.refSchema ?? s.name, table: fk.refTable },
          refColumns: fk.refColumns,
          source: 'fk',
          audit: fk.columns.length === 1 && isAudit(fk.columns[0]),
          alternatives: [],
        });
      }

      const own = nameTokens(t.name).join('_');
      for (const col of t.columns) {
        const base = referenceBase(col.name);
        if (!base || base.length === 0) continue;
        if (covered.has(col.name.toLowerCase())) continue;
        // `portal_user.portal_user_id` names its own table, not `user`. A
        // key named for another table — `partner_defaults.partner_id` — is
        // a one-to-one extension of it, and does link.
        if (base.join('_') === own) continue;
        // Nor is a table's own single key named for the end of its name:
        // `content_form.form_id`, `deal_comment.comment_id`.
        if (t.primaryKey.length === 1 && t.primaryKey[0] === col.name && own.endsWith(`_${base.join('_')}`)) continue;
        const target = guessTarget(col, nameTokens(col.name), base, from, byName, byPk);
        if (!target) continue;
        push({
          from,
          columns: [col.name],
          to: target.pick.ref,
          refColumns: [target.pick.pk],
          source: 'name',
          audit: isAudit(col.name),
          alternatives: target.rest.map((k) => k.ref),
        });
      }
    }
  }
  return out;
}

export function isAudit(column: string): boolean {
  return nameTokens(column).some((t) => AUDIT_TOKENS.has(t));
}

function guessTarget(
  col: ColumnInfo,
  tokens: string[],
  base: string[],
  from: TableRef,
  byName: Map<string, Keyed[]>,
  byPk: Map<string, Keyed[]>,
): { pick: Keyed; rest: Keyed[] } | null {
  const fits = (k: Keyed) =>
    !(k.ref.schema === from.schema && k.ref.table === from.table) &&
    compatible(col, k.table.columns.find((c) => c.name === k.pk));

  // A column named exactly like some table's key — `client_id` and
  // `client.client_id` — is the strongest reading there is.
  let found = (byPk.get(tokens.join('_')) ?? []).filter(fits);

  // Otherwise the longest tail of the name that is a table:
  // `created_by_user_id` → `by_user`, then `user`.
  for (let i = 0; found.length === 0 && i < base.length; i++) {
    const tail = base.slice(i).join('_');
    for (const name of spellings(tail)) {
      found = [...found, ...(byName.get(name) ?? []).filter(fits)];
    }
  }
  if (found.length === 0) return null;

  // `client_id` is the key of `client`, `oauth_client` and `z123_client`
  // alike. The table named for the column is the reading; one merely ending
  // in it is a guess.
  const named = new Set(spellings(base.join('_')));
  const rank = (k: Keyed) => {
    const n = k.ref.table.toLowerCase();
    return named.has(n) ? 0 : [...named].some((s) => n.endsWith(`_${s}`)) ? 1 : 2;
  };
  found = [...new Map(found.map((k) => [tableKey(k.ref), k])).values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.ref.schema === from.schema) - Number(a.ref.schema === from.schema) ||
      a.ref.table.length - b.ref.table.length ||
      (tableKey(a.ref) < tableKey(b.ref) ? -1 : 1),
  );
  const pick = found[0];
  // A rival reads as well as the pick: just as well named, and from the
  // same schema when the pick is — the column's own schema settles it.
  const local = pick.ref.schema === from.schema;
  const rivals = found
    .slice(1)
    .filter((k) => rank(k) === rank(pick) && (!local || k.ref.schema === from.schema));
  // Nothing named for the column and several tables sharing its key —
  // `event_log`, `event_lead` and `event_metadata` all keyed by `event_id`
  // — are siblings of a table that is not there. No guess beats none.
  if (rank(pick) === 2 && rivals.length > 0) return null;
  return { pick, rest: rivals };
}

// ---------------------------------------------------------------------
// The tenant
// ---------------------------------------------------------------------

export interface TenantCandidate {
  ref: TableRef;
  column: string;
  /// How many other tables point at it, by key or by name.
  tables: number;
  /// Those tables as a share of every table in the catalog.
  share: number;
}

/// Tables ranked by how many others point at them. The tenant is usually
/// the top one by a distance; offered, never assumed — a single-tenant
/// system has none, and its top table is just `users`.
export function tenantCandidates(snapshot: SchemaSnapshot, links: Link[], limit = 5): TenantCandidate[] {
  const total = snapshot.schemas.reduce((n, s) => n + s.tables.filter((t) => t.kind === 'table').length, 0);
  const pointing = new Map<string, { ref: TableRef; column: string; from: Set<string> }>();
  for (const l of links) {
    if (l.audit || l.when || l.refColumns.length !== 1) continue;
    const to = tableKey(l.to);
    if (to === tableKey(l.from)) continue;
    const entry = pointing.get(to) ?? { ref: l.to, column: l.refColumns[0], from: new Set<string>() };
    entry.from.add(tableKey(l.from));
    pointing.set(to, entry);
  }
  return [...pointing.values()]
    .map((e) => ({ ref: e.ref, column: e.column, tables: e.from.size, share: total ? e.from.size / total : 0 }))
    .sort((a, b) => b.tables - a.tables || tableKey(a.ref).localeCompare(tableKey(b.ref)))
    .slice(0, limit);
}

/// The tenant and its namesakes: a table with the same name and the same
/// key in another schema is the same tenant, kept by each service that
/// needs it (`app.account` and `billing.account`). Only an exact namesake —
/// `oauth_client` shares a key name with `client` and means something else.
export function tenantTables(snapshot: SchemaSnapshot, tenant: TableRef & { column: string }): TableRef[] {
  const out: TableRef[] = [{ schema: tenant.schema, table: tenant.table }];
  for (const s of snapshot.schemas) {
    if (s.name === tenant.schema) continue;
    const t = s.tables.find((x) => x.kind === 'table' && x.name.toLowerCase() === tenant.table.toLowerCase());
    if (t && t.primaryKey.length === 1 && t.primaryKey[0].toLowerCase() === tenant.column.toLowerCase()) {
      out.push({ schema: s.name, table: t.name });
    }
  }
  return out;
}

/// A level of tenancy below the tenant: a table most others point at that
/// itself belongs to the tenant — `partner` within `client`, `workspace`
/// within `organization`.
export interface TenancyLevel {
  ref: TableRef;
  column: string;
  tables: number;
  share: number;
  /// The level it sits in: the tenant, or the level above.
  parent: TableRef;
  /// Its column pointing at the parent, for searching within a parent.
  parentColumn: string;
}

/// Below this share, a table pointing at the tenant is just a table.
export const LEVEL_MIN_SHARE = 0.05;

/// Levels below the tenant, found the way the tenant was: widely referenced
/// tables that point at the tenant, or at a level found already. Login
/// tables are people, not tenancy, and are left out.
export function tenancyLevels(
  snapshot: SchemaSnapshot,
  links: Link[],
  tenant: TableRef & { column: string },
): TenancyLevel[] {
  const logins = new Set(loginTables(snapshot).map(tableKey));
  const above = new Map(tenantTables(snapshot, tenant).map((r) => [tableKey(r), r]));
  const candidates = tenantCandidates(snapshot, links, 25).filter(
    (c) => c.share >= LEVEL_MIN_SHARE && !above.has(tableKey(c.ref)) && !logins.has(tableKey(c.ref)) && !looksLikeBackup(c.ref.table),
  );
  const out: TenancyLevel[] = [];
  for (let found = true; found; ) {
    found = false;
    for (const c of candidates) {
      if (out.some((l) => tableKey(l.ref) === tableKey(c.ref))) continue;
      const up = links.find(
        (l) => tableKey(l.from) === tableKey(c.ref) && !l.audit && l.columns.length === 1 && above.has(tableKey(l.to)),
      );
      if (!up) continue;
      out.push({ ref: c.ref, column: c.column, tables: c.tables, share: c.share, parent: up.to, parentColumn: up.columns[0] });
      above.set(tableKey(c.ref), c.ref);
      found = true;
    }
  }
  return out;
}

/// Below this share of tables pointing at it, the top candidate is more
/// likely the users table of a single-tenant system than a tenant.
export const TENANT_MIN_SHARE = 0.1;

// ---------------------------------------------------------------------
// Sorting the tables
// ---------------------------------------------------------------------

/// What a table contributes to the baseline.
///   schema — already empty; its DDL only.
///   skip   — named like a backup or scratch copy; left out altogether.
///   empty  — a log, audit trail, tracking table or queue; created empty.
///   scoped — only rows for the starting points.
///   whole  — small and linked to nothing scoped; copied as it is.
///   review — large and linked to nothing scoped; created empty, and says so.
export type TableAction = 'schema' | 'skip' | 'empty' | 'scoped' | 'whole' | 'review';

export interface TablePlan {
  ref: TableRef;
  action: TableAction;
  reason: string;
  rows: number | null;
  bytes: number | null;
  /// Rough rows and bytes the baseline will hold, for the size estimate.
  keepRows: number | null;
  keepBytes: number | null;
  /// For a scoped table, how it reaches a starting point: each step's
  /// column and the table it points at, ending at the starting point.
  /// Empty for a starting point itself.
  via: ChainStep[];
}

/// One hop towards a starting point: this table's `column` holds the
/// `refColumn` of a row in `schema.table`.
export interface ChainStep {
  column: string;
  schema: string;
  table: string;
  refColumn: string;
  /// Polymorphic: only rows whose type column says so.
  when?: { column: string; value: string };
}

/// Small enough to copy whole when nothing ties it to a starting point.
export const WHOLE_MAX_ROWS = 5_000;
export const WHOLE_MAX_BYTES = 4 * 1024 * 1024;

const SKIP_TOKENS = new Set(['bak', 'backup', 'backups', 'old', 'copy', 'tmp', 'temp', 'scratch', 'archive', 'archived', 'deprecated', 'unused']);
const LOG_TOKENS = new Set([
  'log', 'logs', 'audit', 'audits', 'history', 'histories', 'tracking', 'track', 'queue', 'queues', 'outbox',
  'journal', 'changelog', 'events',
]);

/// `orders_bak`, `field_definition_ojdupebak`, `content_temp3`,
/// `partner_backup_25753`, `orders_20220322`. Not `email_template`.
export function looksLikeBackup(table: string): boolean {
  const tokens = nameTokens(table);
  return tokens.some(
    (t, i) =>
      SKIP_TOKENS.has(t) ||
      /^(tmp|temp|bak|copy|old)\d+$/.test(t) ||
      (t.length > 3 && t.endsWith('bak')) ||
      (i > 0 && /^(19|20)\d{6}$/.test(t)),
  );
}

export function looksLikeLog(table: string): boolean {
  return nameTokens(table).some((t) => LOG_TOKENS.has(t));
}

export interface SortInput {
  snapshot: SchemaSnapshot;
  stats: TableStat[];
  links: Link[];
  /// Links a person turned off, by linkKey.
  linksOff?: ReadonlySet<string>;
  tenant: (TableRef & { column: string }) | null;
  /// The tables holding a starting point: the tenant's own table, a users
  /// table, a second users table found by an email search.
  starts: TableRef[];
  /// Starting points that narrow a tenancy level (see StartingPoint). Scope
  /// spreads from these first, so a table with both a client_id and a
  /// partner_id keeps only the chosen partners' rows.
  narrow?: Array<TableRef & { column: string }>;
  /// The share of a scoped table's rows the baseline keeps — the starting
  /// tenants over all tenants, roughly — for the estimate only.
  keepShare: number;
  /// What a person chose by hand, by tableKey. Kept over every rule.
  overrides?: Record<string, TableAction>;
}

/// One action per table, each with the reason it was chosen.
export function sortTables(input: SortInput): TablePlan[] {
  const stat = new Map(input.stats.map((s) => [tableKey(s), s]));
  const off = input.linksOff ?? new Set<string>();
  const usable = input.links.filter((l) => !l.audit && !off.has(linkKey(l)));

  // Pre-sorted by name: backups, logs and empty tables never pass scope on.
  const early = new Map<string, Pick<TablePlan, 'action' | 'reason'>>();
  const all: TableRef[] = [];
  for (const s of input.snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table') continue;
      const ref = { schema: s.name, table: t.name };
      all.push(ref);
      const st = stat.get(tableKey(ref));
      if (st?.rows === 0) early.set(tableKey(ref), { action: 'schema', reason: 'empty today' });
      else if (looksLikeBackup(t.name)) early.set(tableKey(ref), { action: 'skip', reason: 'looks like a backup or scratch copy' });
      else if (looksLikeLog(t.name)) early.set(tableKey(ref), { action: 'empty', reason: 'looks like a log, history or queue' });
    }
  }

  // Scope spreads from the starting points to every table that points at a
  // scoped one, through owner links only — a layer at a time, so each table
  // is reached by its shortest chain and the reason given is the plainest.
  const narrowRoots = (input.narrow ?? []).flatMap((n) => tenantTables(input.snapshot, n)).map(tableKey);
  const roots = [
    ...(input.tenant ? tenantTables(input.snapshot, input.tenant) : []),
    ...input.starts,
  ].map(tableKey).concat(narrowRoots);
  const scoped = new Map<string, { column: string; to: string; refColumn: string; when?: { column: string; value: string } } | null>();
  for (const r of roots) scoped.set(r, null);
  const spread = (from: string[]) => {
    for (let frontier = new Set(from); frontier.size > 0; ) {
      const next = new Set<string>();
      for (const l of usable) {
        const child = tableKey(l.from);
        const to = tableKey(l.to);
        if (scoped.has(child) || next.has(child) || !frontier.has(to) || early.has(child)) continue;
        if (l.columns.length !== 1) continue;
        scoped.set(child, { column: l.columns[0], to, refColumn: l.refColumns[0], ...(l.when ? { when: l.when } : {}) });
        next.add(child);
      }
      frontier = next;
    }
  };
  // The narrowest level first: what carries a partner_id belongs to the
  // chosen partners, whatever else it carries.
  spread(narrowRoots);
  spread(roots.filter((r) => !narrowRoots.includes(r)));
  const chain = (key: string): ChainStep[] => {
    const out: ChainStep[] = [];
    for (let step = scoped.get(key); step; step = scoped.get(step.to)) {
      out.push({ column: step.column, ...parseTableKey(step.to), refColumn: step.refColumn, ...(step.when ? { when: step.when } : {}) });
    }
    return out;
  };

  const overrides = input.overrides ?? {};
  return all.map((ref) => {
    const key = tableKey(ref);
    const st = stat.get(key);
    const rows = st?.rows ?? null;
    const bytes = st?.bytes ?? null;
    let action: TableAction;
    let reason: string;
    const pre = early.get(key);
    if (overrides[key]) {
      action = overrides[key];
      reason = 'chosen by you';
    } else if (pre) {
      ({ action, reason } = pre);
    } else if (scoped.has(key)) {
      action = 'scoped';
      const via = chain(key);
      reason = via.length === 0
        ? 'what you start from'
        : via.length === 1
          ? `has ${via[0].column}`
          : `through ${via.slice(0, -1).map((v) => v.table).join(' → ')}`;
    } else if ((rows ?? 0) <= WHOLE_MAX_ROWS || (bytes !== null && bytes <= WHOLE_MAX_BYTES)) {
      action = 'whole';
      reason = rows === null && bytes === null ? 'size unknown, not tied to what you start from' : 'small, not tied to what you start from';
    } else {
      action = 'review';
      reason = 'large, not tied to what you start from';
    }
    const share = action === 'whole' ? 1 : action === 'scoped' ? input.keepShare : 0;
    return {
      ref, action, reason, rows, bytes,
      keepRows: rows === null ? null : Math.ceil(rows * share),
      keepBytes: bytes === null ? null : Math.ceil(bytes * share),
      via: action === 'scoped' && !overrides[key] ? chain(key) : [],
    };
  });
}

export interface SortSummary {
  action: TableAction;
  tables: number;
  rows: number;
  bytes: number;
  keepBytes: number;
}

export function summarize(plans: TablePlan[]): { groups: SortSummary[]; bytes: number; keepBytes: number } {
  const order: TableAction[] = ['scoped', 'whole', 'empty', 'review', 'skip', 'schema'];
  const groups = order.map((action) => {
    const of = plans.filter((p) => p.action === action);
    return {
      action,
      tables: of.length,
      rows: of.reduce((n, p) => n + (p.rows ?? 0), 0),
      bytes: of.reduce((n, p) => n + (p.bytes ?? 0), 0),
      keepBytes: of.reduce((n, p) => n + (p.keepBytes ?? 0), 0),
    };
  });
  return {
    groups,
    bytes: groups.reduce((n, g) => n + g.bytes, 0),
    keepBytes: groups.reduce((n, g) => n + g.keepBytes, 0),
  };
}

// ---------------------------------------------------------------------
// Finding the starting points
// ---------------------------------------------------------------------

const NAMEISH = /(^|_)(name|title|label|slug|domain|code|handle|subdomain)$/i;
const EMAILISH = /^(email|email_address|e_?mail|mail|login_email)$/i;
const USERNAMEISH = /^(username|user_name|login)$/i;
const PASSWORDISH = /^(password|passwd|pwd|password_hash|hashed_password|encrypted_password|password_digest|pass_hash)$/i;
const PEOPLE = new Set(['user', 'users', 'member', 'members', 'person', 'people', 'account', 'accounts', 'login', 'logins', 'customer', 'customers', 'employee', 'employees']);

function textual(c: ColumnInfo): boolean {
  return typeFamily(c.typeName) === 'text' && !/(_id|Id)$/.test(c.name);
}

/// The tenant table's columns a person would recognise it by: name-like
/// text columns, or failing those its first few text columns.
export function nameColumns(table: TableInfo): string[] {
  // The row's own name beats any other column ending in `_name`:
  // `partner.name` says which partner, `partner.contact_name` says who to call.
  const own = new Set(['name', `${table.name.toLowerCase()}_name`, 'display_name', 'title', 'label']);
  const primary = table.columns.filter((c) => textual(c) && own.has(c.name.toLowerCase())).map((c) => c.name);
  if (primary.length > 0) return primary.slice(0, 2);
  const named = table.columns.filter((c) => textual(c) && NAMEISH.test(c.name)).map((c) => c.name);
  if (named.length > 0) return named.slice(0, 4);
  return table.columns.filter(textual).slice(0, 3).map((c) => c.name);
}

/// The tables a login could live in. Not just the one called `users` — a
/// second users table is exactly what this exists to find — but not every
/// table with an email in it either: a login table also keeps a password.
/// Without one anywhere (single sign-on, say), every table with an email
/// whose name says it holds people.
export function loginTables(snapshot: SchemaSnapshot): Array<TableRef & { columns: string[]; pk: string[] }> {
  const withEmail: Array<{ ref: TableRef; t: TableInfo; columns: string[] }> = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table' || t.primaryKey.length === 0) continue;
      if (looksLikeBackup(t.name) || looksLikeLog(t.name)) continue;
      const columns = t.columns.filter((c) => EMAILISH.test(c.name) && textual(c)).map((c) => c.name);
      if (columns.length > 0) withEmail.push({ ref: { schema: s.name, table: t.name }, t, columns });
    }
  }
  const keepsPassword = withEmail.filter(({ t }) => t.columns.some((c) => PASSWORDISH.test(c.name)));
  const chosen = keepsPassword.length > 0
    ? keepsPassword
    : withEmail.filter(({ ref }) => nameTokens(ref.table).some((tok) => PEOPLE.has(tok)));
  return chosen.map(({ ref, t, columns }) => {
    const usernames = t.columns.filter((c) => USERNAMEISH.test(c.name) && textual(c)).map((c) => c.name);
    return { ...ref, columns: [...columns, ...usernames], pk: t.primaryKey };
  });
}

const ROLEISH = /^(roles?|role_name|roles_mask|user_role|user_type|account_type|kind|is_admin|admin|is_superuser|superuser|is_staff|access_level|permission_level|permissions?)$/i;

/// What says what kind of login a row is: role-like columns on the login
/// table itself (`roles_mask`, `is_admin`, `user_type`), and links to a
/// roles table (`role_id → roles`). Read from the row a search finds, so a
/// login is described by what the data says it is, not by a label.
export function roleColumns(
  table: TableInfo,
  ref: TableRef,
  links: Link[],
): { direct: string[]; viaLink: Array<{ column: string; to: TableRef; refColumn: string }> } {
  const direct = table.columns.filter((c) => ROLEISH.test(c.name)).map((c) => c.name).slice(0, 3);
  const viaLink = links
    .filter((l) => tableKey(l.from) === tableKey(ref) && l.columns.length === 1 && !l.audit && !l.when && /role/i.test(l.to.table))
    .map((l) => ({ column: l.columns[0], to: l.to, refColumn: l.refColumns[0] }))
    .slice(0, 2);
  return { direct, viaLink };
}

/// A bounded, read-only search of one table, built here so the connection
/// host never takes SQL from anywhere: identifiers quoted per engine, every
/// value bound.
export interface FindRequest {
  schema: string;
  table: string;
  select: string[];
  /// Any of these columns matching. 'exact' compares case-insensitively;
  /// 'contains' is a case-insensitive substring match.
  match: string[];
  mode: 'exact' | 'contains';
  term: string;
  limit: number;
  /// And only rows whose `column` is one of `values` — partners within the
  /// chosen client.
  within?: { column: string; values: string[] };
}

export function findSql(engine: Engine, req: FindRequest): { sql: string; params: unknown[] } {
  const q = (n: string) => quoteIdent(n, engine);
  const target = engine === 'sqlite' ? q(req.table) : `${q(req.schema)}.${q(req.table)}`;
  const params: unknown[] = [];
  const holder = () => (engine === 'postgres' ? `$${params.length}` : '?');
  const term = req.mode === 'contains' ? `%${req.term.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : req.term;
  const where = req.match.map((c) => {
    params.push(term);
    const col = engine === 'postgres' ? `${q(c)}::text` : q(c);
    return req.mode === 'contains' ? `LOWER(${col}) LIKE LOWER(${holder()})` : `LOWER(${col}) = LOWER(${holder()})`;
  });
  let clause = where.join(' OR ');
  if (req.within && req.within.values.length > 0) {
    const holders = req.within.values.slice(0, 1000).map((v) => {
      params.push(v);
      return holder();
    });
    clause = `(${clause}) AND ${q(req.within.column)} IN (${holders.join(', ')})`;
  }
  const limit = Math.max(1, Math.min(50, Math.floor(req.limit)));
  return {
    sql: `SELECT ${req.select.map(q).join(', ')} FROM ${target} WHERE ${clause} LIMIT ${limit}`,
    params,
  };
}

// ---------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------

/// A row the baseline is built around, by its key. The label is what the
/// person typed, so the recipe reads back in their words.
export interface StartingPoint {
  ref: TableRef;
  column: string;
  values: string[];
  label: string;
  /// One label per value, so a reopened recipe names each row its own way
  /// rather than every row by all of them.
  labels?: string[];
  /// A tenancy level below the tenant — the partners within a client — that
  /// a person narrowed to these rows. Tables carrying its key follow it
  /// rather than the tenant.
  narrows?: boolean;
}

/// What discovery produces and a person reviews: names, keys and rules —
/// never row data beyond the starting points' keys. Saved with the project.
export interface BaselineRecipe {
  version: 1;
  engine: Engine;
  savedAt: string;
  schemas: string[];
  tenant: (TableRef & { column: string }) | null;
  starts: StartingPoint[];
  /// Name links a person turned off, by linkKey. Everything else found is on.
  linksOff: string[];
  /// Every table's action, by tableKey.
  tables: Record<string, TableAction>;
  /// The subset of `tables` a person chose by hand, so a rerun keeps them.
  overrides: Record<string, TableAction>;
  /// Links read from data rather than the schema — polymorphic ones, from
  /// their type columns' values — so a build finds them without reading
  /// the data again.
  extraLinks?: Link[];
}

export function buildRecipe(args: {
  engine: Engine;
  schemas: string[];
  tenant: (TableRef & { column: string }) | null;
  starts: StartingPoint[];
  linksOff: Iterable<string>;
  plans: TablePlan[];
  overrides: Record<string, TableAction>;
  extraLinks?: Link[];
  now?: Date;
}): BaselineRecipe {
  const tables: Record<string, TableAction> = {};
  for (const p of [...args.plans].sort((a, b) => tableKey(a.ref).localeCompare(tableKey(b.ref)))) {
    tables[tableKey(p.ref)] = p.action;
  }
  return {
    version: 1,
    engine: args.engine,
    savedAt: (args.now ?? new Date()).toISOString(),
    schemas: [...args.schemas].sort(),
    tenant: args.tenant,
    starts: args.starts,
    linksOff: [...args.linksOff].sort(),
    tables,
    overrides: args.overrides,
    ...(args.extraLinks && args.extraLinks.length ? { extraLinks: args.extraLinks } : {}),
  };
}

const ACTIONS: ReadonlySet<string> = new Set(['schema', 'skip', 'empty', 'scoped', 'whole', 'review']);

/// A recipe read back from disk, or why it can't be used. It may have been
/// edited by hand or written by an older overdb, so nothing is assumed.
export function parseRecipe(raw: string): BaselineRecipe | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: 'The recipe is not valid JSON.' };
  }
  const r = v as Partial<BaselineRecipe>;
  if (!r || typeof r !== 'object' || r.version !== 1) return { error: 'The recipe is from a version of overdb this one does not read.' };
  if (!Array.isArray(r.schemas) || !r.tables || typeof r.tables !== 'object') return { error: 'The recipe is missing its schemas or tables.' };
  for (const [k, a] of Object.entries(r.tables)) {
    if (!ACTIONS.has(a as string)) return { error: `The recipe gives ${k} an unknown action “${String(a)}”.` };
  }
  return {
    version: 1,
    engine: r.engine ?? 'mysql',
    savedAt: r.savedAt ?? '',
    schemas: r.schemas,
    tenant: r.tenant ?? null,
    starts: Array.isArray(r.starts) ? r.starts : [],
    linksOff: Array.isArray(r.linksOff) ? r.linksOff : [],
    tables: r.tables as Record<string, TableAction>,
    overrides: r.overrides && typeof r.overrides === 'object' ? r.overrides : {},
    ...(Array.isArray(r.extraLinks) && r.extraLinks.length ? { extraLinks: r.extraLinks } : {}),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/// The table plans a saved recipe stands for, against the catalog as it is
/// now: the same sort a person reviewed, with their choices applied.
/// Links read from the catalog, plus the ones a recipe keeps: polymorphic
/// links read from the data, and links the database map settled from the
/// code. A settled link replaces whatever the column names guessed for the
/// same column, so a corrected guess is never followed alongside its fix.
export function withExtraLinks(found: readonly Link[], extra: readonly Link[]): Link[] {
  const col = (l: Link) => `${tableKey(l.from)}.${l.columns[0]}`.toLowerCase();
  const settled = new Set(extra.filter((l) => l.cited && !l.when).map(col));
  const kept = new Set(extra.map(linkKey));
  return [...found.filter((l) => !kept.has(linkKey(l)) && (l.source === 'fk' || l.when || !settled.has(col(l)))), ...extra];
}

export function plansFromRecipe(
  recipe: BaselineRecipe,
  snapshot: SchemaSnapshot,
  stats: TableStat[],
  links: Link[],
): TablePlan[] {
  const tenantKey = recipe.tenant ? tableKey(recipe.tenant) : null;
  return sortTables({
    snapshot: onlySchemas(snapshot, recipe.schemas),
    stats,
    links: withExtraLinks(links, recipe.extraLinks ?? []),
    linksOff: new Set(recipe.linksOff),
    tenant: recipe.tenant,
    starts: recipe.starts.filter((s) => !s.narrows && (!tenantKey || tableKey(s.ref) !== tenantKey)).map((s) => s.ref),
    narrow: recipe.starts.filter((s) => s.narrows).map((s) => ({ ...s.ref, column: s.column })),
    keepShare: 0.01,
    overrides: recipe.overrides,
  });
}

/// The catalog without the schemas a person left out of the baseline.
export function onlySchemas(snapshot: SchemaSnapshot, schemas: readonly string[]): SchemaSnapshot {
  const keep = new Set(schemas);
  return { ...snapshot, schemas: snapshot.schemas.filter((s) => keep.has(s.name)) };
}

// ---------------------------------------------------------------------
// Polymorphic links
// ---------------------------------------------------------------------

/// A pair of columns that point at a row in whichever table the first one
/// names: Rails and Laravel's `commentable_type` + `commentable_id`, or
/// Django's `content_type_id` + `object_id`. The schema cannot say which
/// tables; the type column's values can, so discovery reads them.
export interface PolyColumns {
  from: TableRef;
  typeColumn: string;
  idColumn: string;
  kind: 'named' | 'contenttype';
}

export function polymorphicColumns(snapshot: SchemaSnapshot): PolyColumns[] {
  const out: PolyColumns[] = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table' || looksLikeBackup(t.name)) continue;
      const names = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
      for (const c of t.columns) {
        const lower = c.name.toLowerCase();
        // `commentable_type` + `commentable_id`, `owner_type` + `owner_id`.
        const typed = lower.match(/^(.+)_type$/);
        if (typed && textual(c)) {
          const id = names.get(`${typed[1]}_id`) ?? names.get(`${typed[1]}_uuid`);
          if (id) out.push({ from: { schema: s.name, table: t.name }, typeColumn: c.name, idColumn: id.name, kind: 'named' });
        }
        // Django: `content_type_id` + `object_id`, or prefixed pairs.
        const ct = lower.match(/^(.*?)_?content_type_id$/);
        if (ct) {
          const prefix = ct[1] ? `${ct[1]}_` : '';
          const id = names.get(`${prefix}object_id`) ?? names.get(`${prefix}object_pk`);
          if (id) out.push({ from: { schema: s.name, table: t.name }, typeColumn: c.name, idColumn: id.name, kind: 'contenttype' });
        }
      }
    }
  }
  return out;
}

/// The table a type value names: `Post` → posts, `Admin::User` → users or
/// admin_users, `App\\Models\\BlogPost` → blog_posts. For Django, the
/// content type's `app_label` and `model` — `blog`, `post` → blog_post.
export function polyTarget(
  snapshot: SchemaSnapshot,
  from: TableRef,
  value: string,
  contentType?: { appLabel: string; model: string },
): (TableRef & { pk: string }) | null {
  const tables: Array<TableRef & { pk: string }> = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind === 'table' && t.primaryKey.length === 1 && !looksLikeBackup(t.name)) {
        tables.push({ schema: s.name, table: t.name, pk: t.primaryKey[0] });
      }
    }
  }
  const candidates: string[] = [];
  if (contentType) {
    candidates.push(`${contentType.appLabel}_${contentType.model}`.toLowerCase(), contentType.model.toLowerCase());
  } else {
    const parts = value.split(/::|\\|\.|\//).filter(Boolean);
    const last = nameTokens(parts[parts.length - 1] ?? value).join('_');
    const full = nameTokens(parts.join('_')).join('_');
    for (const n of [full, last]) candidates.push(...spellings(n));
  }
  for (const name of candidates) {
    const hits = tables.filter((t) => t.table.toLowerCase() === name);
    const pick = hits.find((t) => t.schema === from.schema) ?? hits[0];
    if (pick) return pick;
  }
  return null;
}

/// Below this share of its values naming a table, a `*_type` column is an
/// enum — USER, ADMIN — that happens to sit beside an `*_id`, not a
/// polymorphic pair.
export const POLY_MIN_RESOLVED = 0.5;

/// Links for a polymorphic pair, one per type value that names a table —
/// or none, when its values read as an enum rather than class names.
export function polymorphicLinks(
  snapshot: SchemaSnapshot,
  poly: PolyColumns,
  values: string[],
  contentTypes?: ReadonlyMap<string, { appLabel: string; model: string }>,
): Link[] {
  const present = values.map((v) => v.trim()).filter(Boolean);
  if (present.length === 0) return [];
  const table = snapshot.schemas.find((x) => x.name === poly.from.schema)?.tables.find((t) => t.name === poly.from.table);
  const idCol = table?.columns.find((c) => c.name === poly.idColumn);
  const out: Link[] = [];
  for (const value of present) {
    // SHOUTING is an enum's spelling, not a class's.
    if (poly.kind === 'named' && /^[A-Z0-9_]+$/.test(value) && /[A-Z]/.test(value) && value.length > 1) continue;
    const target = polyTarget(snapshot, poly.from, value, poly.kind === 'contenttype' ? contentTypes?.get(value) : undefined);
    if (!target) continue;
    const pk = snapshot.schemas.find((x) => x.name === target.schema)?.tables.find((t) => t.name === target.table)?.columns.find((c) => c.name === target.pk);
    // A text id column holds any key as a string — Django's object_pk is
    // text by design — so only a typed one has to match.
    if (idCol && typeFamily(idCol.typeName) !== 'text' && !compatible(idCol, pk)) continue;
    out.push({
      from: poly.from,
      columns: [poly.idColumn],
      to: { schema: target.schema, table: target.table },
      refColumns: [target.pk],
      source: 'poly',
      audit: false,
      alternatives: [],
      when: { column: poly.typeColumn, value },
    });
  }
  return out.length / present.length >= POLY_MIN_RESOLVED ? out : [];
}

// ---------------------------------------------------------------------
// One schema per tenant
// ---------------------------------------------------------------------

/// Schemas that hold the same tables — acme, globex, initech, each with the
/// same forty — are one schema per tenant. Then there is no tenant table to
/// find: the tenant IS a schema, and choosing schemas is choosing tenants.
export interface SchemaFamily {
  schemas: string[];
  /// Tables they have in common.
  tables: number;
}

export function schemaPerTenant(snapshot: SchemaSnapshot, minSchemas = 3, minTables = 5, similarity = 0.8): SchemaFamily | null {
  const sets = snapshot.schemas
    .map((s) => ({ name: s.name, tables: new Set(s.tables.filter((t) => t.kind === 'table').map((t) => t.name.toLowerCase())) }))
    .filter((s) => s.tables.size >= minTables);
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let both = 0;
    for (const x of a) if (b.has(x)) both++;
    return both / (a.size + b.size - both);
  };
  let best: SchemaFamily | null = null;
  const placed = new Set<string>();
  for (const seed of sets) {
    if (placed.has(seed.name)) continue;
    const members = sets.filter((s) => !placed.has(s.name) && jaccard(seed.tables, s.tables) >= similarity);
    if (members.length < minSchemas) continue;
    members.forEach((m) => placed.add(m.name));
    const common = [...seed.tables].filter((t) => members.every((m) => m.tables.has(t))).length;
    if (!best || members.length > best.schemas.length) best = { schemas: members.map((m) => m.name).sort(), tables: common };
  }
  return best;
}
