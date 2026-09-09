// Electron main process entry. Creates the window and registers every
// IPC handler the renderer invokes.
//
// This file is the ONLY place allowed to know about both Electron and
// overdb's engine layer, and even then it reaches the engines through
// `dbSupervisor` rather than importing `src/db` directly. `src/db` never
// imports electron — see src/db/noElectron.test.ts for why that matters.

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import * as db from './dbSupervisor';
import { resolve as resolveCredentials } from './credentials';
import { deleteSecret, hasSecret, isEncryptionAvailable, setSecret } from './secrets';
import { readOpSecret } from './credentialImport/onePassword';
import { scanAll } from './credentialImport';
import type { SchemaSnapshot, SecretSource } from '../shared/types';
import { detectTools, extractSql, runOneShot, type AiTool } from './ai';
import { buildSchemaContext } from './schemaContext';
import { askPrompt, explainPrompt, fixPrompt, sqlPrompt } from './aiPrompts';
import { getCached, invalidate, putCached } from './schemaCache';
import type { QueryOrigin } from '../shared/types';

// Dev vs prod: hit the Vite dev server only when VITE_DEV_SERVER_URL is
// set (the dev:electron npm script sets it). Anything else — packaged
// .app, `npm start`, plain `electron .` — loads the built file:// HTML.
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

// build/icon.png is the master electron-builder derives .icns/.ico from
// at packaging time. We point at it directly too, so the dock/window
// shows our mark when running unpackaged.
const ICON_PATH = path.resolve(__dirname, '..', '..', 'build', 'icon.png');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'overdb',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1c21',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev && DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'undocked' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Lock the renderer to its initial origin: any navigation (rogue link,
  // redirect, window.open) is denied and bounced to the user's default
  // browser if the URL is plain http(s).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'mailto:' ||
      u.protocol === 'tel:'
    );
  } catch {
    return false;
  }
}

function registerIpc(): void {
  ipcMain.handle('store:load', () => Store.load());
  ipcMain.handle('store:saveConnections', (_e, connections) => Store.saveConnections(connections));
  ipcMain.handle('store:saveGroups', (_e, groups) => Store.saveGroups(groups));
  ipcMain.handle('store:saveEnvSets', (_e, envSets) => Store.saveEnvSets(envSets));
  ipcMain.handle('store:saveSettings', (_e, settings) => Store.saveSettings(settings));
  ipcMain.handle('store:saveBuffer', (_e, args: { connectionId: string; text: string }) =>
    Store.saveBuffer(args.connectionId, args.text),
  );

  ipcMain.handle('app:version', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));

  // Same allowlist the navigation lock uses — the renderer cannot talk
  // us into opening a file:// or custom-scheme URL.
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:pickSqliteFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open SQLite database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('app:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a folder to scan for project configs',
      properties: ['openDirectory'],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('import:scan', (_e, projectRoot?: string) => scanAll(projectRoot));

  ipcMain.handle('conn:setSecret', (_e, args: { connectionId: string; value: string }) => {
    setSecret(args.connectionId, args.value);
    return { ok: true, encrypted: isEncryptionAvailable() };
  });

  ipcMain.handle('conn:hasSecret', (_e, connectionId: string) => hasSecret(connectionId));

  // Reports whether a credential source WORKS. It deliberately reports the
  // value's length rather than the value: the form needs to tell you the
  // reference is good without ever putting the secret in the window.
  ipcMain.handle(
    'conn:probeSecret',
    async (_e, args: { source: SecretSource; envVar?: string; reference?: string }) => {
      if (args.source === 'env') {
        const value = args.envVar ? process.env[args.envVar] : undefined;
        return value
          ? { ok: true, detail: `$${args.envVar} is set (${value.length} characters).` }
          : { ok: false, detail: `$${args.envVar ?? '?'} is not set in overdb's environment.` };
      }
      if (args.source === 'op') {
        const result = await readOpSecret(args.reference ?? '');
        return result.ok
          ? { ok: true, detail: `Resolved (${result.value.length} characters).` }
          : { ok: false, detail: result.error };
      }
      return { ok: true, detail: 'No password will be sent.' };
    },
  );

  ipcMain.handle('conn:deleteSecret', async (_e, connectionId: string) => {
    // Close first: a live host is holding the credential we're about to
    // remove, and leaving it running would keep a connection alive that the
    // user believes they just deleted.
    await db.closeConnection(connectionId);
    deleteSecret(connectionId);
    Store.dropBuffer(connectionId);
  });

  ipcMain.handle('conn:open', async (_e, connectionId: string) => {
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (!conn) return { ok: false, error: 'No such connection.' };
    try {
      const ping = (await db.openConnection(connectionId, await resolveCredentials(conn))) as {
        ok: boolean; serverVersion?: string; error?: string;
      };
      return ping;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('conn:close', (_e, connectionId: string) => db.closeConnection(connectionId));
  ipcMain.handle('conn:isOpen', (_e, connectionId: string) => db.isOpen(connectionId));

  ipcMain.handle('conn:introspect', (_e, args: { connectionId: string; schemas?: string[] }) =>
    db.request(args.connectionId, { op: 'introspect', schemas: args.schemas }),
  );

  ipcMain.handle('ai:detect', () => detectTools());

  ipcMain.handle(
    'ai:ask',
    async (
      _e,
      args: {
        connectionId: string;
        tool: AiTool;
        mode: 'ask' | 'sql' | 'explain' | 'fix';
        failingSql?: string;
        errorText?: string;
        question: string;
        editorText?: string;
        history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      },
    ) => {
      const empty = { sql: null, contextTables: [], totalTables: 0 };
      let snapshot = getCached(args.connectionId);
      if (!snapshot) {
        try {
          snapshot = (await db.request(args.connectionId, { op: 'introspect' })) as SchemaSnapshot;
          putCached(args.connectionId, snapshot);
        } catch (err) {
          return {
            ok: false, message: '', ...empty,
            error: `Could not read the schema: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      // For a repair, the failing statement is the best description of what
      // schema matters — far better than the user's words, which may be empty.
      const context = buildSchemaContext(
        snapshot,
        `${args.question} ${args.failingSql ?? ''} ${args.errorText ?? ''}`,
        { editorText: args.editorText },
      );

      // The plan is fetched HERE rather than asked for: an explanation built
      // on a real plan is worth far more than one built on the model's guess
      // at what the planner would do.
      let plan: string | undefined;
      if (args.mode === 'explain' && args.editorText?.trim()) {
        try {
          const result = (await db.request(args.connectionId, {
            op: 'explain', sql: args.editorText.trim().replace(/;\s*$/, ''), analyze: false,
          })) as { plan: string };
          plan = result.plan;
        } catch {
          // An unexplainable statement still gets a prose answer.
        }
      }

      const input = {
        engine: snapshot.engine,
        serverVersion: snapshot.serverVersion,
        schemaContext: context.text,
        question: args.question,
        editorText: args.editorText,
        history: args.history,
        plan,
      };
      const prompt =
        args.mode === 'sql' ? sqlPrompt(input)
        : args.mode === 'explain' ? explainPrompt(input)
        : args.mode === 'fix'
          ? fixPrompt({ ...input, failingSql: args.failingSql ?? '', errorText: args.errorText ?? '' })
          : askPrompt(input);

      // Repair and translation both sit directly in the typing loop — you
      // are blocked, watching, and you will read the output before running
      // it. Both are short, well-constrained tasks with the schema supplied,
      // so they take the fast model. Open-ended Ask and plan interpretation
      // keep the default model, where reasoning quality is the whole point.
      const fast = args.mode === 'fix' || args.mode === 'sql';
      const result = await runOneShot(args.tool, prompt, {
        model: fast ? Store.load().settings.aiFastModel[args.tool] : undefined,
        timeoutMs: fast ? 45_000 : undefined,
      });
      return {
        ok: result.ok,
        message: result.output,
        sql: result.ok ? extractSql(result.output) : null,
        contextTables: context.included,
        totalTables: context.totalTables,
        error: result.error,
      };
    },
  );

  ipcMain.handle('conn:listTables', (_e, connectionId: string) =>
    db.request(connectionId, { op: 'listTables' }),
  );

  ipcMain.handle('conn:listSchemas', (_e, connectionId: string) =>
    db.request(connectionId, { op: 'listSchemas' }),
  );

  ipcMain.handle('conn:useSchema', (_e, args: { connectionId: string; name: string }) => {
    invalidate(args.connectionId);
    return db.request(args.connectionId, { op: 'useSchema', name: args.name });
  });

  ipcMain.handle(
    'query:run',
    async (_e, args: { connectionId: string; sql: string; origin: QueryOrigin }) => {
      const runId = randomUUID();
      const rowLimit = Store.load().settings.rowLimit;
      await db.request(args.connectionId, {
        op: 'run',
        runId,
        sql: args.sql,
        maxRows: rowLimit,
        chunkRows: 500,
      });
      return { runId };
    },
  );

  ipcMain.handle('query:ack', (_e, args: { connectionId: string; runId: string; seq: number }) => {
    db.notify(args.connectionId, { op: 'ack', runId: args.runId, seq: args.seq });
  });

  ipcMain.handle(
    'query:explain',
    (_e, args: { connectionId: string; sql: string; analyze: boolean }) =>
      db.request(args.connectionId, {
        op: 'explain',
        sql: args.sql.trim().replace(/;\s*$/, ''),
        analyze: args.analyze,
      }),
  );

  ipcMain.handle('query:cancel', (_e, args: { connectionId: string; runId: string }) =>
    db.cancelRun(args.connectionId, args.runId),
  );
}

app.whenReady().then(() => {
  // Packaged macOS builds get the dock icon from the .app bundle's
  // .icns, but unpackaged runs show the default Electron mark unless we
  // set it explicitly.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(ICON_PATH);
    } catch {
      // ignore: missing/unreadable icon shouldn't block startup
    }
  }
  // Streaming query results reach the renderer as main:event pushes; the
  // renderer acks each chunk, which is what applies backpressure all the
  // way down to the cursor in the connection host.
  db.onHostEvent((event) => {
    if (event.kind === 'chunk') {
      mainWindow?.webContents.send('main:event', {
        kind: 'query:chunk', runId: event.runId, seq: event.seq,
        columns: event.columns, rows: event.rows,
      });
    } else if (event.kind === 'done') {
      mainWindow?.webContents.send('main:event', {
        kind: 'query:done', runId: event.runId,
        rowCount: event.rowCount, truncated: event.truncated,
      });
    } else if (event.kind === 'failed') {
      mainWindow?.webContents.send('main:event', {
        kind: 'query:error', runId: event.runId, message: event.message,
      });
    }
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  void db.closeAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
