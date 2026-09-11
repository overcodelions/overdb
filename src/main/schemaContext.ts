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

export function compactTable(
  schema: string,
  table: TableInfo,
  qualify: boolean,
  opts: { indexes?: boolean; quoteName?: boolean } = {},
): string {
  // A DynamoDB table may be called `LOCAL.event-log-v2`. Written bare in the
  // prompt it reads as a schema qualifier, and the model then writes
  // FROM "LOCAL"."event-log-v2" — which PartiQL takes as an INDEX reference
  // and rejects. The quotes are the whole difference, so they are here.
  const name = qualify ? `${schema}.${table.name}` : opts.quoteName ? `"${table.name}"` : table.name;
  const cols = table.columns.map((c) => `${c.name} ${c.typeName}`).join(', ');
  const pk = table.primaryKey.length ? ` PK(${table.primaryKey.join(',')})` : '';
  const fks = table.foreignKeys
    .map((f) => ` FK(${f.columns.join(',')}->${f.refTable}.${f.refColumns.join(',')})`)
    .join('');
  // Indexes are noise in a relational prompt and the entire answer in a
  // DynamoDB one, where choosing the right index IS the query.
  const idx = opts.indexes
    ? table.indexes.map((i) => ` INDEX ${i.name}(${i.columns.join(',')})`).join('')
    : '';
  return `${name}(${cols})${pk}${fks}${idx}`;
}

/// snake_case, camelCase and dotted names all split into comparable words.
///
/// Singular forms are added alongside plurals on both sides. People ask for
/// "my latest events" and the table is `event_log`; a set-intersection score
/// with no stemming at all calls that a miss, and a miss here reads to the
/// user as "the AI can't see my database".
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((x) => x.toLowerCase())
    .filter((x) => x.length > 2)) {
    out.add(w);
    if (w.length > 4 && w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
  }
  return out;
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

/// Table names in schemas we did NOT introspect. Names only — one cheap
/// catalog query already produces them for cross-schema completion.
export interface ElsewhereTable {
  schema: string;
  table: string;
}

/// At most this many "it might be over there" hints. The point is to let
/// the model say `acme.panel_widget` instead of "no such table"; a long
/// list would just spend budget the real schema needs.
const MAX_ELSEWHERE = 20;

export function buildSchemaContext(
  snapshot: SchemaSnapshot | undefined,
  question: string,
  opts: {
    activeSchema?: string;
    editorText?: string;
    elsewhere?: ElsewhereTable[];
    /// Qualified `schema.table`, or a bare table name. These go in whether
    /// or not they score, ahead of everything the scorer chose, and they are
    /// the user's override on a selection that is otherwise a guess.
    pinned?: string[];
    /// Include each table's indexes. Off by default — they are noise in a
    /// prompt about what to SELECT — and essential in a prompt about why
    /// something is slow, where an answer that proposes an index the table
    /// already has reads as the feature not knowing the database.
    indexes?: boolean;
  } = {},
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

  // Pins first, and they are not scored. Once you have told us which table
  // you mean, the scorer has nothing left to decide — and a pin that could
  // still lose to a keyword match would not be an override at all.
  const wantPinned = new Set((opts.pinned ?? []).map((p) => p.toLowerCase()));
  const pins = usable.filter(
    (t) =>
      wantPinned.has(`${t.schema}.${t.table.name}`.toLowerCase()) ||
      wantPinned.has(t.table.name.toLowerCase()),
  );

  const seeds = scored.slice(0, MAX_SEEDS);
  // Nothing matched — give the model something rather than nothing, so it
  // can at least ask a sensible follow-up. Pins count as a match: if you
  // named the table yourself, an arbitrary first-twelve is noise.
  const fallback = seeds.length === 0 && pins.length === 0 ? usable.slice(0, MAX_SEEDS) : [];

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
  for (const seed of [...pins, ...seeds, ...fallback]) {
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

  // Qualify as soon as more than one schema is in play. Bare names across
  // two schemas are ambiguous to the model in exactly the way they are
  // ambiguous to the server.
  const qualify = snapshot.schemas.length > 1;
  const lines: string[] = [];
  const included: string[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const line = compactTable(entry.schema, entry.table, qualify, {
      indexes: opts.indexes || snapshot.engine === 'dynamodb',
      quoteName: snapshot.engine === 'dynamodb',
    });
    if (bytes + line.length > BUDGET_BYTES) break;
    bytes += line.length + 1;
    lines.push(line);
    included.push(qualify ? `${entry.schema}.${entry.table.name}` : entry.table.name);
  }

  // Tables that match the question but whose shape is not in the context.
  // Without this the model's only honest answer to "the panel widgets" while
  // connected to a schema without that table is "there isn't one" — when it
  // is sitting in the next database over, and naming it is the whole answer.
  //
  // The test is per TABLE, not per schema. Filtering by schema name assumed
  // a schema is introspected all-or-nothing, which is false wherever a
  // describe budget bites: DynamoDB puts every table in one pseudo-schema
  // (the region) and describes the first 60 of them, so a schema-level test
  // silently discarded the names of the other 168 — and the model then says
  // "I don't see an events table" about a table that is right there.
  const covered = new Set(usable.map((t) => key(t.schema, t.table.name).toLowerCase()));
  // A pinned table whose shape we could not load still gets named. Saying
  // "this table exists and here is its name" beats dropping it, which would
  // make the pin look ignored.
  const pinnedHint = (schema: string, table: string): boolean =>
    wantPinned.has(key(schema, table).toLowerCase()) || wantPinned.has(table.toLowerCase());
  const hints = (opts.elsewhere ?? [])
    .filter((e) => !covered.has(key(e.schema, e.table).toLowerCase()))
    .map((e) => ({
      ...e,
      pinned: pinnedHint(e.schema, e.table),
      score: [...tokenize(e.table)].filter((w) => words.has(w)).length,
    }))
    .filter((e) => e.score > 0 || e.pinned)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.score - a.score || a.table.length - b.table.length,
    )
    .slice(0, MAX_ELSEWHERE);

  // DynamoDB's pseudo-schema is the REGION, and a region is not a qualifier
  // you can write: `FROM "us-east-1"."orders"` means the index `orders` on a
  // table called `us-east-1`, which is a lookup that fails. So these are
  // listed bare on that engine, with the instruction that matches.
  const dynamo = snapshot.engine === 'dynamodb';
  const elsewhereBlock = hints.length
    ? `\n-- also on this connection and matching the request, shape not loaded${
        dynamo ? ' — name directly in FROM:' : ' — qualify to use:'
      }\n` +
      hints.map((h) => `-- ${dynamo ? `"${h.table}"` : `${h.schema}.${h.table}`}`).join('\n')
    : '';

  // Count every table we know exists, not just the ones with a loaded
  // shape. "12 of 60" while the connection holds 228 tables is a number the
  // model repeats back to the user as if it were the size of their database.
  const totalTables = new Set([
    ...all.map((t) => key(t.schema, t.table.name).toLowerCase()),
    ...(opts.elsewhere ?? []).map((e) => key(e.schema, e.table).toLowerCase()),
  ]).size;

  const header = [
    `-- engine: ${snapshot.engine} ${snapshot.serverVersion}`,
    opts.activeSchema ? `-- active schema: ${opts.activeSchema}` : null,
    `-- context: ${included.length} of ${totalTables} tables`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text: `${header}\n${lines.join('\n')}${elsewhereBlock}`,
    included,
    totalTables,
  };
}
