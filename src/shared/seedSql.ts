// What a model hands back in the seed flow, and what overdb checks before
// anyone sees it.
//
// Two answers come back, at two points in the flow:
//
//   * the INVESTIGATION — findings and a plan in plain words, as one JSON
//     block. No SQL exists at this point, deliberately: a person can check
//     "one gold customer with a $50.00 order" in a second, and cannot check
//     forty INSERTs.
//   * the SCRIPT — a seed, a teardown and a verify query, as three fenced
//     SQL blocks. Fences rather than JSON strings, because SQL escaped into
//     JSON is where models make their mistakes.
//
// Everything here is pure and runs in main before the answer reaches the
// window, so the renderer is only ever handed a script that passed. None of
// it is a security boundary — the write gate and the server are — but it is
// what makes "only INSERTs, parents before children, every column real" a
// fact on the screen rather than a hope.

import { classify, splitStatements } from './sqlGuard';
import type { Engine, SchemaSnapshot, TableInfo } from './types';

// ---- the need -----------------------------------------------------------

/// A ticket key with little else around it — "RED-12 seed my db" — which the
/// model has no way to open. Null when the need says enough on its own.
export function bareTicketKey(need: string): string | null {
  const key = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/.exec(need)?.[0];
  if (!key) return null;
  const words = need.replace(key, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length < 15 ? key : null;
}

// ---- the investigation --------------------------------------------------

export type FindingSource = 'code' | 'schema';

export interface SeedFinding {
  source: FindingSource;
  text: string;
  /// `path:line` for code, the constraint for schema. Optional: a model
  /// that cannot cite should not be made to invent a citation.
  ref?: string;
}

export interface SeedPlanRow {
  label: string;
  detail?: string;
}

export interface SeedPlanGroup {
  table: string;
  rows: SeedPlanRow[];
}

export interface SeedPlan {
  summary: string;
  groups: SeedPlanGroup[];
  /// Things the plan relies on that neither the schema nor the code
  /// settled. Shown first, because they are what a person must check.
  assumptions: string[];
  /// A sentence about reusing existing rows — "reuses 2 of your products".
  note?: string;
}

export interface SeedInvestigation {
  findings: SeedFinding[];
  plan: SeedPlan;
  /// How the new rows can be found again for teardown.
  marker: string;
}

const MAX_TEXT = 600;
const MAX_ITEMS = 40;

function text(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : [];
}

/// The last ```json block, or failing that the outermost {...} in the text.
/// Models put prose around JSON however firmly they are told not to.
function jsonBody(raw: string): string | null {
  const fenced = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const block = fenced.filter((b) => b.startsWith('{')).pop();
  if (block) return block;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}

export function parseInvestigation(raw: string): SeedInvestigation | { error: string } {
  const body = jsonBody(raw);
  if (!body) return { error: 'The model did not return a plan.' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { error: 'The model’s plan was not valid JSON.' };
  }
  const plan = (data.plan ?? {}) as Record<string, unknown>;

  const findings: SeedFinding[] = list(data.findings)
    .map((f) => f as Record<string, unknown>)
    .map((f) => ({
      source: (f.source === 'code' ? 'code' : 'schema') as FindingSource,
      text: text(f.text),
      ref: text(f.ref, 200) || undefined,
    }))
    .filter((f) => f.text);

  const groups: SeedPlanGroup[] = list(plan.groups)
    .map((g) => g as Record<string, unknown>)
    .map((g) => ({
      table: text(g.table, 120),
      rows: list(g.rows)
        .map((r) => r as Record<string, unknown>)
        .map((r) => ({ label: text(r.label, 200), detail: text(r.detail) || undefined }))
        .filter((r) => r.label),
    }))
    .filter((g) => g.table && g.rows.length);

  if (!groups.length) return { error: 'The model’s plan has no rows in it.' };

  return {
    findings,
    plan: {
      summary: text(plan.summary, 1200),
      groups,
      assumptions: list(plan.assumptions).map((a) => text(a)).filter(Boolean),
      note: text(plan.note) || undefined,
    },
    marker: text(data.marker) || 'No marker was described.',
  };
}

// ---- the script ---------------------------------------------------------

export interface SeedScript {
  seed: string;
  teardown: string;
  verify: string;
}

/// The three fenced blocks, found by the word after the language tag
/// (```sql seed). Falls back to order when the labels are missing, because
/// a script in the right shape with the wrong fence info is still a script.
export function parseScript(raw: string): SeedScript | { error: string } {
  const blocks = [...raw.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((m) => ({
    info: m[1].trim().toLowerCase(),
    body: m[2].trim(),
  }));
  const find = (name: string) => blocks.find((b) => new RegExp(`\\b${name}\\b`).test(b.info))?.body;
  let seed = find('seed');
  let teardown = find('teardown');
  let verify = find('verify');
  if (!seed && !teardown && !verify && blocks.length >= 3) {
    [seed, teardown, verify] = blocks.map((b) => b.body);
  }
  if (!seed) return { error: 'The model did not return a seed script.' };
  if (!teardown) return { error: 'The model did not return a teardown script.' };
  return { seed, teardown, verify: verify ?? '' };
}

// ---- checking it --------------------------------------------------------

export interface SeedInsert {
  sql: string;
  /// As written, unquoted.
  table: string;
  /// VALUES tuples — what `affectedRows` should come back as.
  rows: number;
}

export interface SeedScriptCheck {
  ok: boolean;
  problems: string[];
  inserts: SeedInsert[];
  deletes: string[];
  verify: string | null;
  /// Rows per table, in the order they are inserted.
  perTable: Array<{ table: string; rows: number }>;
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*(--|#)[^\n]*/g, '$1')
    .trim();
}

function unquote(ident: string): string {
  const t = ident.trim();
  if (/^(["`\[]).*(["`\]])$/.test(t)) return t.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`');
  return t;
}

/// `schema.table` or `table`, each part possibly quoted.
function splitName(name: string): { schema: string | null; table: string } {
  const parts = name.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^.\s]+/g) ?? [name];
  if (parts.length >= 2) return { schema: unquote(parts[parts.length - 2]), table: unquote(parts[parts.length - 1]) };
  return { schema: null, table: unquote(parts[0]) };
}

const NAME = String.raw`((?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\w$]+))?)`;
const INSERT_RE = new RegExp(String.raw`^insert\s+into\s+${NAME}\s*\(([^)]*)\)\s*values\s*([\s\S]*)$`, 'i');
const DELETE_RE = new RegExp(String.raw`^delete\s+from\s+${NAME}\s+where\s+\S`, 'i');

/// Top-level parenthesised groups in a VALUES list. A scanner rather than a
/// regex, because a string literal may hold a parenthesis or a quote.
export function countTuples(values: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const ch = values[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i += 1;
      while (i < values.length) {
        if (values[i] === '\\' && q === "'") i += 1;
        else if (values[i] === q) {
          if (values[i + 1] === q) i += 1;
          else break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      if (depth === 0) count += 1;
      depth += 1;
    } else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return count;
}

function findTable(snapshot: SchemaSnapshot, name: { schema: string | null; table: string }, activeSchema: string | null): TableInfo | null {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const schemas = name.schema
    ? snapshot.schemas.filter((s) => eq(s.name, name.schema!))
    : [
        ...snapshot.schemas.filter((s) => activeSchema && eq(s.name, activeSchema)),
        ...snapshot.schemas.filter((s) => !activeSchema || !eq(s.name, activeSchema)),
      ];
  for (const s of schemas) {
    const t = s.tables.find((x) => eq(x.name, name.table) && x.kind === 'table');
    if (t) return t;
  }
  return null;
}

/// Parents a table points at, by unqualified name, excluding itself.
function parentsOf(table: TableInfo): string[] {
  return table.foreignKeys.map((fk) => fk.refTable.toLowerCase()).filter((p) => p !== table.name.toLowerCase());
}

export function checkSeedScript(
  script: SeedScript,
  snapshot: SchemaSnapshot,
  engine: Engine,
  activeSchema: string | null = null,
): SeedScriptCheck {
  const problems: string[] = [];
  const inserts: SeedInsert[] = [];
  const inserted: string[] = [];

  const seedStatements = splitStatements(script.seed, engine).map((s) => stripComments(s.sql)).filter(Boolean);
  if (!seedStatements.length) problems.push('The seed script is empty.');

  for (const sql of seedStatements) {
    const m = INSERT_RE.exec(sql);
    if (!m) {
      const head = sql.split(/\s+/).slice(0, 3).join(' ');
      problems.push(`Only INSERT … VALUES statements may seed; found “${head}…”.`);
      continue;
    }
    // An upsert overwrites rows the seed does not own.
    if (/\bon\s+(conflict|duplicate\s+key)\b[\s\S]*\bupdate\b/i.test(m[3])) {
      problems.push(`The insert into ${m[1]} updates existing rows on conflict.`);
    }
    const name = splitName(m[1]);
    const table = findTable(snapshot, name, activeSchema);
    if (!table) {
      problems.push(`There is no table ${name.table}.`);
      continue;
    }
    const columns = m[2].split(',').map((c) => unquote(c)).filter(Boolean);
    const known = new Set(table.columns.map((c) => c.name.toLowerCase()));
    const missing = columns.filter((c) => !known.has(c.toLowerCase()));
    if (missing.length) problems.push(`${table.name} has no column ${missing.join(', ')}.`);

    const late = parentsOf(table).filter(
      (p) => !inserted.includes(p) && seedStatements.some((s) => {
        const other = INSERT_RE.exec(s);
        return other && splitName(other[1]).table.toLowerCase() === p;
      }),
    );
    if (late.length) problems.push(`${table.name} is inserted before its parent ${late.join(', ')}.`);

    inserted.push(table.name.toLowerCase());
    inserts.push({ sql, table: table.name, rows: countTuples(m[3]) });
  }

  const deletes: string[] = [];
  const teardownStatements = splitStatements(script.teardown, engine).map((s) => stripComments(s.sql)).filter(Boolean);
  if (!teardownStatements.length) problems.push('The teardown script is empty.');
  for (const sql of teardownStatements) {
    const m = DELETE_RE.exec(sql);
    if (!m) {
      problems.push('The teardown may only hold DELETE … WHERE statements.');
      continue;
    }
    const table = findTable(snapshot, splitName(m[1]), activeSchema);
    if (!table) {
      problems.push(`The teardown deletes from ${m[1]}, which does not exist.`);
      continue;
    }
    // A child deleted after its parent fails on the foreign key.
    const earlyParent = teardownStatements.slice(teardownStatements.indexOf(sql) + 1).some((later) => {
      const lm = DELETE_RE.exec(later);
      if (!lm) return false;
      const child = findTable(snapshot, splitName(lm[1]), activeSchema);
      return child ? parentsOf(child).includes(table.name.toLowerCase()) : false;
    });
    if (earlyParent) problems.push(`The teardown deletes ${table.name} before rows that point at it.`);
    deletes.push(sql);
  }

  let verify: string | null = null;
  const verifyStatements = splitStatements(script.verify, engine).map((s) => stripComments(s.sql)).filter(Boolean);
  if (verifyStatements.length === 1 && classify(verifyStatements[0]) === 'read') verify = verifyStatements[0];
  else if (verifyStatements.length) problems.push('The verify query must be a single SELECT.');

  const perTable: Array<{ table: string; rows: number }> = [];
  for (const i of inserts) {
    const row = perTable.find((p) => p.table === i.table);
    if (row) row.rows += i.rows;
    else perTable.push({ table: i.table, rows: i.rows });
  }

  return { ok: problems.length === 0, problems, inserts, deletes, verify, perTable };
}

// ---- context for the prompt ---------------------------------------------

/// Tables ordered parents first, so the prompt can say which order inserts
/// must go in rather than hoping. Cycles (a self-reference, or two tables
/// that point at each other) break at an arbitrary edge; the model is told
/// about the foreign keys either way.
export function insertOrder(tables: TableInfo[]): string[] {
  const names = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string) => {
    if (state.get(key)) return;
    state.set(key, 'visiting');
    const t = names.get(key);
    if (t) for (const p of parentsOf(t)) if (names.has(p)) visit(p);
    state.set(key, 'done');
    if (t) out.push(t.name);
  };
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) visit(t.name.toLowerCase());
  return out;
}

/// Where explicit ids for seeded rows start: a round number comfortably
/// above every id in use, so the block cannot collide today and reads as
/// "seeded" at a glance. Never below 900001, which is what a fresh local
/// database gets.
export function seedIdStart(maxIds: Array<number | null>): number {
  const top = Math.max(0, ...maxIds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)));
  if (top < 90_000) return 900_001;
  const magnitude = 10 ** Math.ceil(Math.log10(top * 10 + 1));
  return magnitude + 1;
}
