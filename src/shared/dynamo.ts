// Reading a PartiQL statement the way DynamoDB will read it.
//
// PartiQL makes DynamoDB look like SQL, and that is exactly the danger: the
// same SELECT costs a key lookup or a full table read depending on details
// the syntax does not draw attention to. A Scan is charged per item READ,
// not per item returned, so `SELECT * FROM "orders" WHERE status = 'open'`
// on a 40 GB table bills for 40 GB and can take minutes.
//
// The rules DynamoDB actually applies:
//
//   * An EQUALITY condition on the partition key of the target — the table,
//     or the index named in FROM — makes it a Query. Anything else is a Scan.
//   * A sort-key condition (=, <, <=, >, >=, BETWEEN, begins_with) narrows a
//     Query further. On its own it does nothing: no partition key, no Query.
//   * PartiQL does NOT choose an index for you. Filtering on a GSI's
//     partition key without naming that index in FROM is a full Scan, and
//     this is the single most common expensive mistake, because the query
//     looks precise and reads like SQL that any planner would optimise.
//
// This module is pure and has no AWS dependency, so the analysis is unit
// tested against real table shapes rather than only observed in production
// bills.

import type { CellKind } from './types';

export interface DynamoKeySchema {
  partitionKey: string;
  sortKey?: string | null;
}

export interface DynamoIndex {
  name: string;
  keys: DynamoKeySchema;
  type: 'gsi' | 'lsi';
  /// ALL, KEYS_ONLY or INCLUDE. A query against a KEYS_ONLY index that
  /// selects other attributes silently costs a second read per item.
  projection: string;
  projectedAttributes?: string[];
}

export interface DynamoTableShape {
  name: string;
  keys: DynamoKeySchema;
  indexes: DynamoIndex[];
  itemCount?: number;
  sizeBytes?: number;
}

export type DynamoStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'unknown';

export interface DynamoWarning {
  level: 'high' | 'medium' | 'low';
  text: string;
}

export interface DynamoAccess {
  kind: DynamoStatementKind;
  /// 'query' — a key lookup. 'scan' — every item in the target is read.
  path: 'query' | 'scan' | 'write' | 'unknown';
  table: string | null;
  /// The index named in FROM, if any.
  index: string | null;
  partitionKeyMatched: string | null;
  sortKeyCondition: string | null;
  warnings: DynamoWarning[];
  /// An index that WOULD turn this Scan into a Query, when one exists.
  suggestion?: { index: string; why: string };
}

/// `FROM "Table"."Index"` / `FROM Table` / `FROM "Table"`. DynamoDB table
/// names allow letters, digits, dot, dash and underscore, so an unquoted
/// name is ambiguous with the dotted index form — quoting is how you tell
/// them apart, which is why the quoted branch is tried first.
const FROM_QUOTED = /\bfrom\s+"([^"]+)"(?:\s*\.\s*"([^"]+)")?/i;
const FROM_BARE = /\bfrom\s+([A-Za-z0-9_.-]+)/i;

export function parseTarget(sql: string): { table: string | null; index: string | null } {
  const quoted = FROM_QUOTED.exec(sql);
  if (quoted) return { table: quoted[1], index: quoted[2] ?? null };
  const bare = FROM_BARE.exec(sql);
  if (!bare) return { table: null, index: null };
  return { table: bare[1], index: null };
}

export function statementKind(sql: string): DynamoStatementKind {
  const word = /^\s*(select|insert|update|delete)\b/i.exec(stripComments(sql));
  if (!word) return 'unknown';
  return word[1].toLowerCase() as DynamoStatementKind;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/// Attributes compared with `=` at the top level of the WHERE clause.
///
/// Only `=` counts: DynamoDB requires an exact partition-key match, so
/// `pk > 'a'` or `pk IN (...)` is a Scan however precise it looks. Anything
/// under an OR is excluded for the same reason — `pk = 'a' OR x = 1` cannot
/// be answered from one partition.
export function equalityAttributes(sql: string): Set<string> {
  const out = new Set<string>();
  const where = whereClause(sql);
  if (!where) return out;
  if (/\bor\b/i.test(where)) return out;
  const eq = /(?:^|\band\b|\()\s*"?([A-Za-z_][\w.-]*)"?\s*=\s*(?:'|"|\d|\?|\bnull\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = eq.exec(where))) out.add(m[1]);
  return out;
}

/// Sort-key operators DynamoDB accepts on a Query.
const SORT_OPS = /\b(?:=|<|<=|>|>=|between|begins_with)\b/i;

export function sortKeyConditionFor(sql: string, attribute: string): string | null {
  const where = whereClause(sql);
  if (!where) return null;
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `"?${escaped}"?\\s*(=|<=|>=|<|>)|begins_with\\s*\\(\\s*"?${escaped}"?|"?${escaped}"?\\s+between\\b`,
    'i',
  );
  const m = re.exec(where);
  if (!m) return null;
  return SORT_OPS.test(m[0]) ? m[0].trim() : m[0].trim();
}

function whereClause(sql: string): string | null {
  const m = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|$)/i.exec(stripComments(sql));
  return m ? m[1] : null;
}

function humanSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/// The whole point of the module: what this statement will actually do.
export function analyzePartiql(sql: string, table: DynamoTableShape | undefined): DynamoAccess {
  const kind = statementKind(sql);
  const { table: tableName, index } = parseTarget(sql);
  const base: DynamoAccess = {
    kind,
    path: 'unknown',
    table: tableName,
    index,
    partitionKeyMatched: null,
    sortKeyCondition: null,
    warnings: [],
  };

  if (kind !== 'select') {
    // Writes address a single item by full primary key, so they have no
    // access-path question — but they are still writes.
    return { ...base, path: kind === 'unknown' ? 'unknown' : 'write' };
  }
  if (!table) {
    return {
      ...base,
      warnings: [
        {
          level: 'low',
          text: tableName
            ? `No description of ${tableName} yet, so its access path can't be checked.`
            : 'No table named in the statement.',
        },
      ],
    };
  }

  const target: DynamoKeySchema | null = index
    ? (table.indexes.find((i) => i.name === index)?.keys ?? null)
    : table.keys;

  if (index && !target) {
    return {
      ...base,
      path: 'unknown',
      warnings: [
        {
          level: 'high',
          text: `${table.name} has no index called ${index}. This statement will fail.`,
        },
      ],
    };
  }

  const equalities = equalityAttributes(sql);
  const pkMatched = target && equalities.has(target.partitionKey) ? target.partitionKey : null;
  const sortCondition =
    pkMatched && target?.sortKey ? sortKeyConditionFor(sql, target.sortKey) : null;

  const warnings: DynamoWarning[] = [];
  let suggestion: DynamoAccess['suggestion'];

  if (pkMatched) {
    // A Query against a KEYS_ONLY or INCLUDE index that selects everything
    // costs a second read of the base table per item, which is invisible in
    // the statement and doubles the bill.
    const idx = index ? table.indexes.find((i) => i.name === index) : undefined;
    if (idx && idx.projection !== 'ALL' && /select\s+\*/i.test(sql)) {
      warnings.push({
        level: 'medium',
        text:
          `${idx.name} projects ${idx.projection}, so SELECT * fetches each item from the ` +
          'base table as well — roughly double the reads. Select only projected attributes ' +
          'to avoid that.',
      });
    }
  } else {
    const size = humanSize(table.sizeBytes);
    const count = table.itemCount ? `${table.itemCount.toLocaleString()} items` : null;
    const scale = [count, size].filter(Boolean).join(', ');
    warnings.push({
      level: 'high',
      text:
        `This reads every item in ${index ?? table.name}${scale ? ` (${scale})` : ''}. ` +
        'DynamoDB charges for items read, not items returned, so a filter that removes ' +
        'almost everything costs the same as returning it all.',
    });

    // The expensive mistake worth naming: the filter IS on an index key,
    // but PartiQL will not pick the index for you.
    if (!index) {
      const covering = table.indexes.find((i) => equalities.has(i.keys.partitionKey));
      if (covering) {
        suggestion = {
          index: covering.name,
          why:
            `${covering.keys.partitionKey} is the partition key of ${covering.name}, but PartiQL ` +
            'never chooses an index on its own. Name it in FROM and this becomes a key lookup ' +
            'instead of a full scan.',
        };
      }
    }

    warnings.push({
      level: 'medium',
      text:
        'The row cap on this tab bounds it — DynamoDB stops after that many items are ' +
        'evaluated — but the items it did read are still charged.',
    });
  }

  return {
    ...base,
    path: pkMatched ? 'query' : 'scan',
    partitionKeyMatched: pkMatched,
    sortKeyCondition: sortCondition,
    warnings,
    suggestion,
  };
}

/// One-line summary for the status bar, in the voice the rest of the app
/// uses: what happened, not how the system is built.
export function accessSummary(a: DynamoAccess): string {
  if (a.path === 'query') {
    const parts = [`Key lookup on ${a.index ?? a.table}`];
    if (a.sortKeyCondition) parts.push('narrowed by sort key');
    return parts.join(', ');
  }
  if (a.path === 'scan') return `Full scan of ${a.index ?? a.table}`;
  if (a.path === 'write') return 'Write';
  return 'Access path unknown';
}

/// PartiQL IS NOT SQL, AND THE TWO CLAUSES EVERYONE TYPES ANYWAY.
///
/// DynamoDB's PartiQL grammar has no LIMIT clause at all — the row cap is a
/// request parameter (ExecuteStatement's Limit), not something you write —
/// and `SELECT ... LIMIT 100` comes back as "Unsupported clause: LIMIT".
/// Everyone writes it, because every other engine in this app takes it and
/// because the SQL habit is thirty years old. So overdb reads the LIMIT and
/// hands it to the API where it belongs, instead of forwarding a statement
/// it already knows the server will reject.
const LIMIT_TAIL = /\s+limit\s+(\d+)\s*$/i;

export interface PreparedStatement {
  /// What actually goes on the wire.
  statement: string;
  /// The LIMIT that was written in the text, lifted out into the request.
  limit: number | null;
  /// Said in the log when we changed the text, so the rewrite is never
  /// silent — you should be able to see that what ran is not what you typed.
  note: string | null;
}

export function prepareStatement(sql: string): PreparedStatement {
  const statement = sql.trim().replace(/;\s*$/, '').trim();
  const m = LIMIT_TAIL.exec(statement);
  if (!m) return { statement, limit: null, note: null };
  const limit = Number(m[1]);
  return {
    statement: statement.slice(0, m.index).trim(),
    limit,
    note:
      `PartiQL has no LIMIT clause, so LIMIT ${limit} was sent as the request's row limit ` +
      'instead — same effect, and DynamoDB stops reading there.',
  };
}

/// `ORDER BY attr [ASC|DESC]`, which DynamoDB accepts only in one narrow
/// case; see orderByProblem.
const ORDER_BY = /\border\s+by\s+"?([A-Za-z_][\w.-]*)"?(?:\s+(asc|desc))?/i;

export function orderByTarget(sql: string): { attribute: string; direction: 'asc' | 'desc' } | null {
  const m = ORDER_BY.exec(stripComments(sql));
  if (!m) return null;
  return { attribute: m[1], direction: (m[2]?.toLowerCase() as 'asc' | 'desc') ?? 'asc' };
}

/// Why this ORDER BY will be rejected, in the terms the user can act on.
///
/// DynamoDB does not sort. Items come back in sort-key order within one
/// partition, and ORDER BY is only a way to ask for that order reversed —
/// so it is legal ONLY on the sort key of the target, and ONLY when the
/// statement is a key lookup. Ordering by an arbitrary attribute is not a
/// slow query here, it is an impossible one, and the server's own message
/// ("Unsupported clause") does not say which of the two rules was broken.
///
/// Returns null when there is no ORDER BY, or when we have no description
/// of the table and therefore no grounds to object.
export function orderByProblem(sql: string, shape: DynamoTableShape | undefined): string | null {
  const order = orderByTarget(sql);
  if (!order || !shape) return null;

  const access = analyzePartiql(sql, shape);
  if (access.kind !== 'select') return null;

  const { index } = access;
  const target = index ? shape.indexes.find((i) => i.name === index)?.keys : shape.keys;
  if (!target) return null;

  const targetName = index ? `${shape.name}.${index}` : shape.name;

  if (target.sortKey !== order.attribute) {
    const covering = shape.indexes.filter((i) => i.keys.sortKey === order.attribute);
    const alternative = covering.length
      ? ` ${covering.map((i) => i.name).join(' and ')} ${covering.length > 1 ? 'have' : 'has'} ` +
        `${order.attribute} as its sort key — name it in FROM ("${shape.name}"."${covering[0].name}") ` +
        `and query by its partition key (${covering[0].keys.partitionKey}) to get that order.`
      : ` No index on ${shape.name} is sorted by ${order.attribute}, so this order can only be ` +
        'produced after the fact, over whatever the row cap returned.';
    return (
      `DynamoDB can only order by the sort key, and the sort key of ${targetName} is ` +
      `${target.sortKey ?? 'nothing — it has a partition key only'}, not ${order.attribute}.` +
      alternative
    );
  }

  if (!access.partitionKeyMatched) {
    return (
      `ORDER BY ${order.attribute} needs a key lookup, and this statement is a scan. ` +
      `Add an equality on ${target.partitionKey} — the partition key of ${targetName} — ` +
      'and the sort order comes with it.'
    );
  }

  return null;
}

/// DynamoDB's rejections name the clause but not the reason. This turns the
/// two that overdb can recognise into something with a next step in it, and
/// leaves everything else exactly as the server said it.
export function explainDynamoError(message: string, shape?: DynamoTableShape): string {
  if (/unsupported\s+clause:\s*order\s*by/i.test(message)) {
    return (
      `${message}\n\nDynamoDB has no general sort: ORDER BY works only on the sort key of the ` +
      'table or index you named in FROM, and only when the WHERE clause pins the partition key ' +
      'with =. Anything else has to be sorted after the rows arrive.'
    );
  }
  if (/unsupported\s+clause:\s*(join|group\s*by|having|distinct|union)/i.test(message)) {
    const clause = /unsupported\s+clause:\s*(\w[\w\s]*)/i.exec(message)?.[1]?.trim();
    return (
      `${message}\n\nPartiQL on DynamoDB has no ${clause?.toUpperCase() ?? 'such'} — it reads ` +
      'one table or one index per statement. Run the parts separately, or aggregate the rows ' +
      'once they are here.'
    );
  }
  if (/unsupported\s+clause:\s*limit/i.test(message)) {
    return `${message}\n\nUse the row cap on the tab instead — overdb sends it as the request's limit.`;
  }
  if (shape && /ValidationException/i.test(message)) return message;
  return message;
}

/// FINDING AN ITEM WITHOUT WRITING PARTIQL.
///
/// Everything above reads a statement someone wrote. This writes one, and it
/// exists because the gap between a key lookup and a full-table scan is a
/// piece of syntax — `FROM "t"."idx"` and an `=` on the right attribute —
/// that you cannot get right without the key schema in front of you.
///
/// The design decision worth stating: you describe your data in ATTRIBUTES
/// ("clientId_date is 4821_2026-09-08"), and this module works out which
/// index makes that a key lookup. Asking the user to pick the index first is
/// asking them to know the answer before they can ask the question — and
/// getting it wrong is not a slower query, it is a full table read. The
/// choice is still theirs to override; it is just no longer theirs to make
/// from nothing.
export type SortOp = '=' | '<' | '<=' | '>' | '>=' | 'begins_with';

export interface Condition {
  attribute: string;
  op: SortOp;
  value: string;
  /// The upper bound of a BETWEEN, for the `>=`/`>` operators.
  upper?: string;
}

export interface AccessPath {
  /// null means the table itself.
  index: string | null;
  keys: DynamoKeySchema;
}

export interface Resolution extends AccessPath {
  path: 'query' | 'scan';
  /// The equality that pinned the partition key, when there is one.
  partition: Condition | null;
  /// A condition on the target's sort key, which narrows the lookup.
  sort: Condition | null;
  /// Everything else. DynamoDB applies these AFTER reading, so they cut what
  /// crosses the wire and never what you are charged for.
  filters: Condition[];
  /// One line for the verdict banner, in the user's terms.
  why: string;
  /// Every path this table offers, so the choice can be overridden.
  paths: AccessPath[];
}

const usable = (c: Condition): boolean => Boolean(c.attribute.trim() && c.value.trim());

/// Which index (if any) turns these conditions into a key lookup.
///
/// Ranked, because more than one can work: a lookup that also narrows by
/// sort key beats one that reads a whole partition, and the base table beats
/// an index that would cost a second read per item. Ties go to declaration
/// order, so the answer is stable while you type.
export function resolveTarget(
  shape: DynamoTableShape,
  conditions: Condition[],
  override?: string | null,
): Resolution {
  const live = conditions.filter(usable);
  const paths: AccessPath[] = [
    { index: null, keys: shape.keys },
    ...shape.indexes.map((i) => ({ index: i.name, keys: i.keys })),
  ];

  const on = (attribute: string | null | undefined) =>
    attribute ? live.find((c) => c.attribute.trim() === attribute) : undefined;

  const score = (p: AccessPath): number => {
    const pk = on(p.keys.partitionKey);
    if (!pk || pk.op !== '=') return -1;
    let n = 10;
    if (p.keys.sortKey && on(p.keys.sortKey)) n += 4;
    // The base table needs no second read; a non-ALL index projection does.
    if (p.index === null) n += 1;
    return n;
  };

  // `undefined` means "choose for me"; anything else is the user overriding,
  // including `null` for the table itself.
  const chosen =
    override === undefined
      ? [...paths].sort((a, b) => score(b) - score(a))[0]
      : (paths.find((p) => p.index === override) ?? paths[0]);

  const pk = on(chosen.keys.partitionKey);
  const partition = pk && pk.op === '=' ? pk : null;
  const sort = partition ? (on(chosen.keys.sortKey) ?? null) : null;
  const filters = live.filter((c) => c !== partition && c !== sort);

  return {
    ...chosen,
    path: partition ? 'query' : 'scan',
    partition,
    sort,
    filters,
    why: explain(shape, chosen, partition, sort, live),
    paths,
  };
}

function explain(
  shape: DynamoTableShape,
  target: AccessPath,
  partition: Condition | null,
  sort: Condition | null,
  live: Condition[],
): string {
  if (partition) {
    const where = target.index
      ? `Reading the ${target.index} index, where ${partition.attribute} is the partition key`
      : `${partition.attribute} is the table's partition key`;
    return sort
      ? `${where}, narrowed to one range of ${sort.attribute}.`
      : `${where}, so this reads one partition rather than the table.`;
  }

  // The two near-misses worth naming, because both look like they should
  // have worked and the difference is one operator or one missing value.
  const wrongOp = live.find(
    (c) =>
      c.op !== '=' &&
      [shape.keys, ...shape.indexes.map((i) => i.keys)].some(
        (k) => k.partitionKey === c.attribute.trim(),
      ),
  );
  if (wrongOp) {
    return (
      `${wrongOp.attribute} is a partition key, but DynamoDB only looks up a partition by ` +
      'exact match — with any other operator it reads everything.'
    );
  }
  const pks = [shape.keys.partitionKey, ...shape.indexes.map((i) => i.keys.partitionKey)];
  return (
    'No condition names a partition key, so every item is read. ' +
    `A value for ${[...new Set(pks)].slice(0, 3).join(', ')} would make this a lookup.`
  );
}

/// A number stays unquoted so it compares as a number; everything else is a
/// PartiQL string literal, with the quote doubled the way SQL escapes it.
export function literal(value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
  return `'${value.replace(/'/g, "''")}'`;
}

function attr(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function condition(c: Condition): string {
  const value = c.value.trim();
  if (c.op === 'begins_with') return `begins_with(${attr(c.attribute.trim())}, ${literal(value)})`;
  if (c.upper?.trim() && (c.op === '>=' || c.op === '>')) {
    return `${attr(c.attribute.trim())} BETWEEN ${literal(value)} AND ${literal(c.upper.trim())}`;
  }
  return `${attr(c.attribute.trim())} ${c.op} ${literal(value)}`;
}

/// The statement, and the plan it will run under — built together, because
/// the second is the reason the first is shaped the way it is.
export function buildQuery(
  shape: DynamoTableShape,
  opts: { conditions?: Condition[]; newestFirst?: boolean; index?: string | null } = {},
): { sql: string; resolution: Resolution } {
  const resolution = resolveTarget(shape, opts.conditions ?? [], opts.index);
  const from = resolution.index
    ? `${attr(shape.name)}.${attr(resolution.index)}`
    : attr(shape.name);

  const where = [
    resolution.partition ? condition(resolution.partition) : null,
    resolution.sort ? condition(resolution.sort) : null,
    ...resolution.filters.map(condition),
  ].filter((c): c is string => Boolean(c));

  const lines = [`SELECT * FROM ${from}`];
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`);
  // ORDER BY is legal only as a reversal of the sort key on a key lookup, so
  // it is written only when both of those hold. See orderByProblem.
  if (opts.newestFirst && resolution.partition && resolution.keys.sortKey) {
    lines.push(`ORDER BY ${attr(resolution.keys.sortKey)} DESC`);
  }

  return { sql: `${lines.join('\n')};`, resolution };
}

/// Every attribute worth offering in the condition editor, and what it is.
/// Key attributes only: those are the ones DynamoDB itself declares, and a
/// list padded with attributes sampled from a few items would present a
/// guess as a fact.
export function keyAttributes(
  shape: DynamoTableShape,
): Array<{ name: string; role: string; partition: boolean }> {
  const out = new Map<string, { name: string; role: string; partition: boolean }>();
  const add = (name: string | null | undefined, role: string, partition: boolean) => {
    if (!name || out.has(name)) return;
    out.set(name, { name, role, partition });
  };
  add(shape.keys.partitionKey, 'table partition key', true);
  add(shape.keys.sortKey, 'table sort key', false);
  for (const i of shape.indexes) {
    add(i.keys.partitionKey, `${i.name} partition key`, true);
    add(i.keys.sortKey, `${i.name} sort key`, false);
  }
  return [...out.values()];
}

/// The catalog's vocabulary back into this module's.
///
/// A DynamoDB TableInfo carries the key schema in `primaryKey` and every
/// index's keys in `indexes[].columns`, in key order — see tableInfoOf in
/// src/db/adapters/dynamodb.ts. Undefined when the table was listed but
/// never described, which is a real state (the describe budget) and not an
/// error: without a key schema there is nothing here to analyse.
export function shapeFromTableInfo(table: {
  name: string;
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[] }>;
}): DynamoTableShape | undefined {
  if (!table.primaryKey.length) return undefined;
  return {
    name: table.name,
    keys: { partitionKey: table.primaryKey[0], sortKey: table.primaryKey[1] ?? null },
    indexes: table.indexes
      .filter((i) => i.columns.length > 0)
      .map((i) => ({
        name: i.name,
        keys: { partitionKey: i.columns[0], sortKey: i.columns[1] ?? null },
        type: 'gsi' as const,
        // The catalog does not carry projection type, and guessing KEYS_ONLY
        // would invent a warning. ALL is the shape that warns about nothing.
        projection: 'ALL',
      })),
  };
}

/// Adding a condition to a statement that already exists.
///
/// The grid's filter has no subquery to hide in — PartiQL has none — so the
/// condition goes into the statement itself, which is also the honest place
/// for it: the result is a statement you can read, and the access-path
/// analysis above still applies to it. A filter on a partition key changes
/// the plan; anything else is applied after the read and changes only what
/// crosses the wire.
///
/// The insertion point is before ORDER BY, which must stay last.
export type PartiqlFilterOp =
  | SortOp
  | '!='
  | 'contains'
  | 'starts'
  | 'is null'
  | 'is not null';

export interface PartiqlFilter {
  attribute: string;
  op: PartiqlFilterOp;
  value?: string;
}

/// One condition, in PartiQL's own vocabulary.
///
/// Two of these are not the SQL spelling: inequality is `<>`, and "is null"
/// is `IS MISSING`, because on DynamoDB an attribute is usually ABSENT from
/// an item rather than present and null — testing for NULL would quietly
/// miss every item that simply does not have it.
export function filterSql(f: PartiqlFilter): string {
  const name = attr(f.attribute.trim());
  const value = (f.value ?? '').trim();
  if (f.op === 'is null') return `${name} IS MISSING`;
  if (f.op === 'is not null') return `${name} IS NOT MISSING`;
  if (f.op === 'begins_with' || f.op === 'starts') {
    return `begins_with(${name}, ${literal(value)})`;
  }
  if (f.op === 'contains') return `contains(${name}, ${literal(value)})`;
  return `${name} ${f.op === '!=' ? '<>' : f.op} ${literal(value)}`;
}

export function withPartiqlCondition(
  sql: string,
  filter: PartiqlFilter | null,
  attribute?: string,
): string {
  const statement = sql.trim().replace(/;\s*$/, '');
  const order = /\border\s+by\b/i.exec(statement);
  const head = (order ? statement.slice(0, order.index) : statement).trimEnd();
  const tail = order ? `\n${statement.slice(order.index).trim()}` : '';

  // Existing conditions on the same attribute are dropped first, so changing
  // a filter replaces it rather than ANDing a contradiction onto it.
  const target = (filter?.attribute ?? attribute ?? '').trim();
  const kept = splitConditions(head).filter((c) => !mentions(c, target));
  const needsValue = filter && filter.op !== 'is null' && filter.op !== 'is not null';
  const keep = filter && (!needsValue || (filter.value ?? '').trim() !== '');
  const next = keep ? [...kept, filterSql(filter)] : kept;

  const from = /\bwhere\b/i.exec(head) ? head.slice(0, /\bwhere\b/i.exec(head)!.index).trimEnd() : head;
  const where = next.length ? `\nWHERE ${next.join('\n  AND ')}` : '';
  return `${from}${where}${tail};`;
}

/// The top-level ANDed conditions of a WHERE clause, as written.
///
/// Deliberately naive — it splits on AND outside quotes and parentheses, and
/// gives up on anything with an OR in it by returning the clause whole,
/// because half-understanding a boolean expression is how a filter silently
/// changes what a statement means.
function splitConditions(head: string): string[] {
  const m = /\bwhere\b/i.exec(head);
  if (!m) return [];
  const clause = head.slice(m.index + m[0].length).trim();
  if (!clause) return [];
  if (/\bor\b/i.test(clause)) return [clause];

  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch) && /^and\s/i.test(clause.slice(i + 1))) {
      out.push(clause.slice(start, i).trim());
      start = i + 4;
      i += 3;
    }
  }
  out.push(clause.slice(start).trim());
  return out.filter(Boolean);
}

function mentions(condition: string, attribute: string): boolean {
  if (!attribute) return false;
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `"?${escaped}"?\\s*(=|<|>|between\\b|is\\b)|(?:begins_with|contains)\\s*\\(\\s*"?${escaped}"?`,
    'i',
  ).test(condition);
}

/// EDITING AN ITEM.
///
/// Two things make this different from an UPDATE on a SQL engine.
///
/// First, addressing. DynamoDB will only update an item you name by its FULL
/// primary key — partition key, and sort key when the table has one — so a
/// cell is editable only when the result carries both. `SELECT *` does;
/// anything that projects them away does not, and there is no "update where
/// this attribute equals" fallback to offer instead.
///
/// Second, types are part of the value. `1` and `'1'` are a Number and a
/// String, they are different values under the same key, and writing the
/// wrong one does not fail — it silently stores the wrong type. So the grid's
/// own knowledge of what came back (CellKind, from the AttributeValue tag it
/// arrived under) is what decides how it goes back.
export interface DynamoValue {
  /// The text as the grid holds it. null means the NULL attribute type.
  text: string | null;
  kind: CellKind;
}

export interface DynamoEditTarget {
  table: string;
  attribute: string;
  /// Key attributes and which grid column each is in.
  keys: Array<{ attribute: string; index: number }>;
}

export type DynamoEditCheck =
  | { ok: true; target: DynamoEditTarget }
  | { ok: false; reason: string };

/// Whether this cell can be written back, and how to address its item.
export function dynamoEditTarget(
  columns: Array<{ name: string }>,
  statement: string,
  shape: DynamoTableShape | undefined,
  columnIndex: number,
): DynamoEditCheck {
  const col = columns[columnIndex];
  if (!col) return { ok: false, reason: 'No such column.' };
  if (!shape) {
    return {
      ok: false,
      reason: 'This table has not been described, so its key schema is unknown here.',
    };
  }
  const { index } = parseTarget(statement);
  if (index) {
    return {
      ok: false,
      reason:
        `These rows came from the ${index} index. An item can only be written through its ` +
        'table, so read it from the table to edit it.',
    };
  }

  const needed = [shape.keys.partitionKey, ...(shape.keys.sortKey ? [shape.keys.sortKey] : [])];
  const keys = needed.map((attribute) => ({
    attribute,
    index: columns.findIndex((c) => c.name === attribute),
  }));
  const missing = keys.filter((k) => k.index < 0).map((k) => k.attribute);
  if (missing.length) {
    return {
      ok: false,
      reason:
        `DynamoDB updates an item by its full primary key, and this result has no ` +
        `${missing.join(' or ')}. Select it — or run SELECT * — and try again.`,
    };
  }
  if (needed.includes(col.name)) {
    return {
      ok: false,
      reason: `${col.name} is part of the primary key. A key cannot be changed — that would be a different item, so it is a delete and an insert.`,
    };
  }

  return { ok: true, target: { table: shape.name, attribute: col.name, keys } };
}

/// A value in the shape the wire uses, so the type it had is the type it
/// keeps. Sent as a PARAMETER, never as statement text.
export function attributeValue(value: DynamoValue): Record<string, unknown> {
  if (value.text === null) return { NULL: true };
  if (value.kind === 'bool') return { BOOL: /^true$/i.test(value.text.trim()) };
  if (value.kind === 'int' || value.kind === 'bigint' || value.kind === 'float' || value.kind === 'decimal') {
    // Only if it still looks like a number. Typing a word into a numeric
    // column should fail loudly rather than store `N: "abc"`, which DynamoDB
    // rejects with a message about the value, not the type.
    if (/^-?\d+(\.\d+)?$/.test(value.text.trim())) return { N: value.text.trim() };
  }
  if (value.kind === 'json') {
    // A map, list or set round-trips as the JSON it was rendered as. Anything
    // that is not valid JSON goes back as a string rather than being guessed.
    try {
      return { S: JSON.stringify(JSON.parse(value.text)) };
    } catch {
      return { S: value.text };
    }
  }
  return { S: value.text };
}

/// The statement, its parameters, and a readable rendering for the
/// confirmation. The rendering is never executed.
export function buildItemUpdate(
  target: DynamoEditTarget,
  value: DynamoValue,
  keyValues: DynamoValue[],
): { sql: string; params: unknown[]; preview: string } {
  const name = `"${target.table.replace(/"/g, '""')}"`;
  const where = target.keys
    .map((k) => `"${k.attribute.replace(/"/g, '""')}" = ?`)
    .join(' AND ');
  const sql = `UPDATE ${name} SET "${target.attribute.replace(/"/g, '""')}" = ? WHERE ${where}`;

  const shown = [value, ...keyValues].map((v) =>
    v.text === null ? 'NULL' : v.kind === 'bool' || /^-?\d+(\.\d+)?$/.test(v.text.trim()) ? v.text : literal(v.text),
  );
  let i = 0;
  return {
    sql,
    params: [value, ...keyValues].map(attributeValue),
    preview: sql.replace(/\?/g, () => shown[i++]),
  };
}
