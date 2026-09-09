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
  /// MySQL's `filtered` percentage.
  filtered?: number;
  extra?: string;
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
  // A join is a nested_loop array; each element wraps one table.
  if (Array.isArray(obj.nested_loop)) {
    for (const child of obj.nested_loop) parseMysql(child, depth, out);
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
    });
    // A materialized subquery or derived table hangs off the table node.
    for (const key of ['materialized_from_subquery', 'attached_subqueries', 'table']) {
      if (t[key]) parseMysql(t[key], depth + 1, out);
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
  engine: 'postgres' | 'mysql' | 'sqlite',
  format: 'json' | 'text',
  raw: string,
): PlanRow[] {
  const out: PlanRow[] = [];
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
