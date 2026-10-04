import { create } from 'zustand';
import type { Cell, SchemaSnapshot } from '@shared/types';
import type { BuildProgress } from '@shared/baselineBuild';
import type { SeedStep } from '@shared/types';
import { parseCodeReading, type CodeReading, type LinkVerdict, type TableSuggestion } from '@shared/baselineCode';
import { repoLinkOwner } from '@shared/overcliHandoff';
import { recipeHome, repoLinks } from '@shared/repoLinks';
import { linksFromMap } from '@shared/mapLinks';
import { runningFor, useBuilds } from './buildsStore';
import { useTickets } from './ticketsStore';
import type { DbMap } from '@shared/dbMap';
import { useStore } from './store';
import type { BaselineRecord } from '@shared/instances';
import {
  buildRecipe,
  findLinks,
  tenantNamesakes,
  keyOf,
  withExtraLinks,
  linkKey,
  loginTables,
  nameColumns,
  searchColumns,
  onlySchemas,
  roleColumns,
  polymorphicColumns,
  polymorphicLinks,
  schemaPerTenant,
  sortTables,
  tableKey,
  tenancyLevels,
  tenantCandidates,
  tenantTables,
  TENANT_MIN_SHARE,
  type BaselineRecipe,
  type Link,
  type StartingPoint,
  type TableAction,
  type TablePlan,
  type TableRef,
  type TableStat,
  type TenantCandidate,
  type TenancyLevel,
  type SchemaFamily,
} from '@shared/baseline';

// Create a baseline: look → start from → sort tables → save the recipe.
// See docs/design/baselines.md.
//
// Main reads the catalog and runs the bounded searches; every rule that
// turns them into a recipe is in src/shared/baseline.ts and runs here, so
// a change of tenant, a link turned off or a table moved re-sorts at once.

export type BaselineStep = 'start' | 'sort' | 'build';

export type Tenant = TableRef & { column: string };

/// One row of the tenant table, as a person would recognise it.
export interface TenantRow {
  key: string;
  label: string;
  /// From an active/status-like column, where the table has one.
  inactive: boolean;
  /// Found in another table keyed the same way, not the tenant's own.
  from?: string;
}

export interface LoginHit {
  ref: TableRef;
  column: string;
  key: string;
  /// The tenant row this login belongs to, when the table links to the
  /// tenant. Null when it links but the value is empty.
  tenantKey: string | null;
  tenantLabel: string | null;
  /// The table has no link to the tenant overdb can see.
  unlinked: boolean;
  /// What the row itself says it is: its partner, its role — "partner
  /// Globex", "roles_mask 5", "no partner".
  facts: string[];
}

export interface Login {
  id: string;
  role: string;
  term: string;
  searching: boolean;
  searched: boolean;
  hits: LoginHit[];
  error: string | null;
}

interface BaselineState {
  connectionId: string | null;
  loading: boolean;
  error: string | null;
  step: BaselineStep;

  snapshot: SchemaSnapshot | null;
  stats: TableStat[];
  links: Link[];
  /// The database map, when there is one: its links settle guesses before
  /// anyone is asked (see src/shared/mapLinks.ts).
  map: DbMap | null;
  fromMap: { confirmed: number; corrected: number; added: number } | null;
  candidates: TenantCandidate[];
  repo: string | null;
  recipePath: string | null;
  /// The recipe saved before, when there is one, and why it could not be
  /// read when there is one that can't.
  previous: BaselineRecipe | null;
  previousError: string | null;

  tenant: Tenant | null;
  tenantTerm: string;
  tenantSearching: boolean;
  tenantHits: TenantRow[] | null;
  /// The table a search is reading now, while it goes through several.
  tenantSearchingIn: string | null;
  /// Every table the last search read, so it can say where it looked.
  tenantLookedIn: string[];
  /// The tenant rows the baseline is built around.
  tenants: TenantRow[];
  tenantError: string | null;

  /// The schemas the baseline holds. The rest are not created at all.
  schemasOn: string[];
  /// Schemas that look like one per tenant, when there are such.
  schemaFamily: SchemaFamily | null;
  /// Links read from polymorphic type columns, and the reading's progress.
  polyLinks: Link[];
  polyPairs: number;
  polyProgress: { done: number; total: number } | null;
  /// Levels of tenancy below the tenant (partner within client), and the
  /// rows a person narrowed each to. No entry means all of them.
  levels: TenancyLevel[];
  narrowing: Record<string, TenantRow[]>;
  levelTerm: Record<string, string>;
  levelHits: Record<string, TenantRow[] | null>;
  levelBusy: Record<string, boolean>;

  logins: Login[];
  linksOff: string[];
  overrides: Record<string, TableAction>;

  saving: boolean;
  savedPath: string | null;
  saveError: string | null;

  /// One table's real count for the chosen tenants, which the size
  /// estimate scales by — keyed by the tenants it was measured for.
  measured: { table: string; rows: number; total: number; for: string } | null;
  /// A count in flight for the estimate; false once it answered or could not.
  measuring: boolean;

  claude: boolean;
  /// What this copy runs on here: the server binary it would be built
  /// with, or the Homebrew formula that would provide one. Null until read.
  server: { flavor: 'mysql' | 'mariadb' | 'postgres' | null; version: string; found: { path: string; version: string } | null; formula: string | null; brew: boolean } | null;
  /// A `brew install` in flight, with its latest line; an error once it fails.
  install: { jobId: string; formula: string; line: string } | null;
  installError: string | null;
  codeJob: string | null;
  codeSteps: SeedStep[];
  codeError: string | null;
  reading: CodeReading | null;
  /// Suggestions already applied, by link or table key.
  applied: string[];

  buildJob: string | null;
  buildStartedAt: number | null;
  buildLog: BuildProgress[];
  buildError: string | null;
  /// The failed build's log file.
  buildLogFile: string | null;
  built: BaselineRecord | null;

  open(connectionId: string): Promise<void>;
  close(): void;
  setStep(step: BaselineStep): void;
  setTenant(tenant: Tenant | null): void;
  toggleSchema(name: string): void;
  /// Keep only this schema of a one-per-tenant family.
  onlyTenantSchema(name: string): void;
  readPolymorphic(): Promise<void>;
  relabel(): Promise<void>;
  setAllSchemas(on: boolean): void;
  setLevelTerm(level: string, term: string): void;
  searchLevel(level: string): Promise<void>;
  toggleLevelRow(level: string, row: TenantRow): void;
  clearLevel(level: string): void;
  /// Narrow a level to the rows the found logins belong to.
  levelFromLogins(level: string): Promise<number>;
  setTenantTerm(term: string): void;
  searchTenant(): Promise<void>;
  toggleTenant(row: TenantRow): void;
  /// Search one table the person chose for the tenant's name.
  searchTenantIn(ref: TableRef): Promise<void>;
  addLogin(role?: string): void;
  /// Add each login in `text` — one, or several separated by commas,
  /// spaces or lines — and look each one up. Ones already added are skipped.
  addLogins(text: string): Promise<void>;
  removeLogin(id: string): void;
  setLoginTerm(id: string, term: string): void;
  searchLogin(id: string): Promise<void>;
  toggleLink(key: string): void;
  overrideTable(key: string, action: TableAction | null): void;
  save(): Promise<void>;
  /// Save the recipe if it changed, then build it.
  build(): Promise<void>;
  stopBuild(): void;
  /// Close the sheet and let the running build finish on its own, followed
  /// by the pill at the bottom of the window.
  background(): void;
  progress(jobId: string, p: BuildProgress): void;
  /// The linked repos changed: the recipe saves to the new home from its
  /// next save.
  reposChanged(): void;
  measure(): Promise<void>;
  readCode(): Promise<void>;
  stopReadCode(): void;
  codeStep(jobId: string, step: SeedStep): void;
  applyLink(v: LinkVerdict): void;
  applyTable(t: TableSuggestion): void;
  applyAll(): void;
  /// The map was built or refreshed: read it again and settle the links.
  mapChanged(): Promise<void>;
  /// Read again what server this copy would run on.
  checkServer(): Promise<void>;
  /// Install it with Homebrew, then check again.
  installServer(): Promise<void>;
}

const INITIAL = {
  connectionId: null,
  loading: false,
  error: null,
  step: 'start' as BaselineStep,
  snapshot: null,
  map: null as DbMap | null,
  fromMap: null as BaselineState['fromMap'],
  stats: [],
  links: [],
  candidates: [],
  repo: null,
  recipePath: null,
  previous: null,
  previousError: null,
  tenant: null,
  tenantTerm: '',
  tenantSearching: false,
  tenantHits: null,
  tenantSearchingIn: null as string | null,
  tenantLookedIn: [] as string[],
  tenants: [],
  tenantError: null,
  schemasOn: [] as string[],
  schemaFamily: null,
  polyLinks: [] as Link[],
  polyPairs: 0,
  polyProgress: null,
  levels: [] as TenancyLevel[],
  narrowing: {} as Record<string, TenantRow[]>,
  levelTerm: {} as Record<string, string>,
  levelHits: {} as Record<string, TenantRow[] | null>,
  levelBusy: {} as Record<string, boolean>,
  logins: [] as Login[],
  linksOff: [],
  overrides: {},
  saving: false,
  savedPath: null,
  saveError: null,
  measured: null,
  measuring: false,
  claude: false,
  server: null as BaselineState['server'],
  install: null as BaselineState['install'],
  installError: null as string | null,
  codeJob: null,
  codeSteps: [] as SeedStep[],
  codeError: null,
  reading: null,
  applied: [] as string[],
  buildJob: null,
  buildStartedAt: null,
  buildLog: [] as BuildProgress[],
  buildError: null,
  buildLogFile: null,
  built: null,
};

const STATUSISH = /^(active|is_active|enabled|is_enabled|status|deleted|is_deleted|archived|is_archived)$/i;

function text(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'object') return '';
  return String(c);
}

/// Whether a status-like cell says the row is not in use.
function inactiveFrom(column: string, c: Cell): boolean {
  const v = text(c).toLowerCase();
  if (/deleted|archived/i.test(column)) return v === '1' || v === 'true';
  if (/status/i.test(column)) return /inactive|disabled|deleted|archived|closed|cancel/.test(v);
  return v === '0' || v === 'false';
}

let loginSeq = 0;
const newLogin = (role: string): Login => ({
  id: `login-${++loginSeq}`, role, term: '', searching: false, searched: false, hits: [], error: null,
});

function tableInfo(snapshot: SchemaSnapshot | null, ref: TableRef) {
  return snapshot?.schemas.find((s) => s.name === ref.schema)?.tables.find((t) => t.name === ref.table);
}

/// A row's name, by its key, for saying "partner Globex" rather than an
/// id. Falls back to the key.
async function labelOf(connectionId: string, snapshot: SchemaSnapshot, ref: TableRef, column: string, key: string): Promise<string> {
  const info = tableInfo(snapshot, ref);
  const names = info ? nameColumns(info) : [];
  if (names.length === 0) return key;
  const res = await window.overdb.invoke('baseline:find', {
    connectionId,
    req: { schema: ref.schema, table: ref.table, select: names, match: [column], mode: 'exact', term: key, limit: 1 },
  });
  return (res.ok && res.rows[0] ? res.rows[0].map(text).filter(Boolean).join(' · ') : '') || key;
}

/// Links with the map's applied, and how many it settled.
function settle(map: DbMap | null, snapshot: SchemaSnapshot, links: Link[]): { links: Link[]; counts: BaselineState['fromMap'] } {
  if (!map) return { links, counts: null };
  const r = linksFromMap(map, snapshot, links);
  return { links: r.links, counts: { confirmed: r.confirmed, corrected: r.corrected, added: r.added } };
}

/// A found row's label, from `[key, ...searchColumns]`: its name columns
/// (the first `names` searched), or when those are empty the first other
/// searched column with a value — the one that matched, usually — or the key.
function hitLabel(row: Cell[], names: number): string {
  const values = row.slice(1).map(text);
  return values.slice(0, names).filter(Boolean).join(' · ') || values.slice(names).find(Boolean) || text(row[0]);
}

/// The latest tenant search and measurement; an older one's answer is dropped.
let searchSeq = 0;
let measureSeq = 0;

export const useBaseline = create<BaselineState>((set, get) => ({
  ...INITIAL,

  async open(connectionId) {
    set({ ...INITIAL, connectionId, loading: true, logins: [] });
    const [res, tools, map] = await Promise.all([
      window.overdb.invoke('baseline:discover', connectionId),
      window.overdb.invoke('ai:detect'),
      window.overdb.invoke('map:read', connectionId).catch(() => null),
    ]);
    if (get().connectionId !== connectionId) return;
    set({ claude: tools.claude });
    if (!res.ok) {
      set({ loading: false, error: res.error });
      return;
    }
    // The map's links first, so the tenant and its levels are found with
    // what the code says, not only what the names suggest.
    const found = withExtraLinks(findLinks(res.snapshot), res.recipe?.extraLinks ?? []);
    const settled = map ? linksFromMap(map, res.snapshot, found) : null;
    const links = settled?.links ?? found;
    const candidates = tenantCandidates(res.snapshot, links);
    const top = candidates[0];
    const previous = res.recipe;
    // A recipe saved before wins over a fresh guess: it is what a person
    // already reviewed.
    const tenant: Tenant | null = previous
      ? previous.tenant
      : top && top.share >= TENANT_MIN_SHARE
        ? { ...top.ref, column: top.column }
        : null;
    const tenantStart = previous?.starts.find((s) => tenant && tableKey(s.ref) === tableKey(tenant));
    set({
      loading: false,
      snapshot: res.snapshot,
      stats: res.stats,
      links,
      map,
      fromMap: settled && { confirmed: settled.confirmed, corrected: settled.corrected, added: settled.added },
      candidates,
      repo: res.repo,
      recipePath: res.recipePath,
      previous,
      previousError: res.recipeError ?? null,
      tenant,
      tenants: tenantStart ? tenantStart.values.map((key, i) => ({ key, label: tenantStart.labels?.[i] ?? (tenantStart.values.length === 1 ? tenantStart.label : key), inactive: false })) : [],
      schemasOn: previous?.schemas.filter((x) => res.snapshot.schemas.some((y) => y.name === x)) ?? res.snapshot.schemas.map((x) => x.name),
      schemaFamily: schemaPerTenant(res.snapshot),
      // What the last recipe read from the data, until it is read again.
      polyLinks: (previous?.extraLinks ?? []).filter((l) => l.source === 'poly'),
      levels: tenant ? tenancyLevels(res.snapshot, links, tenant) : [],
      narrowing: Object.fromEntries(
        (previous?.starts ?? [])
          .filter((p) => p.narrows)
          .map((p) => [tableKey(p.ref), p.values.map((key, i) => ({ key, label: p.labels?.[i] ?? (p.values.length === 1 ? p.label : key), inactive: false }))]),
      ),
      linksOff: previous?.linksOff ?? [],
      overrides: previous?.overrides ?? {},
    });
    void get().readPolymorphic();
    void get().relabel();
    void get().checkServer();
    // The logins a saved recipe was built around, looked up again.
    const loginTerms = (previous?.starts ?? [])
      .filter((p) => !p.narrows && !(tenant && tableKey(p.ref) === tableKey(tenant)))
      .map((p) => p.label);
    if (loginTerms.length > 0) void get().addLogins(loginTerms.join('\n'));
  },

  async relabel() {
    // A recipe saved before labels were kept per key reopens with keys for
    // names. Look the names up again.
    const { connectionId, snapshot, tenant, tenants, levels, narrowing } = get();
    if (!connectionId || !snapshot) return;
    if (tenant) {
      const named = await Promise.all(
        tenants.map(async (t) => (t.label === t.key ? { ...t, label: await labelOf(connectionId, snapshot, tenant, tenant.column, t.key) } : t)),
      );
      if (named.some((t, i) => t.label !== tenants[i].label)) set({ tenants: named });
    }
    for (const lv of levels) {
      const rows = narrowing[tableKey(lv.ref)];
      if (!rows?.some((r) => r.label === r.key)) continue;
      const named = await Promise.all(
        rows.map(async (r) => (r.label === r.key ? { ...r, label: await labelOf(connectionId, snapshot, lv.ref, lv.column, r.key) } : r)),
      );
      set({ narrowing: { ...get().narrowing, [tableKey(lv.ref)]: named } });
    }
  },

  async readPolymorphic() {
    const { connectionId, snapshot } = get();
    if (!connectionId || !snapshot) return;
    const pairs = polymorphicColumns(snapshot);
    set({ polyPairs: pairs.length });
    if (pairs.length === 0) return;
    // Django's content types, once, when any pair needs them.
    const types = new Map<string, { appLabel: string; model: string }>();
    const ctTable = snapshot.schemas.flatMap((x) => x.tables.map((t) => ({ schema: x.name, t }))).find((x) => x.t.name === 'django_content_type');
    if (ctTable && pairs.some((p) => p.kind === 'contenttype')) {
      const res = await window.overdb.invoke('baseline:distinct', {
        connectionId, schema: ctTable.schema, table: 'django_content_type', columns: ['id', 'app_label', 'model'], sample: 5_000, limit: 5_000,
      });
      if (res.ok) for (const [id, appLabel, model] of res.rows) types.set(text(id), { appLabel: text(appLabel), model: text(model) });
    }
    const found: Link[] = [];
    set({ polyProgress: { done: 0, total: pairs.length } });
    for (const [i, p] of pairs.entries()) {
      if (get().connectionId !== connectionId) return;
      const res = await window.overdb.invoke('baseline:distinct', {
        connectionId, schema: p.from.schema, table: p.from.table, columns: [p.typeColumn], sample: 50_000, limit: 200,
      });
      if (res.ok) found.push(...polymorphicLinks(snapshot, p, res.rows.map((r) => text(r[0])), types));
      set({ polyProgress: { done: i + 1, total: pairs.length } });
    }
    if (get().connectionId !== connectionId) return;
    set({
      polyLinks: found,
      polyProgress: null,
      links: settle(get().map, snapshot, [...findLinks(snapshot), ...found]).links,
    });
  },

  async checkServer() {
    const { connectionId, snapshot } = get();
    if (!connectionId || !snapshot || (snapshot.engine !== 'mysql' && snapshot.engine !== 'postgres')) return;
    const server = await window.overdb.invoke('baseline:serverFor', { engine: snapshot.engine, serverVersion: snapshot.serverVersion }).catch(() => null);
    if (get().connectionId === connectionId) set({ server });
  },

  async installServer() {
    const formula = get().server?.formula;
    if (!formula || get().install) return;
    const jobId = crypto.randomUUID();
    set({ install: { jobId, formula, line: `brew install ${formula}` }, installError: null });
    const res = await window.overdb.invoke('baseline:installServer', { jobId, formula }).catch((err: unknown) => ({ ok: false, error: String(err) }));
    set({ install: null, installError: res.ok ? null : res.error ?? 'The install did not finish.' });
    await get().checkServer();
  },

  async mapChanged() {
    const { connectionId, snapshot, polyLinks } = get();
    if (!connectionId || !snapshot) return;
    const map = await window.overdb.invoke('map:read', connectionId).catch(() => null);
    if (get().connectionId !== connectionId) return;
    const r = settle(map, snapshot, [...findLinks(snapshot), ...polyLinks]);
    set({ map, links: r.links, fromMap: r.counts });
  },

  close() {
    get().stopBuild();
    get().stopReadCode();
    set({ ...INITIAL });
  },

  setStep(step) {
    set({ step });
  },

  setTenant(tenant) {
    const { snapshot, links } = get();
    set({
      tenant, tenantHits: null, tenants: [], tenantError: null, savedPath: null,
      levels: tenant && snapshot ? tenancyLevels(snapshot, links, tenant) : [],
      narrowing: {}, levelHits: {}, levelTerm: {},
    });
  },

  onlyTenantSchema(name) {
    const fam = get().schemaFamily;
    const all = get().snapshot?.schemas.map((x) => x.name) ?? [];
    if (!fam) return;
    set({ schemasOn: all.filter((x) => x === name || !fam.schemas.includes(x)), savedPath: null });
  },

  toggleSchema(name) {
    const on = get().schemasOn;
    set({ schemasOn: on.includes(name) ? on.filter((x) => x !== name) : [...on, name], savedPath: null });
  },

  setAllSchemas(on) {
    set({ schemasOn: on ? (get().snapshot?.schemas.map((x) => x.name) ?? []) : [], savedPath: null });
  },

  setLevelTerm(level, term) {
    set({ levelTerm: { ...get().levelTerm, [level]: term } });
  },

  async searchLevel(level) {
    const s = get();
    const lv = s.levels.find((l) => tableKey(l.ref) === level);
    const term = (s.levelTerm[level] ?? '').trim();
    if (!s.connectionId || !lv || !term) return;
    const info = tableInfo(s.snapshot, lv.ref);
    if (!info) return;
    const names = nameColumns(info);
    const status = info.columns.find((c) => STATUSISH.test(c.name))?.name;
    const select = [lv.column, ...names, ...(status ? [status] : [])];
    // Within the chosen tenants, when the level sits directly under them.
    const within = s.tenant && tableKey(lv.parent) === tableKey(s.tenant) && s.tenants.length > 0
      ? { column: lv.parentColumn, values: s.tenants.map((t) => t.key) }
      : undefined;
    set({ levelBusy: { ...s.levelBusy, [level]: true } });
    const res = await window.overdb.invoke('baseline:find', {
      connectionId: s.connectionId,
      req: { schema: lv.ref.schema, table: lv.ref.table, select, match: [lv.column, ...names], mode: 'contains', term, limit: 25, within },
    });
    const hits = res.ok
      ? res.rows.map((r) => ({
          key: text(r[0]),
          label: names.map((_, i) => text(r[1 + i])).filter(Boolean).join(' · ') || text(r[0]),
          inactive: status ? inactiveFrom(status, r[select.length - 1]) : false,
        }))
      : [];
    set({ levelBusy: { ...get().levelBusy, [level]: false }, levelHits: { ...get().levelHits, [level]: hits } });
  },

  toggleLevelRow(level, row) {
    const cur = get().narrowing[level] ?? [];
    const next = cur.some((r) => r.key === row.key) ? cur.filter((r) => r.key !== row.key) : [...cur, row];
    const narrowing = { ...get().narrowing };
    if (next.length > 0) narrowing[level] = next;
    else delete narrowing[level];
    set({ narrowing, savedPath: null });
  },

  clearLevel(level) {
    const { [level]: _gone, ...rest } = get().narrowing;
    set({ narrowing: rest, savedPath: null });
  },

  async levelFromLogins(level) {
    const s = get();
    const lv = s.levels.find((l) => tableKey(l.ref) === level);
    if (!s.connectionId || !s.snapshot || !lv) return 0;
    const found = new Set<string>();
    for (const l of s.logins) {
      for (const h of l.hits) {
        // The login's own column pointing at this level, if its table has one.
        const link = s.links.find(
          (x) => tableKey(x.from) === tableKey(h.ref) && tableKey(x.to) === level && !x.audit && x.columns.length === 1,
        );
        if (!link) continue;
        const res = await window.overdb.invoke('baseline:find', {
          connectionId: s.connectionId,
          req: { schema: h.ref.schema, table: h.ref.table, select: [link.columns[0]], match: [h.column], mode: 'exact', term: h.key, limit: 1 },
        });
        const v = res.ok ? text(res.rows[0]?.[0] ?? null) : '';
        if (v) found.add(v);
      }
    }
    const info = tableInfo(s.snapshot, lv.ref);
    const names = info ? nameColumns(info) : [];
    for (const key of found) {
      if ((get().narrowing[level] ?? []).some((r) => r.key === key)) continue;
      let label = key;
      if (names.length > 0) {
        const res = await window.overdb.invoke('baseline:find', {
          connectionId: s.connectionId,
          req: { schema: lv.ref.schema, table: lv.ref.table, select: names, match: [lv.column], mode: 'exact', term: key, limit: 1 },
        });
        if (res.ok && res.rows[0]) label = res.rows[0].map(text).filter(Boolean).join(' · ') || key;
      }
      get().toggleLevelRow(level, { key, label, inactive: false });
    }
    return found.size;
  },

  setTenantTerm(tenantTerm) {
    // A search for the old term answers into nothing, and stops spinning.
    searchSeq++;
    set({ tenantTerm, tenantSearching: false, tenantSearchingIn: null });
  },

  async searchTenant() {
    const { connectionId, tenant, tenantTerm, snapshot } = get();
    const term = tenantTerm.trim();
    if (!connectionId || !tenant || !term) return;
    const info = tableInfo(snapshot, tenant);
    if (!info) return;
    const names = nameColumns(info);
    const status = info.columns.find((c) => STATUSISH.test(c.name))?.name;
    const select = [tenant.column, ...names, ...(status ? [status] : [])];
    const seq = ++searchSeq;
    set({ tenantSearching: true, tenantError: null, tenantHits: null, tenantSearchingIn: null, tenantLookedIn: [`${tenant.schema}.${tenant.table}`] });
    const res = await window.overdb.invoke('baseline:find', {
      connectionId,
      req: {
        schema: tenant.schema, table: tenant.table, select, match: [...new Set([tenant.column, ...searchColumns(info)])],
        mode: 'contains', term, limit: 20,
      },
    });
    if (seq !== searchSeq) return;
    if (!res.ok) {
      set({ tenantSearching: false, tenantError: res.error });
      return;
    }
    let hits: TenantRow[] = res.rows.map((r) => ({
      key: text(r[0]),
      label: names.map((_, i) => text(r[1 + i])).filter(Boolean).join(' · ') || text(r[0]),
      inactive: status ? inactiveFrom(status, r[select.length - 1]) : false,
    }));
    // Not in the tenant's own table: look in the others keyed the same way.
    // A data mart mirrors one client into several tables, and the one most
    // tables point at is not always the one that holds every name.
    // No exact match in the tenant's own table: look in the others keyed
    // the same way — a data mart mirrors one client into several tables and
    // views. Results show as each table answers, grouped by table.
    const exact = (label: string) => label.toLowerCase().split(' · ').some((x) => x === term.toLowerCase());
    if (snapshot && !hits.some((h) => exact(h.label))) {
      const links = get().links;
      const inbound = (ref: TableRef) => links.filter((l) => !l.audit && tableKey(l.to) === tableKey(ref)).length;
      // Closest name first (`acme_db_client` before `acme_db_z123_client`),
      // then the one more of the mart points at.
      const extra = (name: string) => name.split('_').length;
      const ranked = tenantNamesakes(snapshot, tenant)
        .sort((a, b) => extra(a.table) - extra(b.table) || inbound(b) - inbound(a) || a.table.localeCompare(b.table))
        .slice(0, 8);
      const quality = (label: string) => {
        const l = label.toLowerCase();
        const q = term.toLowerCase();
        return exact(label) ? 0 : l.startsWith(q) ? 1 : 2;
      };
      set({ tenantHits: hits });
      for (const other of ranked) {
        const on = searchColumns(other.info);
        if (on.length === 0) continue;
        set({ tenantSearchingIn: `${other.schema}.${other.table}`, tenantLookedIn: [...get().tenantLookedIn, `${other.schema}.${other.table}`] });
        const r2 = await window.overdb.invoke('baseline:find', {
          connectionId,
          req: { schema: other.schema, table: other.table, select: [tenant.column, ...on], match: on, mode: 'contains', term, limit: 30 },
        });
        if (seq !== searchSeq) return;
        if (!r2.ok) continue;
        const found = r2.rows
          .filter((r) => !hits.some((h) => h.key === text(r[0])))
          .map((r) => ({ key: text(r[0]), label: hitLabel(r, nameColumns(other.info).length), inactive: false, from: `${other.schema}.${other.table}` }))
          .sort((a, b) => quality(a.label) - quality(b.label) || a.label.localeCompare(b.label))
          .slice(0, 8);
        hits = [...hits, ...found];
        set({ tenantHits: hits });
      }
      // Tables with an exact match first.
      const best = (from: string | undefined) => (hits.some((h) => h.from === from && exact(h.label)) ? 0 : 1);
      hits = [...hits].sort((a, b) => (a.from === undefined ? -1 : b.from === undefined ? 1 : best(a.from) - best(b.from)));
      set({ tenantSearchingIn: null });
    }
    // One active match is the answer; anything else is a choice.
    const active = hits.filter((h) => !h.inactive);
    const tenants = get().tenants.length === 0 && active.length === 1 ? [active[0]] : get().tenants;
    set({ tenantSearching: false, tenantHits: hits, tenants, savedPath: null });
  },

  async searchTenantIn(ref) {
    const { connectionId, tenant, tenantTerm, snapshot } = get();
    const term = tenantTerm.trim();
    const info = tableInfo(snapshot, ref);
    if (!connectionId || !tenant || !term || !info) return;
    // The key column the table holds for the tenant: the tenant's own, or
    // the table's own key when it is named the same way.
    const key = info.columns.find((c) => c.name.toLowerCase() === tenant.column.toLowerCase())?.name ?? keyOf(info);
    const on = searchColumns(info);
    if (!key || on.length === 0) {
      set({ tenantError: `${ref.schema}.${ref.table} has no ${tenant.column} and name column to search.` });
      return;
    }
    const from = `${ref.schema}.${ref.table}`;
    const seq = ++searchSeq;
    set({ tenantSearching: true, tenantError: null, tenantSearchingIn: from, tenantLookedIn: [...get().tenantLookedIn.filter((x) => x !== from), from] });
    const res = await window.overdb.invoke('baseline:find', {
      connectionId,
      req: { schema: ref.schema, table: ref.table, select: [key, ...on], match: on, mode: 'contains', term, limit: 30 },
    });
    if (seq !== searchSeq) return;
    if (!res.ok) {
      set({ tenantSearching: false, tenantSearchingIn: null, tenantError: res.error });
      return;
    }
    // The table you picked wins: its rows go first, under its own heading,
    // and take over any key another table already showed — a mart mirrors
    // the same client ids into several tables, so they often overlap.
    const found: TenantRow[] = res.rows
      .map((r) => ({ key: text(r[0]), label: hitLabel(r, nameColumns(info).length), inactive: false, from }));
    const have = (get().tenantHits ?? []).filter((h) => h.from !== from && !found.some((f) => f.key === h.key));
    set({
      tenantSearching: false, tenantSearchingIn: null, tenantHits: [...found, ...have],
      tenantError: found.length === 0 ? `Nothing in ${from} matched “${term}” — searched ${on.join(', ')}.` : null,
    });
  },

  toggleTenant(row) {
    const on = get().tenants.some((t) => t.key === row.key);
    set({
      tenants: on ? get().tenants.filter((t) => t.key !== row.key) : [...get().tenants, row],
      savedPath: null,
    });
  },

  addLogin(role = '') {
    set({ logins: [...get().logins, newLogin(role)] });
  },

  async addLogins(text) {
    const have = new Set(get().logins.map((l) => l.term.trim().toLowerCase()));
    const terms = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))].filter(
      (x) => !have.has(x.toLowerCase()),
    );
    if (terms.length === 0) return;
    const added = terms.map((term) => ({ ...newLogin(''), term }));
    set({ logins: [...get().logins, ...added], savedPath: null });
    for (const l of added) await get().searchLogin(l.id);
  },

  removeLogin(id) {
    set({ logins: get().logins.filter((l) => l.id !== id), savedPath: null });
  },

  setLoginTerm(id, term) {
    set({ logins: get().logins.map((l) => (l.id === id ? { ...l, term, searched: false } : l)) });
  },

  async searchLogin(id) {
    const { connectionId, snapshot, tenant, links, linksOff } = get();
    const login = get().logins.find((l) => l.id === id);
    const term = login?.term.trim();
    if (!connectionId || !snapshot || !login || !term) return;
    const patch = (p: Partial<Login>) =>
      set({ logins: get().logins.map((l) => (l.id === id ? { ...l, ...p } : l)) });
    patch({ searching: true, error: null });

    const family = tenant ? new Set(tenantTables(snapshot, tenant).map(tableKey)) : new Set<string>();
    const off = new Set(linksOff);
    const hits: LoginHit[] = [];
    try {
      const levels = get().levels;
      for (const t of loginTables(snapshot)) {
        // How this table reaches the tenant, if it does: its own link, by
        // key or by name, that is not an audit column.
        const link = links.find(
          (l) => tableKey(l.from) === tableKey(t) && family.has(tableKey(l.to)) && !l.audit && !off.has(linkKey(l)) && l.columns.length === 1,
        );
        const isTenant = family.has(tableKey(t));
        // And what the row says about itself: which level it sits in, and
        // any role-like columns or roles table it points at.
        const levelLinks = levels.flatMap((lv) => {
          const fam = new Set(tenantTables(snapshot, { ...lv.ref, column: lv.column }).map(tableKey));
          const l = links.find((x) => tableKey(x.from) === tableKey(t) && fam.has(tableKey(x.to)) && !x.audit && x.columns.length === 1);
          return l ? [{ level: lv, link: l }] : [];
        });
        const info = tableInfo(snapshot, t);
        const roles = info ? roleColumns(info, t, links) : { direct: [], viaLink: [] };
        const extra = [...levelLinks.map((x) => x.link.columns[0]), ...roles.direct, ...roles.viaLink.map((r) => r.column)];
        const select = [t.pk[0], ...(link ? [link.columns[0]] : []), ...extra];
        const res = await window.overdb.invoke('baseline:find', {
          connectionId,
          req: { schema: t.schema, table: t.table, select, match: t.columns, mode: 'exact', term, limit: 5 },
        });
        if (!res.ok) throw new Error(res.error);
        const at = (r: Cell[], col: string) => r[select.indexOf(col)];
        for (const r of res.rows) {
          const facts: string[] = [];
          for (const { level, link: ll } of levelLinks) {
            const v = text(at(r, ll.columns[0]));
            facts.push(v ? `${level.ref.table} ${await labelOf(connectionId, snapshot, level.ref, level.column, v)}` : `no ${level.ref.table}`);
          }
          for (const c of roles.direct) {
            const v = text(at(r, c));
            if (v) facts.push(`${c} ${v}`);
          }
          for (const rl of roles.viaLink) {
            const v = text(at(r, rl.column));
            if (v) facts.push(`${rl.to.table} ${await labelOf(connectionId, snapshot, rl.to, rl.refColumn, v)}`);
          }
          hits.push({
            ref: { schema: t.schema, table: t.table },
            column: t.pk[0],
            key: text(r[0]),
            tenantKey: link ? text(r[1]) || null : isTenant ? text(r[0]) : null,
            tenantLabel: null,
            unlinked: !link && !isTenant && !!tenant,
            facts,
          });
        }
      }
      // Say which tenant each login is on, by name — "on acme-internal" is
      // a finding; an id is homework.
      const known = new Map(get().tenants.map((t) => [t.key, t.label]));
      for (const h of hits) {
        if (!h.tenantKey || !tenant) continue;
        if (known.has(h.tenantKey)) {
          h.tenantLabel = known.get(h.tenantKey)!;
          continue;
        }
        const info = tableInfo(snapshot, tenant);
        const names = info ? nameColumns(info) : [];
        if (names.length === 0) continue;
        const res = await window.overdb.invoke('baseline:find', {
          connectionId,
          req: { schema: tenant.schema, table: tenant.table, select: names, match: [tenant.column], mode: 'exact', term: h.tenantKey, limit: 1 },
        });
        if (res.ok && res.rows[0]) {
          h.tenantLabel = res.rows[0].map(text).filter(Boolean).join(' · ') || null;
          known.set(h.tenantKey, h.tenantLabel ?? h.tenantKey);
        }
      }
      if (get().logins.find((l) => l.id === id)?.term.trim() !== term) return;
      patch({ searching: false, searched: true, hits });
      set({ savedPath: null });
    } catch (err) {
      patch({ searching: false, searched: true, hits: [], error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleLink(key) {
    const off = get().linksOff;
    set({ linksOff: off.includes(key) ? off.filter((k) => k !== key) : [...off, key], savedPath: null });
  },

  overrideTable(key, action) {
    const next = { ...get().overrides };
    if (action === null) delete next[key];
    else next[key] = action;
    set({ overrides: next, savedPath: null });
  },

  async save() {
    const s = get();
    if (!s.connectionId || !s.snapshot) return;
    set({ saving: true, saveError: null });
    const recipe = buildRecipe({
      engine: s.snapshot.engine,
      schemas: s.schemasOn,
      tenant: s.tenant,
      starts: startingPoints(s),
      linksOff: s.linksOff,
      plans: plansFor(s),
      overrides: s.overrides,
      // What the data and the code said, so the build follows the links
      // that were reviewed rather than the column-name guesses alone.
      extraLinks: [...s.polyLinks, ...s.links.filter((l) => l.cited && l.source !== 'poly')],
    });
    const res = await window.overdb.invoke('baseline:save', { connectionId: s.connectionId, recipe });
    set(res.ok ? { saving: false, savedPath: res.path, previous: recipe } : { saving: false, saveError: res.error });
  },

  async build() {
    if (runningFor(get().connectionId)) {
      useStore.getState().toast('This one is already being built in the background — it is at the bottom of the window.', 'error');
      return;
    }
    if (!get().savedPath) await get().save();
    const { connectionId, savedPath } = get();
    if (!connectionId || !savedPath) return;
    const jobId = crypto.randomUUID();
    set({ step: 'build', buildJob: jobId, buildStartedAt: Date.now(), buildLog: [], buildError: null, buildLogFile: null, built: null });
    const res = await window.overdb.invoke('baseline:build', { jobId, connectionId });
    // Wherever it is followed — this sheet, or the pill once the sheet was
    // closed — the base is new, so branches and the sidebar should know.
    if (res.ok) void useTickets.getState().refresh();
    useBuilds.getState().finish(jobId, res);
    if (get().buildJob !== jobId) return;
    set(res.ok ? { buildJob: null, built: res.baseline } : { buildJob: null, buildError: res.error, buildLogFile: res.log ?? null });
  },

  background() {
    const s = get();
    if (!s.buildJob || !s.connectionId) return;
    const conn = useStore.getState().connections.find((c) => c.id === s.connectionId);
    useBuilds.getState().add({
      jobId: s.buildJob,
      connectionId: s.connectionId,
      name: conn?.name ?? 'a base',
      remote: !!conn && conn.env !== 'local',
      startedAt: s.buildStartedAt ?? Date.now(),
      last: s.buildLog[s.buildLog.length - 1] ?? null,
    });
    // Handed over: closing the sheet must no longer cancel it.
    set({ buildJob: null });
    useStore.getState().setSheet(null);
  },

  stopBuild() {
    const job = get().buildJob;
    if (job) void window.overdb.invoke('baseline:cancelBuild', job);
  },

  reposChanged() {
    const id = get().connectionId;
    if (!id) return;
    const { connections, envSets } = useStore.getState();
    const owner = repoLinkOwner(id, connections, envSets);
    const home = owner ? recipeHome(repoLinks(owner, connections, envSets)) : null;
    if (!home || home === get().repo) return;
    set({ repo: home, recipePath: `${home}/.overdb/baseline.json`, savedPath: null });
  },

  async measure() {
    const s = get();
    // Only the latest call owns the "measuring…" flag; any call that ends
    // without a count clears it.
    const seq = ++measureSeq;
    const done = () => set({ measuring: false });
    if (!s.connectionId || !s.snapshot || !s.tenant || s.tenants.length === 0) return done();
    const key = measureKey(s);
    if (s.measured?.for === key) return done();
    // The biggest table carrying the narrowest chosen key itself: the one
    // whose share says most about how much of the data is kept.
    const level = s.levels.filter((l) => (s.narrowing[tableKey(l.ref)] ?? []).length > 0).pop();
    const family = new Set(tenantTables(s.snapshot, level ? { ...level.ref, column: level.column } : s.tenant).map(tableKey));
    const values = level ? s.narrowing[tableKey(level.ref)].map((r) => r.key) : s.tenants.map((t) => t.key);
    const pick = plansFor({ ...s, measured: null })
      .filter((p) => p.action === 'scoped' && p.via.length === 1 && family.has(tableKey(p.via[0])) && (p.rows ?? 0) > 0)
      .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0];
    if (!pick) return done();
    set({ measuring: true });
    const res = await window.overdb
      .invoke('baseline:measure', { connectionId: s.connectionId, schema: pick.ref.schema, table: pick.ref.table, column: pick.via[0].column, values })
      .catch(() => ({ ok: false as const }));
    if (seq !== measureSeq) return;
    if (measureKey(get()) !== key) return done();
    set({ measuring: false, ...(res.ok ? { measured: { table: tableKey(pick.ref), rows: res.rows, total: pick.rows ?? 1, for: key } } : {}) });
  },

  async readCode() {
    const s = get();
    if (!s.connectionId || !s.snapshot) return;
    const plans = plansFor(s);
    const family = s.tenant ? new Set(tenantTables(s.snapshot, s.tenant).map(tableKey)) : new Set<string>();
    const off = new Set(s.linksOff);
    const ambiguous = s.links
      .filter((l) => l.source === 'name' && !l.audit && !off.has(linkKey(l)) && l.alternatives.length > 0)
      .filter((l) => ![l.to, ...l.alternatives].every((r) => family.has(tableKey(r))))
      .map((l) => ({ link: linkKey(l), alternatives: l.alternatives.map(tableKey) }));
    const unlinked = [...new Set(s.logins.flatMap((l) => l.hits.filter((h) => h.unlinked).map((h) => tableKey(h.ref))))];
    const input = {
      tenant: s.tenant ? `${tableKey(s.tenant)}(${s.tenant.column})` : null,
      startingPoints: startingPoints(s).map((p) => `${p.label} — ${tableKey(p.ref)}.${p.column}`),
      unlinkedLogins: unlinked,
      ambiguous,
      emptied: plans
        .filter((p) => p.action === 'empty' || p.action === 'review')
        .map((p) => ({ table: tableKey(p.ref), reason: p.reason })),
      schemas: s.schemasOn,
    };
    const jobId = crypto.randomUUID();
    set({ codeJob: jobId, codeSteps: [], codeError: null, reading: null, applied: [] });
    const res = await window.overdb.invoke('baseline:readCode', { jobId, connectionId: s.connectionId, input });
    if (get().codeJob !== jobId) return;
    if (!res.ok) {
      set({ codeJob: null, codeError: res.error });
      return;
    }
    const parsed = parseCodeReading(res.output, {
      links: new Set(s.links.map(linkKey)),
      tables: new Set(plans.map((p) => tableKey(p.ref))),
    });
    set('error' in parsed ? { codeJob: null, codeError: parsed.error } : { codeJob: null, reading: parsed });
  },

  stopReadCode() {
    const job = get().codeJob;
    if (job) void window.overdb.invoke('baseline:cancelReadCode', job);
    set({ codeJob: null });
  },

  codeStep(jobId, step) {
    if (get().codeJob !== jobId) return;
    set({ codeSteps: [...get().codeSteps, step].slice(-200) });
  },

  applyLink(v) {
    const off = get().linksOff.filter((k) => k !== v.link);
    set({ linksOff: v.verdict === 'off' ? [...off, v.link] : off, applied: [...get().applied, v.link], savedPath: null });
  },

  applyTable(t) {
    get().overrideTable(t.table, t.action);
    set({ applied: [...get().applied, t.table] });
  },

  applyAll() {
    const r = get().reading;
    if (!r) return;
    for (const v of r.links) if (!get().applied.includes(v.link)) get().applyLink(v);
    for (const t of r.tables) if (!get().applied.includes(t.table)) get().applyTable(t);
  },

  progress(jobId, p) {
    if (get().buildJob !== jobId) return;
    set({ buildLog: [...get().buildLog, p].slice(-400) });
  },
}));

/// Every login found, and the tenant rows they sit on that the person has
/// not already chosen, are part of the baseline.
export function startingPoints(
  s: Pick<BaselineState, 'tenant' | 'tenants' | 'logins'> & Partial<Pick<BaselineState, 'levels' | 'narrowing'>>,
): StartingPoint[] {
  const out: StartingPoint[] = [];
  if (s.tenant && s.tenants.length > 0) {
    out.push({
      ref: { schema: s.tenant.schema, table: s.tenant.table },
      column: s.tenant.column,
      values: s.tenants.map((t) => t.key),
      label: s.tenants.map((t) => t.label).join(', '),
      labels: s.tenants.map((t) => t.label),
    });
  }
  for (const lv of s.levels ?? []) {
    const rows = s.narrowing?.[tableKey(lv.ref)];
    if (!rows || rows.length === 0) continue;
    out.push({
      ref: lv.ref, column: lv.column, values: rows.map((r) => r.key), label: rows.map((r) => r.label).join(', '),
      labels: rows.map((r) => r.label), narrows: true,
    });
  }
  for (const l of s.logins) {
    const byTable = new Map<string, LoginHit[]>();
    for (const h of l.hits) byTable.set(tableKey(h.ref), [...(byTable.get(tableKey(h.ref)) ?? []), h]);
    for (const hits of byTable.values()) {
      out.push({ ref: hits[0].ref, column: hits[0].column, values: hits.map((h) => h.key), label: l.term.trim() });
    }
  }
  return out;
}

export function plansFor(
  s: Pick<
    BaselineState,
    'snapshot' | 'stats' | 'links' | 'linksOff' | 'tenant' | 'tenants' | 'logins' | 'overrides' | 'measured' | 'schemasOn' | 'levels' | 'narrowing'
  >,
): TablePlan[] {
  if (!s.snapshot) return [];
  const starts = startingPoints(s);
  const tenantKey = s.tenant ? tableKey(s.tenant) : null;
  const tenantRows = tenantKey ? s.stats.find((x) => tableKey(x) === tenantKey)?.rows ?? null : null;
  const kept = Math.max(1, s.tenants.length);
  return sortTables({
    snapshot: onlySchemas(s.snapshot, s.schemasOn),
    stats: s.stats,
    links: s.links,
    linksOff: new Set(s.linksOff),
    tenant: s.tenant,
    starts: starts.filter((p) => !p.narrows && (!tenantKey || tableKey(p.ref) !== tenantKey)).map((p) => p.ref),
    narrow: starts.filter((p) => p.narrows).map((p) => ({ ...p.ref, column: p.column })),
    keepShare: measuredShare(s) ?? (tenantRows ? Math.min(1, kept / tenantRows) : 0.01),
    overrides: s.overrides,
  });
}

/// The chosen tenants' real share of one big table, when it was measured
/// for the tenants chosen now.
export function measuredShare(s: Pick<BaselineState, 'measured' | 'tenants' | 'narrowing'>): number | null {
  const m = s.measured;
  if (!m || m.for !== measureKey(s) || m.total <= 0) return null;
  return Math.min(1, m.rows / m.total);
}

/// What a measurement was taken for: the tenants and every narrowing.
function measureKey(s: Pick<BaselineState, 'tenants' | 'narrowing'>): string {
  const n = Object.entries(s.narrowing).map(([k, rows]) => `${k}=${rows.map((r) => r.key).sort().join(',')}`).sort();
  return [s.tenants.map((t) => t.key).sort().join(','), ...n].join('|');
}
