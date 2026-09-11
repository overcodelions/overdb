// Normalizing a query plan into something you can read at a glance.
//
// Prose about a plan is useful, but it is not a substitute for seeing the
// plan: which table is scanned, in what order, on which index, and how many
// rows the optimizer expects. Those five facts answer most "why is this
// slow" questions before anyone has to interpret anything.
//
// The three engines emit wildly different shapes, so everything is flattened
// to one row-per-step list with a depth, and the parts that matter are
// pulled into named fields.

import type { DynamoAccess } from './dynamo';
import type { Engine } from './engines';

export interface PlanRow {
  depth: number;
  /// The step: a table name, or a node type like "Seq Scan".
  title: string;
  /// MySQL access_type / Postgres node type — the single most diagnostic
  /// field, because `ALL` and `Seq Scan` are what a full scan looks like.
  access?: string;
  key?: string;
  /// Rows the optimizer EXPECTS to read at this step.
  rows?: number;
  /// Rows it actually read, when the plan was run with ANALYZE.
  actualRows?: number;
  /// How many times this step RUNS.
  ///
  /// The number that makes joins expensive and is invisible in every plan
  /// table: in a nested loop the inner side is executed once per row from
  /// the outer side, and `rows` is per scan. A step showing "1 row" that
  /// runs 28,616 times reads 28,616 rows, and until this existed the plan
  /// looked cheap.
  loops?: number;
  /// Built once and reused, however many times the step above it runs. The
  /// counterpart to `loops`, and the reason a scan inside a materialized
  /// subquery is not the disaster it looks like.
  materialized?: boolean;
  /// This step heads an independent subquery hanging off the step above it,
  /// rather than continuing that step's chain.
  ///
  /// Its siblings marked the same way are alternatives to it — nothing
  /// flows between them. Drawn as a sequence they read as a pipeline, and
  /// the reader concludes the fourth is waiting on the third.
  branch?: boolean;
  /// MySQL's `filtered` percentage.
  filtered?: number;
  extra?: string;
  /// The expression the server evaluates against every row this step reads
  /// — MySQL's `attached_condition`, Postgres's `Filter`.
  ///
  /// Separate from `extra` because `extra` is whatever a given engine had
  /// to say, and only some of it is a condition: DynamoDB puts prose there
  /// ("sort key …", a suggestion), and a reader that splits prose on `and`
  /// presents half a sentence as a predicate.
  condition?: string;
  /// Set when this step is worth looking at, with the reason.
  warn?: string;
}

const FULL_SCAN = new Set(['ALL', 'index', 'Seq Scan']);

function warnFor(row: Omit<PlanRow, 'warn'>): string | undefined {
  if (row.access && FULL_SCAN.has(row.access) && !row.key) {
    return row.access === 'index' ? 'Full index scan — every entry read.' : 'Full table scan — no index used.';
  }
  // An estimate an order of magnitude off is the commonest cause of a bad
  // plan, and the number the optimizer acted on is right here.
  if (row.rows !== undefined && row.actualRows !== undefined && row.rows > 0) {
    const ratio = row.actualRows / row.rows;
    if (ratio >= 10 || ratio <= 0.1) {
      return `Estimate off by ${ratio >= 1 ? `${Math.round(ratio)}x under` : `${Math.round(1 / ratio)}x over`} — stats may be stale.`;
    }
  }
  if (row.filtered !== undefined && row.filtered <= 5 && (row.rows ?? 0) > 1000) {
    return `Only ${row.filtered}% of rows read survive the condition.`;
  }
  return undefined;
}

function push(out: PlanRow[], row: Omit<PlanRow, 'warn'>): void {
  out.push({ ...row, warn: warnFor(row) });
}

/// MySQL / MariaDB `EXPLAIN FORMAT=JSON`.
function parseMysql(node: unknown, depth: number, out: PlanRow[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (obj.query_block) {
    parseMysql(obj.query_block, depth, out);
    return;
  }
  // A join is a nested_loop array, and the array order is the join order:
  // each element is driven once per row produced by everything before it.
  // That multiplier is the whole cost of a bad join and appears nowhere in
  // the plan's own numbers, so it is accumulated here.
  // MariaDB spells the same thing `block-nl-join`, wrapping ONE table that
  // is driven by everything above it. Without this the loop multiplier was
  // computed on MySQL and silently skipped on MariaDB.
  if (obj['block-nl-join']) {
    parseMysql(obj['block-nl-join'], depth, out);
    return;
  }
  if (Array.isArray(obj.nested_loop)) {
    let runs = 1;
    for (const child of obj.nested_loop) {
      const before = out.length;
      parseMysql(child, depth, out);
      if (runs > 1) {
        for (let i = before; i < out.length; i++) {
          out[i] = { ...out[i], loops: (out[i].loops ?? 1) * runs };
        }
      }
      // Rows PRODUCED, not rows read: the next table is driven once per row
      // that survives this one's condition, which is what `filtered` says.
      const produced = out[out.length - 1];
      if (produced?.rows !== undefined) {
        const surviving = produced.rows * ((produced.filtered ?? 100) / 100);
        runs *= Math.max(1, Math.round(surviving));
      }
    }
    return;
  }
  if (obj.table) {
    const t = obj.table as Record<string, unknown>;
    push(out, {
      depth,
      title: String(t.table_name ?? 'table'),
      access: t.access_type ? String(t.access_type) : undefined,
      key: t.key ? String(t.key) : undefined,
      rows: numberish(t.rows ?? t.rows_examined_per_scan),
      filtered: numberish(t.filtered),
      extra: t.attached_condition ? String(t.attached_condition) : undefined,
      condition: t.attached_condition ? String(t.attached_condition) : undefined,
    });
    // A materialized subquery or derived table hangs off the table node.
    // Its rows are read ONCE and reused — the opposite of a loop, and just
    // as invisible in a plan table — so its steps are marked rather than
    // inheriting the parent's repeat count.
    for (const key of ['materialized_from_subquery', 'attached_subqueries', 'table']) {
      if (!t[key]) continue;
      const before = out.length;
      parseMysql(t[key], depth + 1, out);
      if (key === 'materialized_from_subquery') {
        for (let i = before; i < out.length; i++) out[i] = { ...out[i], materialized: true };
      }
      // Depth alone cannot tell a chain from a fan, and the difference is
      // the whole reading of the plan: the steps INSIDE one subquery are a
      // sequence, while the subqueries attached to a step are alternatives
      // that never feed each other. Only the parser knows which is which —
      // `attached_subqueries` is a list of independent conditions — so it
      // says so here rather than leaving a renderer to guess from shape.
      if (key === 'attached_subqueries') {
        for (let i = before; i < out.length; i++) {
          if (out[i].depth === depth + 1) out[i] = { ...out[i], branch: true };
        }
      }
    }
    return;
  }
  if (obj.message) {
    push(out, { depth, title: String(obj.message) });
    return;
  }
  // Anything else (union_result, ordering_operation, duplicates_removal…)
  // is a container: descend without inventing a row for it.
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') parseMysql(value, depth, out);
  }
}

/// Postgres `EXPLAIN (FORMAT JSON)`, optionally with ANALYZE.
function parsePostgres(node: unknown, depth: number, out: PlanRow[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const plan = (obj.Plan ?? obj) as Record<string, unknown>;
  if (!plan['Node Type']) return;

  const relation = plan['Relation Name'] ? ` on ${plan['Relation Name']}` : '';
  push(out, {
    depth,
    title: `${plan['Node Type']}${relation}`,
    access: String(plan['Node Type']),
    key: plan['Index Name'] ? String(plan['Index Name']) : undefined,
    rows: numberish(plan['Plan Rows']),
    actualRows: numberish(plan['Actual Rows']),
    extra: plan['Filter'] ? String(plan['Filter']) : undefined,
    condition: plan['Filter'] ? String(plan['Filter']) : undefined,
  });
  const children = plan.Plans;
  if (Array.isArray(children)) for (const c of children) parsePostgres(c, depth + 1, out);
}

/// SQLite `EXPLAIN QUERY PLAN` is already a flat, human-readable list.
function parseSqlite(text: string, out: PlanRow[]): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    push(out, {
      depth: 0,
      title: trimmed,
      access: /SCAN\b/.test(trimmed) && !/USING (COVERING )?INDEX/.test(trimmed) ? 'Seq Scan' : undefined,
    });
  }
}

export function parsePlan(
  engine: Engine,
  format: 'json' | 'text',
  raw: string,
): PlanRow[] {
  const out: PlanRow[] = [];
  // DynamoDB's "plan" is produced locally from the statement and the table's
  // key schema — there is no server-side EXPLAIN to parse. See
  // src/shared/dynamo.ts for why that is enough to be accurate.
  if (engine === 'dynamodb') return parseDynamo(raw);
  if (format === 'text' || engine === 'sqlite') {
    parseSqlite(raw, out);
    return out;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // A plan we can't parse still beats no plan: show it verbatim rather
    // than pretending there was nothing to see.
    parseSqlite(raw, out);
    return out;
  }
  if (engine === 'mysql') parseMysql(doc, 0, out);
  else parsePostgres(Array.isArray(doc) ? doc[0] : doc, 0, out);
  return out;
}

function numberish(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : undefined;
}


/// The DynamoDB access path as plan rows. One row for the operation, one per
/// warning — warnings ARE the plan here, because the operation is either a
/// key lookup or a read of everything and there is no tree in between.
function parseDynamo(raw: string): PlanRow[] {
  let access: DynamoAccess;
  try {
    access = JSON.parse(raw) as DynamoAccess;
  } catch {
    return [{ depth: 0, title: raw }];
  }

  const target = access.index ? `${access.table}.${access.index}` : (access.table ?? 'unknown');
  const out: PlanRow[] = [
    {
      depth: 0,
      title:
        access.path === 'query' ? `Query ${target}`
        : access.path === 'scan' ? `Scan ${target}`
        : access.path === 'write' ? `${access.kind.toUpperCase()} ${target}`
        : `Unknown access on ${target}`,
      access: access.path === 'scan' ? 'SCAN' : access.path === 'query' ? 'QUERY' : undefined,
      key: access.partitionKeyMatched ?? undefined,
      extra: access.sortKeyCondition ? `sort key ${access.sortKeyCondition}` : undefined,
      // A scan is the DynamoDB equivalent of `Seq Scan` / `ALL`, and this is
      // the field PlanView colours on.
      warn:
        access.path === 'scan'
          ? 'Reads every item in the target, and is billed for all of them.'
          : undefined,
    },
  ];

  if (access.suggestion) {
    out.push({
      depth: 1,
      title: `Use index ${access.suggestion.index}`,
      extra: access.suggestion.why,
      warn: 'This scan has an index that would answer it.',
    });
  }
  for (const w of access.warnings) {
    out.push({
      depth: 1,
      title: w.text,
      warn: w.level === 'high' ? w.text : undefined,
    });
  }
  return out;
}

/// What to call an index in the picture.
///
/// MySQL invents indexes on its own temporary tables and names them
/// `<auto_key0>`, `<auto_distinct_key>` and so on. Printed raw next to a
/// step's alias it reads as another alias, which is the one thing it is not:
/// there is no such index in the schema, nothing created it, and looking for
/// it is a dead end. So it is named for what it is instead.
export function keyLabel(key: string): string {
  return /^<auto_[a-z_]*key\d*>$/i.test(key) ? 'index built on the fly' : key;
}
