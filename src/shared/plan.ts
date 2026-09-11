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

/// Work the server does to the rows AFTER the tables have been read.
///
/// Kept apart from the table steps because it answers a different
/// question. A table step says where rows came from; these say what has to
/// finish before a single row can be returned — which, for any query with
/// a GROUP BY or an ORDER BY the indexes cannot serve, is usually most of
/// the wall clock.
export type PlanStage = 'sort' | 'temporary' | 'group' | 'distinct' | 'union';

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
  /// Set on a step that is not a table read but a pass over the rows: a
  /// sort, a temporary table, a grouping. Undefined on table steps.
  stage?: PlanStage;
  /// The pass has to finish before the first row can be returned, because
  /// it went through a temporary table or a sort. A grouping an index
  /// already answered streams, and does not.
  blocks?: boolean;
  /// The server marked this subquery dependent AND not cacheable.
  ///
  /// Reported rather than acted on. Everything here counts a materialized
  /// subquery as built once, which is what `<materialize>` means and what
  /// the `<primary_index_lookup>` beside it confirms — but these two flags
  /// are the plan's own hedge on that, and on a plan driven by 143 rows
  /// the difference between built-once and rebuilt-per-row is two orders
  /// of magnitude. Better said than silently assumed.
  dependent?: boolean;
  /// The index answered the step on its own — the table rows were never
  /// touched. MySQL's `using_index`. Worth saying out loud because it is
  /// the good news in a plan, and a reader who only sees "via IDX_FOO" has
  /// no way to tell a covering index from one that costs a lookup per row.
  covering?: boolean;
  /// Set when this step is worth looking at, with the reason.
  warn?: string;
}

const FULL_SCAN = new Set(['ALL', 'index', 'Seq Scan']);

function warnFor(row: Omit<PlanRow, 'warn'>): string | undefined {
  // A pass over the rows blocks: nothing at all comes back until it
  // finishes, however cheap each row is. The thresholds are where MySQL's
  // own buffers stop coping — a sort past sort_buffer_size becomes a merge
  // on disk, and a temporary table past tmp_table_size becomes a table on
  // disk — so they are the point at which this stops being bookkeeping.
  if (row.stage !== undefined && row.blocks !== false && (row.rows ?? 0) > 10_000) {
    return `Nothing is returned until all ${row.rows?.toLocaleString()} rows have been through it.`;
  }
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
///
/// Returns the rows the subtree PRODUCES, so an operation stacked on top
/// of it — a temporary table, a sort — can say how much it is moving.
/// Nothing else in the plan carries that number: a table node's `rows` is
/// per scan, and what a join hands upward is the product across the whole
/// nested loop.
function parseMysql(node: unknown, depth: number, out: PlanRow[]): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;

  if (obj.query_block) return parseMysql(obj.query_block, depth, out);

  // The work AFTER the join, which used to be dropped entirely.
  //
  // The catch-all at the bottom descended into these containers without
  // emitting a step, so a query whose real cost was materialising 665,170
  // rows and sorting them drew as two table scans and a result — the
  // expensive half of the plan missing, with nothing to say it had been
  // left out. MariaDB nests them (`filesort` wrapping `temporary_table`);
  // MySQL 8 names them `ordering_operation` / `grouping_operation` and
  // carries booleans. Both mean the same work.
  //
  // Emitted AFTER the child, because that is the order they run in: the
  // JSON nests them outside-in, and the join happens first.
  const stage = mysqlStage(obj);
  if (stage) {
    const produced = parseMysql(stage.child, depth, out);
    for (const step of stage.steps) {
      push(out, { depth, rows: produced, ...step });
    }
    return produced;
  }
  // A join is a nested_loop array, and the array order is the join order:
  // each element is driven once per row produced by everything before it.
  // That multiplier is the whole cost of a bad join and appears nowhere in
  // the plan's own numbers, so it is accumulated here.
  // MariaDB spells the same thing `block-nl-join`, wrapping ONE table that
  // is driven by everything above it. Without this the loop multiplier was
  // computed on MySQL and silently skipped on MariaDB.
  if (obj['block-nl-join']) return parseMysql(obj['block-nl-join'], depth, out);
  if (Array.isArray(obj.nested_loop)) {
    let runs = 1;
    for (const child of obj.nested_loop) {
      const before = out.length;
      // Rows PRODUCED, not rows read: the next table is driven once per row
      // that survives this one's condition, which is what `filtered` says.
      //
      // Taken from the recursion's own answer rather than from the last row
      // it happened to push. Those differ the moment a join element carries
      // a subquery — the last row pushed is then the SUBQUERY's, and the
      // multiplier became that table's row count instead of the join
      // element's. On a real plan here it turned a join producing 143 rows
      // into one producing 594,737, and every step after it inherited the
      // error.
      const produced = parseMysql(child, depth, out);
      if (runs > 1) {
        for (let i = before; i < out.length; i++) {
          // A materialized subquery is built ONCE and probed many times.
          // It is marked as such precisely so it does not inherit the
          // driving step's repeat count — and then this loop handed it
          // that count anyway, reporting a table read once as read 143
          // times.
          if (out[i].materialized) continue;
          out[i] = { ...out[i], loops: (out[i].loops ?? 1) * runs };
        }
      }
      if (produced !== undefined) runs *= Math.max(1, Math.round(produced));
    }
    // The product across the whole loop: what the join hands upward.
    return out.length > 0 ? runs : undefined;
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
      // The one piece of good news a plan carries, and it was being
      // thrown away: the index answered this step by itself and the table
      // was never opened.
      covering: t.using_index === true ? true : undefined,
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
        const m = t[key] as Record<string, unknown>;
        const hedged = m.dependent === true && m.cacheable === false;
        for (let i = before; i < out.length; i++) {
          out[i] = { ...out[i], materialized: true };
        }
        if (hedged && out.length > before) {
          // On the head of the subquery only. Six identical markers down a
          // list is a pattern the eye stops reading.
          out[before] = { ...out[before], dependent: true };
        }
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
    const rows = numberish(t.rows ?? t.rows_examined_per_scan);
    return rows === undefined
      ? undefined
      : Math.max(1, Math.round(rows * ((numberish(t.filtered) ?? 100) / 100)));
  }
  if (obj.message) {
    push(out, { depth, title: String(obj.message) });
    return undefined;
  }
  // Anything left is a container we have no step for: descend without
  // inventing one, and carry up whatever the deepest thing produced.
  let produced: number | undefined;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') produced = parseMysql(value, depth, out) ?? produced;
  }
  return produced;
}

/// The post-join operation this node describes, if it is one: what to
/// descend into, and the step or steps to emit once that is done.
///
/// One node can be two steps. MySQL's `grouping_operation` says in two
/// booleans that it both built a temporary table and sorted it, and those
/// are separately expensive — collapsing them into "group" would hide the
/// half that is usually the problem.
function mysqlStage(
  obj: Record<string, unknown>,
): { child: unknown; steps: Array<Omit<PlanRow, 'warn' | 'depth' | 'rows'>> } | null {
  // MariaDB: nested containers, with the sort key spelled out.
  if (obj.filesort && typeof obj.filesort === 'object') {
    const f = obj.filesort as Record<string, unknown>;
    return { child: f, steps: [sortStep(f.sort_key)] };
  }
  if (obj.temporary_table && typeof obj.temporary_table === 'object') {
    return { child: obj.temporary_table, steps: [TEMP_STEP] };
  }

  // MySQL 8: one named operation carrying booleans for how it was done.
  //
  // ONE step, not one per boolean. A DISTINCT done through a temporary
  // table is a single operation described two ways, and drawing it as
  // "temporary table" followed by "distinct" put two nodes in the river
  // for one pass — which reads as the rows being written out and then
  // deduped separately. How it was done belongs in the step, not beside
  // it.
  for (const [key, step] of Object.entries(NAMED_OPERATIONS)) {
    const child = obj[key];
    if (!child || typeof child !== 'object') continue;
    const c = child as Record<string, unknown>;
    const temp = c.using_temporary_table === true;
    const sorted = c.using_filesort === true;
    // An operation that needed neither is one an index already answered,
    // which is not work worth a step of its own.
    if (!temp && !sorted) return { child, steps: [] };
    if (key === 'ordering_operation' && !temp) {
      return { child, steps: [sortStep(c.sort_key)] };
    }
    const how = [temp ? 'in a temporary table' : null, sorted ? 'then sorted' : null]
      .filter(Boolean)
      .join(', ');
    return {
      child,
      steps: [{ ...step, extra: `${step.extra}, ${how}`, blocks: temp || sorted }],
    };
  }
  return null;
}

const NAMED_OPERATIONS: Record<string, Omit<PlanRow, 'warn' | 'depth' | 'rows'>> = {
  ordering_operation: { title: 'sort', stage: 'sort', extra: 'ordered before returning' },
  grouping_operation: { title: 'group', stage: 'group', extra: 'rows collapsed into groups' },
  duplicates_removal: { title: 'distinct', stage: 'distinct', extra: 'duplicate rows removed' },
};

const TEMP_STEP = {
  title: 'temporary table',
  stage: 'temporary' as const,
  extra: 'written out before anything is returned',
  blocks: true,
};

function sortStep(sortKey: unknown): Omit<PlanRow, 'warn' | 'depth' | 'rows'> {
  const by = sortKey === undefined || sortKey === null ? undefined : String(sortKey);
  return {
    title: 'sort',
    stage: 'sort',
    extra: by ? `by ${by}` : 'ordered before returning',
    condition: by,
    blocks: true,
  };
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
