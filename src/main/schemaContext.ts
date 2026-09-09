// Choosing what schema to put in a prompt.
//
// A 900-table catalog is megabytes of DDL and no model wants it. The
// dominant failure of NL→SQL is not that the model is stupid, it is that the
// one table it needed wasn't in the context — and that failure is invisible,
// so the user just concludes the feature doesn't work.
//
// So: compact every table to one line, score against the question, follow
// one hop of foreign keys (joins are the entire point), and say out loud
// which tables were included.
//
// Row data NEVER enters a prompt. This module takes a SchemaSnapshot and has
// no adapter reference, so it structurally cannot read one.

import type { SchemaSnapshot, TableInfo } from '../shared/types';

/// About 6k tokens of schema. Enough for a wide join, small enough to leave
/// the model room to think.
const BUDGET_BYTES = 24 * 1024;

export function compactTable(schema: string, table: TableInfo, qualify: boolean): string {
  const name = qualify ? `${schema}.${table.name}` : table.name;
  const cols = table.columns.map((c) => `${c.name} ${c.typeName}`).join(', ');
  const pk = table.primaryKey.length ? ` PK(${table.primaryKey.join(',')})` : '';
  const fks = table.foreignKeys
    .map((f) => ` FK(${f.columns.join(',')}->${f.refTable}.${f.refColumns.join(',')})`)
    .join('');
  return `${name}(${cols})${pk}${fks}`;
}

/// snake_case, camelCase and dotted names all split into comparable words.
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 2),
  );
}

function scoreTable(question: Set<string>, table: TableInfo): number {
  const words = tokenize(`${table.name} ${table.columns.map((c) => c.name).join(' ')}`);
  let hits = 0;
  for (const w of words) if (question.has(w)) hits += 1;
  // Table-name matches count for more than an incidental column match.
  const nameHits = [...tokenize(table.name)].filter((w) => question.has(w)).length;
  return hits + nameHits * 3;
}

export interface SchemaContext {
  text: string;
  included: string[];
  totalTables: number;
}

/// How many tables the question itself can nominate. Capped because in a
/// 400-table schema a common word like "name" or "id" scores against half
/// the database, and an unbounded seed set crowds out the joins.
const MAX_SEEDS = 12;

export function buildSchemaContext(
  snapshot: SchemaSnapshot | undefined,
  question: string,
  opts: { activeSchema?: string; editorText?: string } = {},
): SchemaContext {
  if (!snapshot) return { text: '', included: [], totalTables: 0 };

  const all: Array<{ schema: string; table: TableInfo }> = snapshot.schemas.flatMap((s) =>
    s.tables.map((table) => ({ schema: s.name, table })),
  );
  // Tables with no columns are placeholders from the cheap cross-schema
  // index; they would contribute a bare name and no useful shape.
  const usable = all.filter((t) => t.table.columns.length > 0);

  const words = tokenize(`${question} ${opts.editorText ?? ''}`);
  const scored = usable
    .map((t) => ({ ...t, score: scoreTable(words, t.table) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score);

  const key = (schema: string, table: string) => `${schema}.${table}`;
  const byName = new Map(usable.map((t) => [t.table.name, t]));

  const seeds = scored.slice(0, MAX_SEEDS);
  // Nothing matched — give the model something rather than nothing, so it
  // can at least ask a sensible follow-up.
  const fallback = seeds.length === 0 ? usable.slice(0, MAX_SEEDS) : [];

  const ordered: Array<{ schema: string; table: TableInfo }> = [];
  const seen = new Set<string>();
  const add = (entry: { schema: string; table: TableInfo }): void => {
    const k = key(entry.schema, entry.table.name);
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push(entry);
  };

  // Each seed is followed IMMEDIATELY by its foreign-key neighbours, in both
  // directions. Appending neighbours at the end instead meant the byte
  // budget truncated exactly the join targets the question needed — which is
  // how "the client table isn't in the schema I was given" happens while
  // `client` sits right there in the database, one FK from `panel_widget`.
  for (const seed of [...seeds, ...fallback]) {
    add(seed);
    for (const fk of seed.table.foreignKeys) {
      const target = byName.get(fk.refTable);
      if (target) add(target);
    }
    for (const other of usable) {
      if (other.table.foreignKeys.some((f) => f.refTable === seed.table.name)) add(other);
    }
  }
  // Anything else that scored, in rank order, to fill the remaining budget.
  for (const entry of scored.slice(MAX_SEEDS)) add(entry);

  const qualify = snapshot.schemas.length > 1;
  const lines: string[] = [];
  const included: string[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const line = compactTable(entry.schema, entry.table, qualify);
    if (bytes + line.length > BUDGET_BYTES) break;
    bytes += line.length + 1;
    lines.push(line);
    included.push(qualify ? `${entry.schema}.${entry.table.name}` : entry.table.name);
  }

  const header = [
    `-- engine: ${snapshot.engine} ${snapshot.serverVersion}`,
    opts.activeSchema ? `-- active schema: ${opts.activeSchema}` : null,
    `-- context: ${included.length} of ${usable.length} tables`,
  ]
    .filter(Boolean)
    .join('\n');

  return { text: `${header}\n${lines.join('\n')}`, included, totalTables: usable.length };
}
