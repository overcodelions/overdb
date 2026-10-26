// The tools `overdb serve --mcp` offers, as an MCP server.
//
// Read-only, and only over connections the user exposed (`mcpExposed`). An
// unexposed connection is not refused — it is not there: it is never
// listed, and naming it gets the same answer as naming one that does not
// exist, so an agent cannot learn what else this machine can reach.
//
// None of this is the boundary. Every session is opened in the engine's own
// read-only mode (see mcpServe.ts), and that refusal is what protects the
// database. The statement check below exists to answer an agent's write
// with a sentence it can act on, rather than a driver error.
//
// Tool names matter to more than the reader. overcli decides whether an
// unattended worker may call an MCP tool without an approval from the
// tool's NAME (isReadOnlyMcpTool in overcli's src/shared/flows/mcpTools.ts):
// it has to contain a read word and no write word. `run` is a write word,
// so a `run_query` would stop every worker step for a click. Hence `query`.
//
// Electron-free: everything that touches a process or a secret is in
// `deps`, so a test drives this over the SDK's in-memory transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Cell, ColumnMeta, Connection, SchemaSnapshot } from '../shared/types';
import type { HealthSnapshot } from '../shared/health';
import type { SlowQuerySupport, StatementStat } from '../shared/slowQueries';
import { classify, splitStatements } from '../shared/sqlGuard';

/// What a query hands back unless the agent asks for more, and the most it
/// may ask for. A model's context is not the place for a table dump.
export const DEFAULT_ROWS = 100;
export const MAX_ROWS = 1000;
/// A cell longer than this is cut, and says so. One JSON column can
/// otherwise outweigh the rest of the result.
export const MAX_CELL_CHARS = 2000;

export interface CollectedRows {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}

/// One line of the query log: what an agent asked of which database, and
/// how it went. Never rows, never bound values — those are data.
export interface QueryLogEntry {
  at: string;
  tool: string;
  /// As the agent named it, when it named one that is not open to it.
  connection: string;
  ok: boolean;
  ms: number;
  sql?: string;
  /// describe_database's question, in the agent's words.
  question?: string;
  params?: number;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

export interface McpDeps {
  /// Every connection, read fresh: exposing one in the app takes effect on
  /// the next call, without restarting the client.
  connections(): Connection[];
  /// Open the connection read-only if it is not open. Throws a message fit
  /// to show the agent.
  ensureOpen(conn: Connection): Promise<void>;
  listTables(conn: Connection): Promise<Array<{ schema: string; table: string; kind: string }>>;
  introspect(conn: Connection, opts: { schemas?: string[]; tables?: string[] }): Promise<SchemaSnapshot>;
  query(conn: Connection, sql: string, params: unknown[] | undefined, maxRows: number): Promise<CollectedRows>;
  health(conn: Connection): Promise<HealthSnapshot>;
  slowQuerySupport(conn: Connection): Promise<SlowQuerySupport>;
  slowQueries(conn: Connection, limit: number): Promise<StatementStat[]>;
  /// What the people who run this database want an agent to know: tenancy,
  /// notes, and overdb's map of the code (src/shared/agentContext.ts).
  /// Absent: there is nothing beyond the catalog.
  describe?(conn: Connection, question: string | undefined): Promise<string>;
  /// One line per call, to stderr: which connection, which tool, and the
  /// statement when there is one.
  log?(line: string): void;
  /// Every call that names a connection, for an audit (`--query-log`).
  record?(entry: QueryLogEntry): void;
}

export function exposedConnections(all: Connection[]): Connection[] {
  return all.filter((c) => c.mcpExposed === true);
}

/// By id, or by name ignoring case — agents are handed names in prose.
export function findExposed(all: Connection[], ref: string): Connection | null {
  const exposed = exposedConnections(all);
  const wanted = ref.trim();
  return (
    exposed.find((c) => c.id === wanted) ??
    exposed.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

/// Why this statement will not be sent, or null when it may be. One
/// statement at a time, and it must read: a batch that hides an UPDATE
/// behind a SELECT gets the same answer as the UPDATE.
export function queryRefusal(sql: string, conn: Connection): string | null {
  const statements = splitStatements(sql, conn.engine);
  if (statements.length === 0) return 'There is no statement to run.';
  if (statements.length > 1) return 'Send one statement at a time.';
  const kind = classify(statements[0].sql);
  if (kind === 'read') return null;
  return `overdb only runs reads for agents, and this reads as ${kind === 'unknown' ? 'something it cannot classify' : `a ${kind} statement`}. Nothing was sent to ${conn.name}.`;
}

/// Cells as JSON can carry them: binary as a description, long text cut.
export function cellOut(cell: Cell): Cell | string {
  if (cell !== null && typeof cell === 'object') {
    return `<${cell.byteLength} bytes${cell.truncated ? ', truncated' : ''}>`;
  }
  if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
    return `${cell.slice(0, MAX_CELL_CHARS)}… (${cell.length} chars)`;
  }
  return cell;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function describeConnection(c: Connection) {
  return {
    id: c.id,
    name: c.name,
    env: c.env ?? null,
    engine: c.engine,
    database: c.database ?? c.defaultSchema ?? c.file ?? null,
  };
}

const connectionArg = z
  .string()
  .describe('A connection name or id from list_connections.');

export function createOverdbMcpServer(deps: McpDeps, opts: { instructions?: string } = {}): McpServer {
  const server = new McpServer({ name: 'overdb', version: '1' }, opts.instructions ? { instructions: opts.instructions } : undefined);
  const log = deps.log ?? (() => undefined);

  /// Resolve the connection, open it, run `body`; every failure becomes a
  /// tool error rather than a protocol error, so the agent reads it.
  async function on(
    ref: string,
    tool: string,
    body: (conn: Connection, note: Partial<QueryLogEntry>) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const started = Date.now();
    const note: Partial<QueryLogEntry> = {};
    const result = await attempt();
    deps.record?.({
      at: new Date(started).toISOString(),
      tool,
      connection: note.connection ?? ref,
      ok: !result.isError,
      ms: Date.now() - started,
      ...note,
      ...(result.isError ? { error: (result.content[0] as { text?: string })?.text?.slice(0, 500) } : {}),
    });
    return result;

    async function attempt(): Promise<CallToolResult> {
      const conn = findExposed(deps.connections(), ref);
      if (!conn) {
        return fail(`No connection called "${ref}" is open to agents. list_connections shows the ones that are.`);
      }
      note.connection = conn.name;
      try {
        await deps.ensureOpen(conn);
        return await body(conn, note);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`${tool} on ${conn.name} failed: ${message}`);
        return fail(message);
      }
    }
  }

  server.registerTool(
    'list_connections',
    {
      description:
        'List the databases overdb lets you read: name, environment (local/staging/prod), engine and database. ' +
        'Only connections the user opted in are listed. Every tool here is read-only.',
      inputSchema: {},
    },
    async () => json(exposedConnections(deps.connections()).map(describeConnection)),
  );

  server.registerTool(
    'query',
    {
      description:
        'Run one read-only SQL statement (SELECT, WITH, SHOW, EXPLAIN …) on a connection and return its rows. ' +
        `Returns at most ${DEFAULT_ROWS} rows unless maxRows says otherwise (up to ${MAX_ROWS}); "truncated" says when there were more. ` +
        'Writes and DDL are refused, and the session is read-only on the server as well.',
      inputSchema: {
        connection: connectionArg,
        sql: z.string().describe('One statement. Use placeholders and params for values.'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Values bound to the placeholders ($1 on Postgres, ? on MySQL and SQLite).'),
        maxRows: z.number().int().positive().max(MAX_ROWS).optional(),
      },
    },
    async ({ connection, sql, params, maxRows }) =>
      on(connection, 'query', async (conn, note) => {
        note.sql = sql.slice(0, 4000);
        if (params?.length) note.params = params.length;
        const refusal = queryRefusal(sql, conn);
        if (refusal) return fail(refusal);
        log(`query on ${conn.name}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
        const result = await deps.query(conn, sql, params, maxRows ?? DEFAULT_ROWS);
        note.rowCount = result.rowCount;
        note.truncated = result.truncated;
        return json({
          columns: result.columns.map((c) => c.name),
          rows: result.rows.map((r) => r.map(cellOut)),
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
      }),
  );

  server.registerTool(
    'describe_database',
    {
      description:
        'What to know before writing SQL for a connection: whether it is multi-tenant and how to scope queries, notes from the people who run it, ' +
        "and what the application code says about the tables a question touches — what each is for, the values status columns take, links the schema doesn't declare. " +
        'Call it first. Without a question it gives an overview.',
      inputSchema: {
        connection: connectionArg,
        question: z.string().optional().describe('What you are trying to find out, in words. The answer is about the tables it touches.'),
      },
    },
    async ({ connection, question }) => {
      const conn = findExposed(deps.connections(), connection);
      if (!conn) return on(connection, 'describe_database', async () => fail('unreachable'));
      if (!deps.describe) return json(`overdb has nothing on ${conn.name} beyond its catalog: list_tables and describe_table show it.`);
      // Not through on(): it must answer even when the database is down.
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = { content: [{ type: 'text', text: await deps.describe(conn, question) }] };
      } catch (err) {
        result = fail(err instanceof Error ? err.message : String(err));
      }
      deps.record?.({
        at: new Date(started).toISOString(),
        tool: 'describe_database',
        connection: conn.name,
        ok: !result.isError,
        ms: Date.now() - started,
        ...(question?.trim() ? { question: question.slice(0, 500) } : {}),
      });
      return result;
    },
  );

  server.registerTool(
    'list_tables',
    {
      description: 'List the tables and views on a connection, by schema. Names only; describe_table gives columns.',
      inputSchema: {
        connection: connectionArg,
        schema: z.string().optional().describe('Only this schema (a database, on MySQL).'),
      },
    },
    async ({ connection, schema }) =>
      on(connection, 'list_tables', async (conn) => {
        const tables = await deps.listTables(conn);
        return json(schema ? tables.filter((t) => t.schema === schema) : tables);
      }),
  );

  server.registerTool(
    'describe_table',
    {
      description: 'Columns, types, primary key, indexes and foreign keys of one table.',
      inputSchema: {
        connection: connectionArg,
        table: z.string().describe('The table name, optionally qualified as schema.table.'),
      },
    },
    async ({ connection, table }) =>
      on(connection, 'describe_table', async (conn) => {
        const dot = table.indexOf('.');
        const schema = dot > 0 ? table.slice(0, dot) : undefined;
        const name = dot > 0 ? table.slice(dot + 1) : table;
        const snapshot = await deps.introspect(conn, {
          ...(schema ? { schemas: [schema] } : {}),
          tables: [name],
        });
        const hits = snapshot.schemas.flatMap((s) =>
          s.tables.filter((t) => t.name === name).map((t) => ({ schema: s.name, ...t })),
        );
        if (hits.length === 0) return fail(`There is no table called ${table} on ${conn.name}.`);
        return json(hits.length === 1 ? hits[0] : hits);
      }),
  );

  server.registerTool(
    'show_sessions',
    {
      description:
        'The sessions on the server right now: who, from where, what each is running, for how long, and what it is waiting on or blocked by.',
      inputSchema: { connection: connectionArg },
    },
    async ({ connection }) =>
      on(connection, 'show_sessions', async (conn) => {
        const health = await deps.health(conn);
        return json({
          capturedAt: health.capturedAt,
          connections: health.connections,
          sessions: health.sessions.map((s) => ({
            ...s,
            query: typeof s.query === 'string' ? cellOut(s.query) : s.query,
          })),
        });
      }),
  );

  server.registerTool(
    'list_slow_queries',
    {
      description:
        'The statements the server spends the most time on, across every client, from pg_stat_statements or performance_schema. ' +
        'Text is normalized by the server, so literals are already replaced.',
      inputSchema: {
        connection: connectionArg,
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ connection, limit }) =>
      on(connection, 'list_slow_queries', async (conn) => {
        const support = await deps.slowQuerySupport(conn);
        if (!support.supported) return fail(`${conn.name} can't report statement timings. ${support.reason.detail}`);
        return json(await deps.slowQueries(conn, limit ?? 20));
      }),
  );

  return server;
}
