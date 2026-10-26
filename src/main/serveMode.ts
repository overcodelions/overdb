// `overdb serve --mcp`, settled before anything else runs. See mcpServe.ts.
//
// Imported second in index.ts, straight after devProfile, for two reasons
// that cannot wait for app.whenReady:
//
//   * stdout belongs to JSON-RPC. One stray console.log from anywhere in
//     main and the client drops the connection, so in this mode every
//     console method writes to stderr instead.
//   * The app may be open at the same time, on the same userData folder.
//     The store and the secrets are read from there on purpose, but
//     Chromium's own session files (cache, cookies, local storage) would be
//     two processes writing one folder, so this process gets its own.

import path from 'node:path';
import { app } from 'electron';
import { isServeMcp } from './serveArgs';

export const SERVE_MCP = isServeMcp(process.argv);

if (SERVE_MCP) {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  app.setPath('sessionData', path.join(app.getPath('userData'), 'mcp-session'));
}
