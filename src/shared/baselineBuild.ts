// From a reviewed recipe to the steps that build a baseline: which tables
// to create, how each one's rows are chosen, in what order, and which
// foreign keys to complete afterwards. Pure — the builder process carries
// it out. See docs/design/baselines.md.

import type { SchemaSnapshot } from './types';
import {
  findLinks,
  linkKey,
  tableKey,
  tenantTables,
  type BaselineRecipe,
  type TableAction,
  type TablePlan,
  type TableRef,
} from './baseline';

/// How a table's rows are chosen.
///   none    — created empty.
///   all     — every row.
///   keys    — rows whose `column` is one of `values`: a starting point.
///   follows — rows whose `column` holds the `refColumn` of a row already
///             copied into `parent`. Parents are copied first.
export type RowRule =
  | { kind: 'none' }
  | { kind: 'all' }
  | {
      kind: 'keys';
      column: string;
      values: string[];
      /// A login table is a starting point AND belongs to the tenant: its
      /// login rows, plus every row it would keep anyway — all of the
      /// client's users, not only yours.
      also?: FollowRule;
    }
  | ({ kind: 'follows' } & FollowRule);

export interface FollowRule {
  column: string;
  parent: TableRef;
  refColumn: string;
  /// Polymorphic: only rows whose type column names the parent's table.
  when?: { column: string; value: string };
  /// The other tables the same polymorphic pair points at that the
  /// baseline keeps rows of — comments on kept posts AND kept projects.
  more?: FollowRule[];
  /// Following a narrowed level — the chosen partners — a row with no
  /// partner at all is the tenant's own (its staff, its settings) and is
  /// kept too, by the tenant column alongside it.
  orUnassigned?: { column: string; parent: TableRef; refColumn: string };
}

export interface BuildTable {
  ref: TableRef;
  action: TableAction;
  rows: RowRule;
  /// Copy order: starting points and whole tables at 0, then each table one
  /// hop further from a starting point than the one it follows.
  layer: number;
}

/// A real foreign key whose missing parents are fetched after the copy, so
/// the baseline holds no row pointing at nothing. Only into tables that
/// take rows by rule — a log table stays empty even when something points
/// at it.
export interface FillParents {
  child: TableRef;
  column: string;
  parent: TableRef;
  refColumn: string;
  /// A polymorphic link: only the child rows whose type names this parent.
  when?: { column: string; value: string };
}

export interface BuildPlan {
  schemas: string[];
  /// Every table that is created, in copy order. Left-out tables are absent.
  tables: BuildTable[];
  fills: FillParents[];
  warnings: string[];
}

const FILLABLE: ReadonlySet<TableAction> = new Set(['scoped', 'review']);

export function buildPlan(recipe: BaselineRecipe, plans: TablePlan[], snapshot: SchemaSnapshot): BuildPlan {
  const warnings: string[] = [];

  // Starting points by table: the tenant's own table and its namesakes take
  // the tenant's keys; every other starting point brings its own.
  const keys = new Map<string, { column: string; values: Set<string> }>();
  const addKeys = (ref: TableRef, column: string, values: string[]) => {
    const k = tableKey(ref);
    const entry = keys.get(k) ?? { column, values: new Set<string>() };
    if (entry.column !== column) {
      warnings.push(`${k} is a starting point by both ${entry.column} and ${column}; using ${entry.column}.`);
      return;
    }
    values.forEach((v) => entry.values.add(v));
    keys.set(k, entry);
  };
  const tenantStart = recipe.tenant ? recipe.starts.find((s) => tableKey(s.ref) === tableKey(recipe.tenant!)) : undefined;
  if (recipe.tenant && tenantStart) {
    for (const ref of tenantTables(snapshot, recipe.tenant)) addKeys(ref, recipe.tenant.column, tenantStart.values);
  }
  for (const s of recipe.starts) {
    if (s === tenantStart) continue;
    // A narrowed level's namesakes in other schemas narrow with it.
    const refs = s.narrows ? tenantTables(snapshot, { ...s.ref, column: s.column }) : [s.ref];
    for (const ref of refs) addKeys(ref, s.column, s.values);
  }

  // Tables standing for a narrowed level, and for the tenant, with their
  // namesakes — to tell when a rule follows a narrowed level, and how the
  // same table also reaches the tenant.
  const narrowed = new Set(
    recipe.starts.filter((s) => s.narrows).flatMap((s) => tenantTables(snapshot, { ...s.ref, column: s.column })).map(tableKey),
  );
  const tenantFamily = new Set(recipe.tenant ? tenantTables(snapshot, recipe.tenant).map(tableKey) : []);
  const off = new Set(recipe.linksOff);
  const usable = [...findLinks(snapshot), ...(recipe.extraLinks ?? [])].filter(
    (l) => !l.audit && l.columns.length === 1 && !off.has(linkKey(l)),
  );
  const kept = new Set(plans.filter((p) => p.action === 'scoped' || p.action === 'whole').map((p) => tableKey(p.ref)));
  const toTenant = new Map(usable.filter((l) => tenantFamily.has(tableKey(l.to))).map((l) => [tableKey(l.from), l] as const));
  const toLevel = new Map(usable.filter((l) => narrowed.has(tableKey(l.to))).map((l) => [tableKey(l.from), l] as const));
  /// How a table reaches the tenant on its own: through a narrowed level
  /// when it carries one (keeping the tenant's unassigned rows), else
  /// directly.
  const ownRule = (k: string): FollowRule | undefined => {
    const lv = toLevel.get(k);
    const up = toTenant.get(k);
    if (lv) {
      return {
        column: lv.columns[0], parent: lv.to, refColumn: lv.refColumns[0],
        ...(up ? { orUnassigned: { column: up.columns[0], parent: up.to, refColumn: up.refColumns[0] } } : {}),
      };
    }
    return up ? { column: up.columns[0], parent: up.to, refColumn: up.refColumns[0] } : undefined;
  };

  const tables: BuildTable[] = [];
  for (const p of plans) {
    if (p.action === 'skip') continue;
    const k = tableKey(p.ref);
    let rows: RowRule = { kind: 'none' };
    let layer = 0;
    const start = keys.get(k);
    if (p.action === 'whole') {
      rows = { kind: 'all' };
    } else if (p.action === 'scoped' && start) {
      rows = { kind: 'keys', column: start.column, values: [...start.values].sort() };
      // The tenant's own tables and a narrowed level are their own answer;
      // any other starting point also keeps what the tenant would.
      const also = tenantFamily.has(k) || narrowed.has(k) ? undefined : ownRule(k);
      if (also) {
        rows.also = also;
        layer = 1;
      }
    } else if (p.action === 'scoped' && p.via.length > 0) {
      const step = p.via[0];
      const parent = { schema: step.schema, table: step.table };
      rows = { kind: 'follows', column: step.column, parent, refColumn: step.refColumn };
      if (step.when) {
        rows.when = step.when;
        const more = usable
          .filter(
            (l) =>
              l.when && tableKey(l.from) === k && l.columns[0] === step.column && kept.has(tableKey(l.to)) &&
              !(tableKey(l.to) === tableKey(parent) && l.when.value === step.when!.value),
          )
          .map((l) => ({ column: l.columns[0], parent: l.to, refColumn: l.refColumns[0], when: l.when }));
        if (more.length) rows.more = more;
      }
      const up = narrowed.has(tableKey(parent)) ? toTenant.get(k) : undefined;
      if (up && rows.kind === 'follows') {
        rows.orUnassigned = { column: up.columns[0], parent: up.to, refColumn: up.refColumns[0] };
      }
      layer = p.via.length;
    } else if (p.action === 'scoped') {
      warnings.push(`${k} is set to keep rows for your starting points, but nothing ties it to one. It will be created empty.`);
    }
    tables.push({ ref: p.ref, action: p.action, rows, layer });
  }
  tables.sort((a, b) => a.layer - b.layer || (tableKey(a.ref) < tableKey(b.ref) ? -1 : 1));

  const byKey = new Map(tables.map((t) => [tableKey(t.ref), t]));
  const fills: FillParents[] = [];
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      if (t.kind !== 'table') continue;
      const child = byKey.get(tableKey({ schema: s.name, table: t.name }));
      if (!child || child.rows.kind === 'none') continue;
      for (const fk of t.foreignKeys) {
        if (fk.columns.length !== 1) continue;
        const parentRef = { schema: fk.refSchema ?? s.name, table: fk.refTable };
        const parent = byKey.get(tableKey(parentRef));
        if (!parent || !FILLABLE.has(parent.action) || tableKey(parentRef) === tableKey(child.ref)) continue;
        fills.push({ child: child.ref, column: fk.columns[0], parent: parentRef, refColumn: fk.refColumns[0] });
      }
    }
  }

  // Polymorphic links complete the same way, type by type: a kept comment
  // on a template the sort did not keep fetches that template.
  for (const l of recipe.extraLinks ?? []) {
    if (!l.when || l.columns.length !== 1 || off.has(linkKey(l))) continue;
    const child = byKey.get(tableKey(l.from));
    const parent = byKey.get(tableKey(l.to));
    if (!child || child.rows.kind === 'none' || !parent || !FILLABLE.has(parent.action)) continue;
    fills.push({ child: child.ref, column: l.columns[0], parent: l.to, refColumn: l.refColumns[0], when: l.when });
  }

  const schemas = [...new Set(tables.map((t) => t.ref.schema))].sort();
  return { schemas, tables, fills, warnings };
}

/// One line per stage, for the build's progress log and its report.
export interface BuildProgress {
  stage: 'start' | 'users' | 'schemas' | 'tables' | 'rows' | 'parents' | 'objects' | 'finish';
  text: string;
  /// Tables done of the stage's total, where it counts tables.
  done?: number;
  total?: number;
}

export interface BuildReport {
  tables: number;
  rows: number;
  /// Rows copied per table, by tableKey, for the ones that took any.
  copied: Record<string, number>;
  /// Parent rows fetched to complete foreign keys.
  filled: number;
  /// What could not be recreated — a view over a left-out table, a
  /// routine the server refused — with the server's reason.
  skipped: Array<{ what: string; reason: string }>;
  durationMs: number;
}
