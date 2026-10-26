// `overdb serve --mcp`: the app's connections, offered to an agent over
// stdio. The tools are in src/mcp/tools.ts and the read-only wiring in
// src/mcp/wiring.ts, shared with the headless server; this file is what
// only the app has — its store, its keychain, its tunnels.
//
// It is the Overdb binary started without a window, not a separate Node
// program, because the passwords are encrypted with Electron's safeStorage
// under the app's own keychain identity — only this binary can read them
// without a prompt. So an MCP client is configured with the app's path:
//
//   claude mcp add overdb -- /Applications/Overdb.app/Contents/MacOS/Overdb serve --mcp
//
// It runs beside the app, not inside it, and shares only what is on disk:
// the store and the secrets, read here and never written. A connection
// exposed or hidden in the app takes effect on the next tool call.

import { app } from 'electron';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import * as db from './dbSupervisor';
import { resolveWithTunnel } from './credentials';
import { closeAllTunnels, closeTunnel } from './tunnel';
import { readConnectionsFromDisk } from './store';
import { createOverdbMcpServer, exposedConnections } from '../mcp/tools';
import { catalogCache, wireMcp } from '../mcp/wiring';
import { agentContextFor } from './agentContext';
import { describeText, serverInstructions } from '../shared/agentContext';

function err(line: string): void {
  process.stderr.write(`overdb mcp: ${line}\n`);
}

export async function serveMcp(): Promise<void> {
  app.dock?.hide();

  const deps = wireMcp(db, {
    connections: readConnectionsFromDisk,
    resolveSpec: (conn) => resolveWithTunnel(conn, conn.id, { readOnly: true }),
    closed: closeTunnel,
    log: err,
  });
  const catalog = catalogCache(db);
  // Read once by the client as it connects: what is on disk now, without
  // opening a database. describe_database is the live, fuller answer.
  const exposedNow = exposedConnections(readConnectionsFromDisk());
  const instructions = serverInstructions(
    await Promise.all(exposedNow.map(async (c) => ({ name: c.name, ctx: (await agentContextFor(c.id)).ctx }))),
  );
  const server = createOverdbMcpServer(
    {
      ...deps,
      describe: async (conn, question) => {
        // Unreachable is no reason to say nothing: the setting, the recipe
        // and the map are on disk. Only detection and the staleness check
        // need the catalog.
        const snapshot = await deps.ensureOpen(conn).then(() => catalog(conn.id)).catch(() => undefined);
        const { ctx, map } = await agentContextFor(conn.id, snapshot);
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
    closeAllTunnels();
    await db.closeAll().catch(() => undefined);
    // exit, not quit: quit runs the app's before-quit, which is about the
    // proxy and the branches — none of which this process started.
    app.exit(0);
  };
  // The client going away is the only signal a stdio server gets.
  process.stdin.on('end', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());

  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  await server.connect(transport);

  const exposed = exposedConnections(readConnectionsFromDisk());
  err(
    exposed.length
      ? `serving ${exposed.length} connection${exposed.length === 1 ? '' : 's'}: ${exposed.map((c) => c.name).join(', ')}`
      : 'no connection is open to agents yet. Turn on "Agents" in a connection\'s Read-only menu in overdb.',
  );
}
