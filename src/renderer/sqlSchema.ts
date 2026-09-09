// Turning an introspected schema into editor intelligence.
//
// This is the part of "hinting" that should never involve a model. The
// catalog is already on disk, exact, and free: a language model asked to
// complete a column name can only match it or hallucinate, and it takes
// 300ms to do either. Everything here is a dictionary lookup.

import { MariaSQL, MySQL, PostgreSQL, SQLite, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { SchemaSnapshot, TableInfo } from '@shared/types';
import { splitStatements, statementAt } from '@shared/sqlGuard';

export function dialectFor(snapshot: SchemaSnapshot | undefined): SQLDialect {
  if (!snapshot) return PostgreSQL;
  switch (snapshot.engine) {
    case 'sqlite':
      return SQLite;
    case 'mysql':
      // MariaDB and MySQL have drifted enough on keywords to be worth
      // distinguishing, and the server tells us which one it is.
      return /mariadb/i.test(snapshot.serverVersion) ? MariaSQL : MySQL;
    default:
      return PostgreSQL;
  }
}

/// Tables at the top level, columns beneath them. Column completions carry
/// their type as `detail`, so choosing between `create_date` and
/// `create_date_utc` doesn't require a trip to the schema tree.
/// Tables appear twice on purpose: nested under their schema so
/// `acme_cms.panel` resolves, and — for the ACTIVE schema only — flattened
/// to the top level so the common unqualified case still completes.
export function namespaceFor(
  snapshot: SchemaSnapshot | undefined,
  activeSchema?: string,
): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  if (!snapshot) return ns;

  const columnsOf = (table: TableInfo): Completion[] =>
    table.columns.map((c) => ({
      label: c.name,
      type: 'property',
      detail: c.typeName,
      // Primary keys sort first: they are what you join and filter on.
      boost: table.primaryKey.includes(c.name) ? 1 : 0,
    }));

  const active =
    activeSchema && snapshot.schemas.some((sc) => sc.name === activeSchema)
      ? activeSchema
      : snapshot.schemas[0]?.name;

  for (const schema of snapshot.schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const table of schema.tables) tables[table.name] = columnsOf(table);
    ns[schema.name] = tables;
    if (schema.name === active) Object.assign(ns, tables);
  }
  return ns;
}

/// Deliberately unset: namespaceFor already flattens the active schema's
/// tables to the top level, and setting defaultSchema as well makes
/// CodeMirror expect a prefix before it will complete them.
export function defaultSchemaName(_snapshot: SchemaSnapshot | undefined): string | undefined {
  return undefined;
}

interface JoinEdge {
  /// The table you'd be joining TO.
  target: string;
  /// A ready-made ON clause, built from the actual constraint.
  on: string;
}

/// Index every foreign key in both directions. A join is equally likely to
/// be written from either end, and only having the outgoing direction means
/// half the useful suggestions are missing.
function joinIndex(snapshot: SchemaSnapshot): Map<string, JoinEdge[]> {
  const index = new Map<string, JoinEdge[]>();
  const add = (from: string, edge: JoinEdge) => {
    const list = index.get(from) ?? [];
    if (!list.some((e) => e.target === edge.target && e.on === edge.on)) list.push(edge);
    index.set(from, list);
  };

  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      for (const fk of table.foreignKeys) {
        if (fk.columns.length !== fk.refColumns.length || fk.columns.length === 0) continue;
        const pairs = fk.columns.map(
          (c, i) => `${table.name}.${c} = ${fk.refTable}.${fk.refColumns[i]}`,
        );
        const on = pairs.join(' and ');
        add(table.name, { target: fk.refTable, on });
        add(fk.refTable, { target: table.name, on });
      }
    }
  }
  return index;
}

/// Tables already named in the query, so we suggest joins that connect to
/// what is actually there rather than every FK in the database.
export function tablesInQuery(sql: string): string[] {
  const found: string[] = [];
  // Each dotted segment can be quoted independently — `acme`.`panel_widget`
  // is the form MySQL emits, and a pattern that stops at the first closing
  // backtick silently resolves it to the schema name.
  const PART = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|\w+)`;
  const re = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${PART}(?:\.${PART})*)`, 'gi');
  for (const m of sql.matchAll(re)) {
    const name = m[1].replace(/[`"[\]]/g, '');
    const bare = name.includes('.') ? name.split('.').pop()! : name;
    if (bare && !found.includes(bare)) found.push(bare);
  }
  return found;
}

/// Completes `… join <cursor>` with the tables actually reachable by a
/// foreign key, ON clause included. This is the suggestion that feels like
/// intelligence and is pure constraint lookup — the model tier can't beat
/// it, because it already knows the answer exactly.
export function joinCompletionSource(
  snapshot: SchemaSnapshot | undefined,
): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!snapshot) return null;
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 240), ctx.pos);
    const m = /\bjoin\s+([\w]*)$/i.exec(before);
    if (!m) return null;
    if (!ctx.explicit && m[1].length === 0 && !/\bjoin\s$/i.test(before)) return null;

    const index = joinIndex(snapshot);
    const present = tablesInQuery(ctx.state.doc.toString());
    const options: Completion[] = [];

    for (const table of present) {
      for (const edge of index.get(table) ?? []) {
        // Don't offer a join to something already in the query.
        if (present.includes(edge.target)) continue;
        options.push({
          label: edge.target,
          type: 'class',
          detail: `on ${edge.on}`,
          info: `Foreign key between ${table} and ${edge.target}`,
          apply: `${edge.target} on ${edge.on}`,
          boost: 2,
        });
      }
    }
    if (options.length === 0) return null;
    return { from: ctx.pos - m[1].length, options, validFor: /^\w*$/ };
  };
}

/// Flat table list for the schema tree and the command palette.
export function allTables(snapshot: SchemaSnapshot | undefined): Array<{ schema: string; table: TableInfo }> {
  if (!snapshot) return [];
  return snapshot.schemas.flatMap((s) => s.tables.map((table) => ({ schema: s.name, table })));
}

export interface TableRef {
  table: string;
  alias?: string;
}

/// Words that can follow a table name and are NOT an alias. Without this,
/// `from orders where ...` reads "where" as the alias and every qualified
/// completion afterwards resolves against nothing.
const NOT_AN_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'on',
  'group', 'order', 'limit', 'having', 'union', 'set', 'values', 'using',
  'straight_join', 'natural', 'for', 'window', 'offset', 'into', 'as',
]);

/// The tables in scope for a statement, with their aliases. This is what
/// makes `pw.` complete panel_widget's columns rather than guessing.
export function parseTableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = [];
  const PART = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|\w+)`;
  // The alias group must REFUSE keywords via lookahead rather than matching
  // them and discarding afterwards: matchAll resumes at the end of the whole
  // match, so an alias group that swallowed `join` consumed the very keyword
  // the next table needed, and `from a join b` only ever found `a`.
  const keywords = [...NOT_AN_ALIAS].join('|');
  const re = new RegExp(
    String.raw`\b(?:from|join|update|into)\s+(${PART}(?:\.${PART})*)` +
      String.raw`(?:\s+(?:as\s+)?(?!(?:${keywords})\b)(\w+))?`,
    'gi',
  );
  for (const m of sql.matchAll(re)) {
    const full = m[1].replace(/[`"[\]]/g, '');
    const table = full.includes('.') ? full.split('.').pop()! : full;
    if (!table) continue;
    const alias = m[2];
    if (refs.some((r) => r.table === table && r.alias === alias)) continue;
    // Omit the key entirely rather than setting it undefined, so callers
    // (and tests) see a clean shape.
    refs.push(alias ? { table, alias } : { table });
  }
  return refs;
}

function findTable(snapshot: SchemaSnapshot, name: string): TableInfo | undefined {
  for (const schema of snapshot.schemas) {
    const hit = schema.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit && hit.columns.length > 0) return hit;
  }
  return undefined;
}

function columnCompletions(table: TableInfo, qualifierShown: boolean): Completion[] {
  return table.columns.map((c) => ({
    label: c.name,
    type: 'property',
    detail: qualifierShown ? c.typeName : `${c.typeName} · ${table.name}`,
    // Primary keys first: they are what you filter and join on.
    boost: table.primaryKey.includes(c.name) ? 3 : 2,
  }));
}

/// Completes columns of whatever tables the CURRENT STATEMENT has in scope,
/// and resolves `alias.` against that statement's aliases.
///
/// CodeMirror's own schema source only completes unqualified columns when
/// handed a single `defaultTable` — it does not read the FROM clause. In a
/// join, or anywhere the user has aliased, that is not enough, which is why
/// this exists rather than a config option.
export function columnCompletionSource(snapshot: SchemaSnapshot | undefined): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!snapshot) return null;

    const doc = ctx.state.doc.toString();
    const statements = splitStatements(doc, snapshot.engine);
    const here = statementAt(statements, ctx.pos);
    // Scope to the statement under the cursor: a buffer holding three
    // queries should not offer the third one's columns while you edit the
    // first.
    const local = here ? doc.slice(here.start, here.end) : doc;
    const refs = parseTableRefs(local);
    if (refs.length === 0) return null;

    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 160), ctx.pos);

    // `alias.` or `table.` — resolve against this statement's refs first.
    const qualified = /([A-Za-z_]\w*)\.(\w*)$/.exec(before);
    if (qualified) {
      const [, qualifier, typed] = qualified;
      const ref =
        refs.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase()) ??
        refs.find((r) => r.table.toLowerCase() === qualifier.toLowerCase());
      if (!ref) return null;
      const table = findTable(snapshot, ref.table);
      if (!table) return null;
      return {
        from: ctx.pos - typed.length,
        options: columnCompletions(table, true),
        validFor: /^\w*$/,
      };
    }

    const word = ctx.matchBefore(/\w+/);
    if (!word && !ctx.explicit) return null;

    // Unqualified: every column in scope, tagged with the table it came
    // from so two `name` columns stay tellable apart.
    const options: Completion[] = [];
    for (const ref of refs) {
      const table = findTable(snapshot, ref.table);
      if (!table) continue;
      options.push(...columnCompletions(table, false));
      if (ref.alias) {
        options.push({ label: ref.alias, type: 'class', detail: table.name, boost: 1 });
      }
    }
    if (options.length === 0) return null;
    return { from: word?.from ?? ctx.pos, options, validFor: /^\w*$/ };
  };
}
