// `node dist/mcp/headless.js --connections FILE`: overdb's MCP tools with no
// app, for a server — overgo, a container, anything without a desktop.
//
// The same tools and the same read-only rules as `Overdb serve --mcp`
// (src/mcp/wiring.ts), over a different source of connections. The app
// reads the person's own store and keychain; this reads a hosted
// connections file (src/shared/hostedConnection.ts) that holds no secret,
// and resolves each credential from what the server itself has:
//
//   aws-iam   an IAM token signed with the server's AWS role
//   secret    an environment variable, set on this process by whoever runs it
//   none      nothing — DynamoDB uses the role through the provider chain
//
// The file is read on every call, so adding a connection to it needs no
// restart. Electron-free: src/db/noElectron.test.ts walks this file.

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { Connection } from '../shared/types';
import { hostedAgentContext, parseHostedFile, type HostedContext } from '../shared/hostedConnection';
import { changedSince, describeText, serverInstructions } from '../shared/agentContext';
import { specFor } from '../main/connectSpec';
import { awsIamToken } from '../main/credentialImport/awsIam';
import { createOverdbMcpServer } from './tools';
import { catalogCache, wireMcp } from './wiring';
import type { QueryLogEntry } from './tools';
import { createNodeSupervisor } from './nodeSupervisor';

const USAGE = 'usage: node dist/mcp/headless.js --connections FILE [--query-log FILE]   (or set OVERDB_CONNECTIONS)';
/// A query log past this is moved to FILE.1 and started again.
const QUERY_LOG_MAX_BYTES = 5 * 1024 * 1024;

function err(line: string): void {
  process.stderr.write(`overdb mcp: ${line}\n`);
}

export function queryLogPath(argv: readonly string[]): string | null {
  const at = argv.indexOf('--query-log');
  return at >= 0 && argv[at + 1]?.trim() ? path.resolve(argv[at + 1]) : null;
}

/// One JSON line per call. Who asked comes from the environment the agent's
/// runtime gave this process — overcli names the worker and its run
/// conversation — and is simply absent where nobody said.
export function queryLogger(file: string, env: NodeJS.ProcessEnv): (entry: QueryLogEntry) => void {
  const who = {
    ...(env.OVERCLI_WORKER ? { worker: env.OVERCLI_WORKER } : {}),
    ...(env.OVERCLI_CONVERSATION ? { conversation: env.OVERCLI_CONVERSATION } : {}),
  };
  return (entry) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Sized through the open file, never by checking the path and then
      // using it: whatever the path names by the time of the write is what
      // was checked.
      let fd = fs.openSync(file, 'a', 0o600);
      try {
        if (fs.fstatSync(fd).size > QUERY_LOG_MAX_BYTES) {
          fs.closeSync(fd);
          fs.renameSync(file, `${file}.1`);
          fd = fs.openSync(file, 'a', 0o600);
        }
        fs.writeSync(fd, `${JSON.stringify({ ...who, ...entry })}\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      err(`can't write the query log: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

export function connectionsPath(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const at = argv.indexOf('--connections');
  const value = at >= 0 ? argv[at + 1] : env.OVERDB_CONNECTIONS;
  return value?.trim() ? path.resolve(value) : null;
}

/// The file, read now. Problems are logged when they change rather than on
/// every call, so a standing typo is one line in the log, not thousands.
function connectionReader(file: string): () => { connections: Connection[]; contexts: Record<string, HostedContext> } {
  let reported = '';
  return () => {
    let parsed: ReturnType<typeof parseHostedFile>;
    try {
      parsed = parseHostedFile(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch (e) {
      parsed = { connections: [], contexts: {}, problems: [`can't read ${file}: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const now = parsed.problems.join('\n');
    if (now && now !== reported) for (const p of parsed.problems) err(p);
    reported = now;
    return parsed;
  };
}

async function credentialFor(conn: Connection): Promise<{ password?: string; user?: string }> {
  switch (conn.secretSource) {
    case 'env': {
      const value = conn.secretEnvVar ? process.env[conn.secretEnvVar] : undefined;
      if (!value) throw new Error(`${conn.secretEnvVar} is not set on this server, so ${conn.name} has no password.`);
      return { password: value };
    }
    case 'aws-iam': {
      const result = await awsIamToken({
        host: conn.host!,
        port: conn.port ?? (conn.engine === 'mysql' ? 3306 : 5432),
        user: conn.user,
        database: conn.database,
        region: conn.region,
      });
      if (!result.ok) throw new Error(result.error);
      return { password: result.password, user: result.user };
    }
    default:
      return {};
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const file = connectionsPath(argv, process.env);
  if (!file) {
    err(USAGE);
    process.exit(2);
  }
  // stdout belongs to JSON-RPC.
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;

  const sup = createNodeSupervisor(path.join(__dirname, '..', 'dbhost', 'index.js'));
  const read = connectionReader(file);
  const connections = () => read().connections;
  const logFile = queryLogPath(argv);
  const deps = wireMcp(sup, {
    connections,
    resolveSpec: async (conn) => specFor(conn, await credentialFor(conn), { readOnly: true }),
    log: err,
  });
  const catalog = catalogCache(sup);
  // What each database's publisher said agents should know, as published.
  const startup = read();
  const instructions = serverInstructions(
    startup.connections.map((c) => ({ name: c.name, ctx: hostedAgentContext(startup.contexts[c.id]).ctx })),
  );
  const server: McpServer = createOverdbMcpServer(
    {
      ...deps,
      ...(logFile ? { record: queryLogger(logFile, process.env) } : {}),
      describe: async (conn, question) => {
        const hc = read().contexts[conn.id];
        // The server's own catalog says whether the map is out of date. Down
        // or unreachable, the published context is still worth giving.
        const snapshot = await deps.ensureOpen(conn).then(() => catalog(conn.id)).catch(() => undefined);
        const changed = hc?.map && snapshot ? changedSince(hostedAgentContext(hc).map!, snapshot) : [];
        const { ctx, map } = hostedAgentContext(hc, changed);
        return describeText(conn.name, ctx, map, question);
      },
    },
    { instructions },
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close().catch(() => undefined);
    await sup.closeAll().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on('end', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());

  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  await server.connect(transport);
  const names = startup.connections.map((c) => c.name);
  err(names.length ? `serving ${names.length} connection${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : `no usable connection in ${file}`);
}

if (require.main === module) {
  main().catch((e) => {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
