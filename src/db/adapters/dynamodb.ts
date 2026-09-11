// Amazon DynamoDB, over PartiQL.
//
// Three things here are unlike every other adapter, and each is deliberate.
//
// 1. READ-ONLY IS NOT ENFORCED BY THE SERVER. Postgres has BEGIN READ ONLY,
//    MySQL has START TRANSACTION READ ONLY, SQLite has an open flag — the
//    engine refuses the write and overdb never has to parse SQL to be safe.
//    DynamoDB has no equivalent. So on this engine the check IS a string
//    check, and that makes it a UX guard rather than a boundary: it will
//    stop the statement you typed, and it would not stop a determined one.
//    The real boundary for DynamoDB is the IAM policy on the credentials,
//    and the connection form says exactly that rather than implying overdb
//    is protecting you.
//
// 2. THERE ARE NO COLUMNS. Items in a table need not share attributes, so
//    the grid's columns are computed from what actually came back: key
//    attributes first, then every other attribute in first-seen order.
//    That requires the whole result in hand, which is why this adapter
//    buffers to the row cap instead of streaming — each page is at most
//    1 MB and the cap is small, so the memory is bounded and the honesty
//    is worth more than progressive rendering here.
//
// 3. THE COST IS INVISIBLE IN THE SYNTAX. `SELECT ... WHERE status = 'open'`
//    reads like SQL any planner would optimise; in DynamoDB it reads every
//    item in the table unless the index is named explicitly. explain() does
//    not ask the server anything — there is nothing to ask — it analyses
//    the statement against the table's real key schema. See
//    src/shared/dynamo.ts.

import {
  DescribeTableCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ListTablesCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { convertToAttr } from '@aws-sdk/util-dynamodb';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type {
  ConnectSpec,
  DbAdapter,
  QueryHandle,
  QueryResult,
  SchemaSnapshot,
  StreamOptions,
  TableInfo,
} from '../adapter';
import type { SlowQuerySupport, StatementStat } from '../../shared/slowQueries';
import type { Cell, CellKind, ColumnMeta } from '../../shared/types';
import { emptyHealth, type HealthSnapshot } from '../../shared/health';
import type { Variant } from '../../shared/engines';
import { filterTableNames } from '../../shared/tableFilter';
import {
  analyzePartiql,
  explainDynamoError,
  orderByProblem,
  parseTarget,
  prepareStatement,
  statementKind,
  type DynamoIndex,
  type DynamoTableShape,
} from '../../shared/dynamo';

/// Describing every table costs one control-plane call each, so this is a
/// budget rather than "all of them". It is set high because the key schema
/// is not decoration in DynamoDB — it is the only thing that decides whether
/// a query is a key lookup or a full-table scan, so a table we did not
/// describe is a table nobody can query well. At this concurrency 250
/// tables cost a couple of seconds, once, cached for the session.
///
/// Past the budget, tables are listed by name only — same bargain the SQL
/// adapters make for schemas the user has not opened. A name alone is still
/// worth having: it is the difference between the model answering "there is
/// no events table" and naming the one you meant.
export const MAX_DESCRIBE = 250;
const DESCRIBE_CONCURRENCY = 6;

/// Which tables get a describe call, in what order.
///
/// Explicitly requested tables come first and are exempt from the budget: a
/// pinned table with no key schema is the exact failure pinning was meant to
/// fix — the model sees a name, cannot see the partition key, and has to ask
/// you. Everything else fills whatever the budget has left.
export function describePlan(
  names: string[],
  wanted: string[] = [],
  budget = MAX_DESCRIBE,
): string[] {
  const have = new Set(names);
  const first = [...new Set(wanted.filter((t) => have.has(t)))];
  const firstSet = new Set(first);
  const rest = names.filter((n) => !firstSet.has(n));
  return [...first, ...rest.slice(0, Math.max(0, budget - first.length))];
}

const MAX_INLINE_BYTES = 64 * 1024;

/// An AttributeValue is a one-key object naming its own type. Values arrive
/// as the strings DynamoDB sent — N is a string on the wire and stays one,
/// because turning it into a JS number is exactly the silent precision loss
/// the other adapters disable type parsing to avoid.
export function cellOf(av: AttributeValue | undefined): Cell {
  if (!av) return null;
  if ('NULL' in av) return null;
  if ('S' in av) return av.S ?? null;
  if ('N' in av) return av.N ?? null;
  if ('BOOL' in av) return String(av.BOOL);
  if ('B' in av) {
    const buf = Buffer.from(av.B as Uint8Array);
    const slice = buf.byteLength > MAX_INLINE_BYTES ? buf.subarray(0, MAX_INLINE_BYTES) : buf;
    return {
      __bin: true,
      b64: slice.toString('base64'),
      byteLength: buf.byteLength,
      truncated: buf.byteLength > MAX_INLINE_BYTES,
    };
  }
  // Sets, lists and maps have no flat representation, so they render as the
  // JSON they are and the grid's JSON cell handles them.
  return JSON.stringify(plain(av));
}

/// AttributeValue -> ordinary JSON, for the nested cases.
function plain(av: AttributeValue): unknown {
  if ('NULL' in av) return null;
  if ('S' in av) return av.S;
  if ('N' in av) return av.N;
  if ('BOOL' in av) return av.BOOL;
  if ('SS' in av) return av.SS;
  if ('NS' in av) return av.NS;
  if ('BS' in av) return (av.BS as Uint8Array[]).map((b) => Buffer.from(b).toString('base64'));
  if ('L' in av) return (av.L as AttributeValue[]).map(plain);
  if ('M' in av) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(av.M as Record<string, AttributeValue>)) out[k] = plain(v);
    return out;
  }
  if ('B' in av) return Buffer.from(av.B as Uint8Array).toString('base64');
  return null;
}

export function kindOf(av: AttributeValue | undefined): CellKind {
  if (!av || 'NULL' in av) return 'other';
  if ('S' in av) return 'text';
  if ('N' in av) return 'decimal';
  if ('BOOL' in av) return 'bool';
  if ('B' in av) return 'bytes';
  return 'json';
}

export function typeNameOf(av: AttributeValue | undefined): string {
  if (!av) return 'unset';
  const tag = Object.keys(av)[0];
  const names: Record<string, string> = {
    S: 'string', N: 'number', BOOL: 'boolean', B: 'binary', NULL: 'null',
    SS: 'string set', NS: 'number set', BS: 'binary set', L: 'list', M: 'map',
  };
  return names[tag] ?? tag;
}

/// Columns from the items themselves: key attributes first so a row reads
/// the way the table is actually organised, then everything else in the
/// order it first appeared.
export function columnsFrom(
  items: Array<Record<string, AttributeValue>>,
  keyOrder: string[],
): ColumnMeta[] {
  const seen: string[] = [];
  const push = (name: string) => {
    if (!seen.includes(name)) seen.push(name);
  };
  for (const k of keyOrder) {
    if (items.some((i) => k in i)) push(k);
  }
  for (const item of items) for (const k of Object.keys(item)) push(k);

  return seen.map((name) => {
    const sample = items.find((i) => i[name] !== undefined)?.[name];
    return {
      name,
      typeName: typeNameOf(sample),
      kind: kindOf(sample),
      nullable: null,
      // Editing an item needs its full primary key, which the grid cannot
      // know from a PartiQL projection. Left null until the write path
      // exists rather than claiming an editable cell.
      sourceTable: null,
    };
  });
}

function indexesOf(desc: Record<string, unknown>): DynamoIndex[] {
  const out: DynamoIndex[] = [];
  const read = (list: unknown, type: 'gsi' | 'lsi') => {
    for (const raw of (list as Array<Record<string, unknown>>) ?? []) {
      const keys = keySchemaOf(raw.KeySchema as Array<Record<string, string>>);
      if (!keys) continue;
      const projection = (raw.Projection as Record<string, unknown>) ?? {};
      out.push({
        name: String(raw.IndexName),
        keys,
        type,
        projection: String(projection.ProjectionType ?? 'ALL'),
        projectedAttributes: projection.NonKeyAttributes as string[] | undefined,
      });
    }
  };
  read(desc.GlobalSecondaryIndexes, 'gsi');
  read(desc.LocalSecondaryIndexes, 'lsi');
  return out;
}

function keySchemaOf(
  schema: Array<Record<string, string>> | undefined,
): DynamoTableShape['keys'] | null {
  const hash = schema?.find((k) => k.KeyType === 'HASH')?.AttributeName;
  if (!hash) return null;
  return { partitionKey: hash, sortKey: schema?.find((k) => k.KeyType === 'RANGE')?.AttributeName ?? null };
}

/// PartiQL takes its parameters in DynamoDB's own wire shape, so a plain
/// `'hp'` from the values bar has to be dressed as `{ S: 'hp' }`. Anything
/// that already looks like an AttributeValue is passed through untouched —
/// the row editor builds those itself.
function asAttributeValue(value: unknown): AttributeValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (
      keys.length === 1 &&
      ['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS'].includes(keys[0])
    ) {
      return value as AttributeValue;
    }
  }
  return convertToAttr(value, { removeUndefinedValues: true });
}

export class DynamoAdapter implements DbAdapter {
  private client: DynamoDBClient | null = null;
  private spec: ConnectSpec | null = null;
  private region = 'us-east-1';
  /// Table shapes, so explain() can analyse a statement without another
  /// round trip and stream() knows which attributes are keys.
  private shapes = new Map<string, DynamoTableShape>();
  /// Aborts the request in flight. DynamoDB has no server-side cancel, but
  /// the SDK will stop waiting and stop paging, which is what cancel means.
  private inFlight: AbortController | null = null;

  async connect(spec: ConnectSpec): Promise<void> {
    this.spec = spec;
    this.region = spec.region ?? spec.host ?? 'us-east-1';
    this.client = new DynamoDBClient({
      region: this.region,
      // The AWS provider chain: environment, SSO cache, then the named
      // profile. overdb stores no AWS credential of its own.
      credentials: fromNodeProviderChain(spec.profile ? { profile: spec.profile } : {}),
    });
  }

  async ping(): Promise<
    { ok: true; serverVersion: string; variant: Variant } | { ok: false; error: string }
  > {
    try {
      await this.require().send(new ListTablesCommand({ Limit: 1 }));
      // There is no server version to report. The region is the thing you
      // actually need to see, and pretending otherwise would put a made-up
      // number in the title bar.
      return { ok: true, serverVersion: this.region, variant: 'dynamodb' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSchemas(): Promise<string[]> {
    return [this.region];
  }

  /// Switching "schema" means switching REGION — the closest true analogue,
  /// since a region is the namespace a table name is unique within.
  async useSchema(name: string): Promise<string> {
    if (!name || name === this.region) return this.region;
    this.region = name;
    this.shapes.clear();
    if (this.spec) this.spec.region = name;
    await this.connect({ ...(this.spec as ConnectSpec), region: name });
    return this.region;
  }

  async currentSchema(): Promise<string | null> {
    return this.region;
  }

  async listTables(
    opts: { unfiltered?: boolean } = {},
  ): Promise<Array<{ schema: string; table: string; kind: TableInfo['kind'] }>> {
    const names = await this.tableNames(opts);
    return names.map((table) => ({ schema: this.region, table, kind: 'table' as const }));
  }

  /// Every table this connection is scoped to.
  ///
  /// Filtering happens HERE rather than in each caller so browsing,
  /// completion, introspection and the AI's context can never disagree about
  /// what this connection contains. ListTables has no server-side filter, so
  /// the whole account is still paged — the narrowing is ours.
  ///
  /// This is not a boundary. A table excluded here is still queryable by
  /// naming it, and IAM is what actually limits these credentials; see
  /// src/shared/tableFilter.ts.
  private async tableNames(opts: { unfiltered?: boolean } = {}): Promise<string[]> {
    const client = this.require();
    const out: string[] = [];
    let start: string | undefined;
    do {
      const page = await client.send(
        new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }),
      );
      out.push(...(page.TableNames ?? []));
      start = page.LastEvaluatedTableName;
    } while (start);
    return opts.unfiltered ? out : filterTableNames(out, this.spec?.tableFilter);
  }

  async introspect(opts: { tables?: string[] } = {}): Promise<SchemaSnapshot> {
    const names = await this.tableNames();
    // Describes are cached per table, so re-asking for a pinned one is free.
    const described = describePlan(names, opts.tables);
    const describedSet = new Set(described);

    const nameOnly = (name: string): TableInfo => ({
      name, kind: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [],
    });

    const tables: TableInfo[] = [];
    for (let i = 0; i < described.length; i += DESCRIBE_CONCURRENCY) {
      const batch = described.slice(i, i + DESCRIBE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (n) => ({ name: n, shape: await this.describe(n).catch(() => null) })),
      );
      // A describe that got throttled or denied still leaves us knowing the
      // table exists. Dropping it entirely would take it out of completion
      // and out of the AI's context too — punishing the user twice for one
      // transient error.
      for (const r of results) tables.push(r.shape ? tableInfoOf(r.shape) : nameOnly(r.name));
    }
    // Everything past the describe budget is still worth naming: completion
    // and the AI context both want the name even without the key schema.
    for (const name of names) if (!describedSet.has(name)) tables.push(nameOnly(name));

    return {
      engine: 'dynamodb',
      serverVersion: this.region,
      capturedAt: new Date().toISOString(),
      schemas: [{ name: this.region, tables }],
    };
  }

  private async describe(name: string): Promise<DynamoTableShape | null> {
    const cached = this.shapes.get(name);
    if (cached) return cached;
    const res = await this.require().send(new DescribeTableCommand({ TableName: name }));
    const desc = res.Table as unknown as Record<string, unknown> | undefined;
    if (!desc) return null;
    const keys = keySchemaOf(desc.KeySchema as Array<Record<string, string>>);
    if (!keys) return null;
    const shape: DynamoTableShape = {
      name,
      keys,
      indexes: indexesOf(desc),
      itemCount: Number(desc.ItemCount ?? 0) || undefined,
      sizeBytes: Number(desc.TableSizeBytes ?? 0) || undefined,
    };
    this.shapes.set(name, shape);
    return shape;
  }

  async query(sql: string, params: unknown[] = [], maxRows = 1000): Promise<QueryResult> {
    const handle = await this.stream(sql, params, { maxRows });
    const { rows } = await handle.next(maxRows);
    await handle.close();
    return { columns: handle.columns, rows, rowCount: rows.length, truncated: false };
  }

  async stream(
    sql: string,
    params: unknown[] = [],
    opts: StreamOptions = {},
  ): Promise<QueryHandle> {
    const maxRows = opts.maxRows ?? 1000;
    // PartiQL has no LIMIT clause; a written one becomes the request's row
    // limit. See prepareStatement in src/shared/dynamo.ts.
    const { statement, limit } = prepareStatement(sql);
    const kind = statementKind(statement);

    // See note 1 in the header: on this engine the guard is a string check,
    // because there is nothing on the server to ask.
    if ((this.spec?.readOnly ?? true) && !opts.write && kind !== 'select') {
      throw new Error(
        `This connection is read-only, so overdb will not send a ${kind.toUpperCase()}. ` +
          'DynamoDB has no server-side read-only mode — the check happened here, not at AWS, ' +
          'so the durable protection is the IAM policy on these credentials.',
      );
    }

    // The cap the API is actually given. Limit bounds items EVALUATED, not
    // returned, so on a scan it is the thing that stops a 40 GB read — worth
    // sending on every page rather than only slicing what came back.
    const cap = Math.max(1, Math.min(limit ?? maxRows, maxRows));

    const { table } = parseTarget(statement);
    // Describing the target before sending, not after: the key schema is what
    // makes an ORDER BY answerable or impossible, and finding that out from
    // DynamoDB's own "Unsupported clause" costs a round trip and explains
    // nothing. A failed describe just means we say less.
    const shape = table ? ((await this.describe(table).catch(() => null)) ?? undefined) : undefined;
    if (kind === 'select') {
      const problem = orderByProblem(statement, shape);
      if (problem) throw new Error(problem);
      const misread = await this.schemaQualified(statement, shape);
      if (misread) throw new Error(misread);
    }

    const controller = new AbortController();
    this.inFlight = controller;
    const client = this.require();

    const items: Array<Record<string, AttributeValue>> = [];
    let token: string | undefined;
    try {
      do {
        const res = await client.send(
          new ExecuteStatementCommand({
            Statement: statement,
            Parameters: params.length ? params.map(asAttributeValue) : undefined,
            NextToken: token,
            // Limit bounds items EVALUATED, which is a read-side idea: the
            // API rejects it on a write, and a write addresses one item by
            // key anyway.
            Limit: kind === 'select' ? cap - items.length : undefined,
          }),
          { abortSignal: controller.signal },
        );
        items.push(...((res.Items ?? []) as Array<Record<string, AttributeValue>>));
        token = res.NextToken;
        // The cap is the user's row limit. Paging past it would spend read
        // capacity on rows nobody asked to see.
      } while (token && items.length < cap);
    } catch (err) {
      this.inFlight = null;
      throw new Error(explainDynamoError(err instanceof Error ? err.message : String(err), shape));
    }

    this.inFlight = null;
    const capped = items.slice(0, cap);
    const keyOrder = shape
      ? [shape.keys.partitionKey, ...(shape.keys.sortKey ? [shape.keys.sortKey] : [])]
      : [];
    const columns = columnsFrom(capped, keyOrder);

    let offset = 0;
    return {
      columns,
      async next(n: number) {
        const slice = capped.slice(offset, offset + n);
        offset += slice.length;
        return {
          rows: slice.map((item) => columns.map((c) => cellOf(item[c.name]))),
          done: offset >= capped.length,
        };
      },
      async close() {
        offset = capped.length;
      },
    };
  }

  async cancel(): Promise<boolean> {
    if (!this.inFlight) return false;
    this.inFlight.abort();
    this.inFlight = null;
    return true;
  }

  /// Nothing is asked of the server: DynamoDB has no EXPLAIN, and the
  /// answer is fully determined by the statement and the table's key
  /// schema, both of which are already here.
  async explain(sql: string): Promise<{ format: 'json' | 'text'; plan: string }> {
    const { table } = parseTarget(sql);
    const shape = table ? ((await this.describe(table).catch(() => null)) ?? undefined) : undefined;
    return { format: 'json', plan: JSON.stringify(analyzePartiql(sql, shape)) };
  }

  /// DynamoDB does not keep a query history anywhere a client can reach.
  /// The nearest equivalents — CloudWatch metrics and Contributor Insights
  /// — are a different AWS API against a different service, not something
  /// this session can ask the table for.
  async slowQuerySupport(): Promise<SlowQuerySupport> {
    return {
      supported: false,
      reason: {
        code: 'unsupported',
        detail:
          'DynamoDB keeps no server-side statement history. Per-request cost shows up in CloudWatch, which is a separate service rather than something this connection can query.',
        engine: 'dynamodb',
      },
    };
  }

  async slowQueries(): Promise<StatementStat[]> {
    return [];
  }

  async slowQueryExample(): Promise<string | null> {
    return null;
  }

  async resetSlowQueries(): Promise<void> {}

  /// DynamoDB reports on itself through CloudWatch, not through its data
  /// plane. There is no session list, no cache ratio and no scan counter to
  /// read over this connection — so this says exactly that rather than
  /// rendering a dashboard of zeroes.
  async health(): Promise<HealthSnapshot> {
    return {
      ...emptyHealth('dynamodb'),
      notes: [
        'DynamoDB has no sessions, no connection ceiling and no server-side statement statistics — every client call is an independent HTTPS request.',
        'Throughput, throttling and latency live in CloudWatch, which is a different API from the one this connection speaks.',
      ],
    };
  }

  async killSession(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'DynamoDB has no sessions to kill.' };
  }

  /// DynamoDB has no interactive transactions. TransactWriteItems is a
  /// single all-or-nothing call, not a session you hold open, so there is
  /// nothing here to begin or roll back — and saying so is better than
  /// offering a Rollback button that quietly does nothing.
  async beginTransaction(): Promise<void> {
    throw new Error(
      'DynamoDB has no interactive transactions — each statement stands alone. ' +
        'Use auto-commit on this connection.',
    );
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  inTransaction(): boolean {
    return false;
  }

  async close(): Promise<void> {
    this.inFlight?.abort();
    this.inFlight = null;
    this.client?.destroy();
    this.client = null;
  }


  /// The SQL habit that costs the most here: writing FROM "schema"."table".
  ///
  /// DynamoDB has no schemas, and the dotted form already means something —
  /// "table"."index". So a schema-qualified reference is not a syntax error
  /// the server can name; it is a lookup of a table that does not exist,
  /// reported as such, while the table you meant is sitting right there
  /// under the second half of the name. Caught before the send, because the
  /// answer is one we can be sure of.
  private async schemaQualified(statement: string, shape: DynamoTableShape | undefined): Promise<string | null> {
    if (shape) return null;
    const { table, index } = parseTarget(statement);
    if (!table || !index) return null;
    // Two ways this goes wrong, and they need different answers. Either the
    // region was written as a qualifier (the table is the second half), or a
    // table whose own NAME contains a dot — `LOCAL.event-log-v2` is a real
    // and common shape — was split across the separator.
    const joined = `${table}.${index}`;
    if (await this.describe(joined).catch(() => null)) {
      return (
        `${joined} is one table name, not a table and an index. Quote it whole: ` +
        `FROM "${joined}".`
      );
    }
    if (await this.describe(index).catch(() => null)) {
      return (
        `There is no table called ${table}. DynamoDB has no schemas, and "${table}"."${index}" ` +
        `means the index ${index} on the table ${table} — the region is chosen by the connection, ` +
        `never written in the statement. Use FROM "${index}".`
      );
    }
    return null;
  }

  private require(): DynamoDBClient {
    if (!this.client) throw new Error('dynamodb adapter is not connected');
    return this.client;
  }
}

/// A DynamoDB table's shape in the shared SchemaSnapshot vocabulary. Only
/// key attributes exist as "columns", because those are the only attributes
/// DynamoDB itself declares — everything else varies per item, and inventing
/// a column list from a sample would be a guess presented as a fact.
export function tableInfoOf(shape: DynamoTableShape): TableInfo {
  const keyAttrs = new Set<string>([shape.keys.partitionKey]);
  if (shape.keys.sortKey) keyAttrs.add(shape.keys.sortKey);
  for (const idx of shape.indexes) {
    keyAttrs.add(idx.keys.partitionKey);
    if (idx.keys.sortKey) keyAttrs.add(idx.keys.sortKey);
  }

  return {
    name: shape.name,
    kind: 'table',
    columns: [...keyAttrs].map((name, ordinal) => ({
      name,
      ordinal,
      typeName: 'key attribute',
      nullable: false,
      defaultExpr: null,
    })),
    primaryKey: [shape.keys.partitionKey, ...(shape.keys.sortKey ? [shape.keys.sortKey] : [])],
    indexes: shape.indexes.map((i) => ({
      name: i.name,
      columns: [i.keys.partitionKey, ...(i.keys.sortKey ? [i.keys.sortKey] : [])],
      // A GSI's key is not unique — several items can share it — and saying
      // otherwise would let the grid build an UPDATE that hits many rows.
      unique: false,
    })),
    foreignKeys: [],
  };
}
