// Electron main process entry. Creates the window and registers every
// IPC handler the renderer invokes.
//
// This file is the ONLY place allowed to know about both Electron and
// overdb's engine layer, and even then it reaches the engines through
// `dbSupervisor` rather than importing `src/db` directly. `src/db` never
// imports electron — see src/db/noElectron.test.ts for why that matters.

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import * as db from './dbSupervisor';
import { resolveWithTunnel } from './credentials';
import { copySecret, deleteSecret, hasSecret, isEncryptionAvailable, secretsBackend, setSecret } from './secrets';
import { readOpSecret } from './credentialImport/onePassword';
import { runSecretCommand } from './credentialImport/command';
import { readEnvFileVar } from './credentialImport/envFile';
import { awsIamToken, regionFromHost } from './credentialImport/awsIam';
import { closeAllTunnels, closeTunnel } from './tunnel';
import { scanAll, takeScannedPassword } from './credentialImport';
import type {
  AppSettings,
  AskTurn,
  Connection,
  ConnectionDraft,
  ConnectionTestResult,
  SchemaSnapshot,
  SecretSource,
  StoreSnapshot,
} from '../shared/types';
import type { Variant } from '../shared/engines';
import { referencedSchemas } from '../shared/qualifiedRefs';
import { filterTableNames } from '../shared/tableFilter';
import { classify } from '../shared/sqlGuard';
import { bindFor } from '../shared/params';
import * as writeGate from './writeGate';
import { discoverLocal } from './discoverLocal';
import { detectTools, extractSql, runOneShot, type AiTool } from './ai';
import { buildSchemaContext } from './schemaContext';
import { askPrompt, explainPrompt, fasterPrompt, fixPrompt, refinePrompt, sqlPrompt } from './aiPrompts';
import {
  cachedCovers,
  cachedSchemaNames,
  getCached,
  invalidate,
  putCached,
} from './schemaCache';
import type { QueryOrigin } from '../shared/types';
import type { SlowQuerySupport } from '../shared/slowQueries';

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

/// Remove a known secret value from text on its way to the renderer.
/// Only exact substrings, which is all a driver ever echoes.
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('••••••');
}

/// Colour behind the renderer — painted before the first frame, and
/// visible at the window's edges during a resize. It has to follow the
/// theme, or a light workspace opens with a dark flash and resizes with a
/// dark halo.
const WINDOW_BG = { dark: '#1c1c21', light: '#f6f6f8' } as const;

/// Push the stored preference into the native layer. `themeSource` is what
/// macOS reads for the traffic lights, the native scrollbars and the
/// context menus — the renderer's `html.dark` class means nothing to them,
/// so a light workspace kept dark window chrome.
function applyTheme(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme;
  mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light);
}

function createWindow(): void {
  nativeTheme.themeSource = Store.load().settings.theme;
  // On 'system', the OS can change under us; the window's own colour has
  // to follow or it stays whatever it was painted at launch.
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(
      nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light,
    );
  });
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'overdb',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light,
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
  ipcMain.handle('store:saveConnections', (_e, connections: Connection[]) => {
    // A connection whose database changed must not keep an override from
    // before the edit — that is how the picker and the session drift apart.
    for (const next of connections) {
      const before = Store.load().connections.find((c) => c.id === next.id);
      if (before && (before.database !== next.database || before.host !== next.host)) {
        db.forgetSchema(next.id);
      }
    }
    Store.saveConnections(connections);
  });
  ipcMain.handle('store:saveGroups', (_e, groups) => Store.saveGroups(groups));
  ipcMain.handle('store:saveEnvSets', (_e, envSets) => Store.saveEnvSets(envSets));
  ipcMain.handle('store:saveSettings', (_e, settings: AppSettings) => {
    Store.saveSettings(settings);
    applyTheme(settings.theme);
  });
  ipcMain.handle('store:saveBuffer', (_e, args: { key: string; text: string }) =>
    Store.saveBuffer(args.key, args.text),
  );
  ipcMain.handle('store:dropBuffer', (_e, args: { key: string }) => Store.dropBuffer(args.key));
  ipcMain.handle('store:saveBufferState', (_e, args: StoreSnapshot['bufferState']) =>
    Store.saveBufferState(args),
  );

  ipcMain.handle(
    'store:saveAskThread',
    (_e, args: { connectionId: string; turns: AskTurn[] }) =>
      Store.saveAskThread(args.connectionId, args.turns),
  );

  ipcMain.handle('store:recordRun', (_e, run) => Store.recordRun(run));
  ipcMain.handle('store:clearHistory', () => Store.clearHistory());
  ipcMain.handle('store:saveQueries', (_e, saved) => Store.saveQueries(saved));
  ipcMain.handle('store:saveParams', (_e, params) => Store.saveParams(params));

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

  ipcMain.handle(
    'app:saveFile',
    async (
      _e,
      args: { suggestedName: string; data: string; encoding?: 'utf8' | 'base64'; extensions?: string[] },
    ) => {
      const res = await dialog.showSaveDialog({
        defaultPath: args.suggestedName,
        filters:
          args.extensions && args.extensions.length > 0
            ? [{ name: args.extensions.join(', ').toUpperCase(), extensions: args.extensions }]
            : undefined,
      });
      if (res.canceled || !res.filePath) return { saved: false };
      try {
        await fs.writeFile(res.filePath, Buffer.from(args.data, args.encoding ?? 'utf8'));
        return { saved: true, path: res.filePath };
      } catch (err) {
        // Reported rather than thrown: a full disk or a read-only folder is
        // the user's problem to see, not an unhandled rejection in a log.
        return { saved: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('import:scan', (_e, projectRoot?: string) => scanAll(projectRoot));

  ipcMain.handle('import:commit', (_e, args: { sourceId: string; connectionId: string }) => {
    const value = takeScannedPassword(args.sourceId);
    if (!value) return { stored: false, encrypted: false };
    setSecret(args.connectionId, value);
    return { stored: true, encrypted: isEncryptionAvailable() };
  });

  ipcMain.handle('conn:secretsEncrypted', () => ({
    encrypted: isEncryptionAvailable(),
    backend: secretsBackend(),
  }));

  ipcMain.handle('conn:setSecret', (_e, args: { connectionId: string; value: string }) => {
    setSecret(args.connectionId, args.value);
    return { ok: true, encrypted: isEncryptionAvailable() };
  });

  ipcMain.handle('conn:hasSecret', (_e, connectionId: string) => hasSecret(connectionId));

  ipcMain.handle('conn:copySecret', (_e, args: { fromId: string; toId: string }) =>
    copySecret(args.fromId, args.toId),
  );

  // Reports whether a credential source WORKS. It deliberately reports the
  // value's LENGTH rather than the value: the form needs to tell you the
  // reference is good without ever putting the secret in the window. Every
  // return path in here obeys that, including the failures — an error
  // message is a fine place to leak a password by accident.
  ipcMain.handle(
    'conn:probeSecret',
    async (
      _e,
      args: {
        source: SecretSource;
        envVar?: string;
        envFile?: string;
        reference?: string;
        argv?: string[];
        host?: string;
        port?: number;
        user?: string;
        region?: string;
        profile?: string;
      },
    ) => {
      const resolved = (n: number) => ({ ok: true, detail: `Resolved (${n} characters).` });

      if (args.source === 'env') {
        const value = args.envVar ? process.env[args.envVar] : undefined;
        if (value) return { ok: true, detail: `$${args.envVar} is set (${value.length} characters).` };
        if (args.envVar && args.envFile) {
          const file = readEnvFileVar(args.envFile, args.envVar);
          return file.ok
            ? { ok: true, detail: `Not in overdb's environment; read from the file (${file.value.length} characters).` }
            : { ok: false, detail: file.error };
        }
        return {
          ok: false,
          detail: `$${args.envVar ?? '?'} is not set in overdb's environment.`,
        };
      }
      if (args.source === 'op') {
        const result = await readOpSecret(args.reference ?? '');
        return result.ok ? resolved(result.value.length) : { ok: false, detail: result.error };
      }
      if (args.source === 'command') {
        // The renderer splits the command line (src/shared/argv.ts) and
        // sends argv. Main never splits a string, so there is no path here
        // where a stored command line could become a shell command.
        if (!args.argv?.length) return { ok: false, detail: 'No command is configured.' };
        const result = await runSecretCommand(args.argv);
        return result.ok ? resolved(result.value.length) : { ok: false, detail: result.error };
      }
      if (args.source === 'aws-iam') {
        if (!args.host) return { ok: false, detail: 'Set the host first — a token is signed for one endpoint.' };
        const result = await awsIamToken({
          host: args.host,
          port: args.port ?? 5432,
          user: args.user,
          database: undefined,
          region: args.region,
          profile: args.profile,
        });
        if (!result.ok) return { ok: false, detail: result.error };
        const region = args.region?.trim() || regionFromHost(args.host);
        return {
          ok: true,
          detail: `Signed a token for ${region} (${result.password.length} characters). It expires in 15 minutes and is re-minted on every connect.`,
        };
      }
      return { ok: true, detail: 'No password will be sent.' };
    },
  );

  // The renderer cannot browse the disk. It gets a PATH back, which is all
  // that is ever stored for a certificate or a key: the contents are read
  // by the connection host at connect time and never enter this window.
  ipcMain.handle('app:pickKeyFile', async (_e, kind: 'ca' | 'cert' | 'key' | 'identity' | 'envfile') => {
    const filters =
      kind === 'envfile'
        ? [{ name: 'Environment files', extensions: ['env', 'sh', 'txt', ''] }]
        : kind === 'identity'
          ? [{ name: 'SSH keys', extensions: ['pem', 'key', ''] }]
          : [{ name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key', 'p8'] }];
    const res = await dialog.showOpenDialog({
      title:
        kind === 'ca'
          ? 'Choose a CA certificate'
          : kind === 'cert'
            ? 'Choose a client certificate'
            : kind === 'key'
              ? 'Choose a client key'
              : kind === 'identity'
                ? 'Choose an SSH key'
                : 'Choose an env file',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [...filters, { name: 'All files', extensions: ['*'] }],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  // Test a draft. Nothing is saved, no live host is touched, and the reply
  // carries only what the SERVER said — never anything that went in.
  ipcMain.handle('conn:test', async (_e, draft: ConnectionDraft): Promise<ConnectionTestResult> => {
    // A draft is not a Connection: it has no id until it is saved, and the
    // fields it does have are whatever has been typed so far.
    const conn: Connection = {
      ...draft,
      id: draft.id ?? 'draft',
      name: draft.name ?? 'draft',
      env: draft.env ?? 'other',
      // Reading the stored password is only meaningful for a connection
      // that already exists — a new one has nothing under its id yet.
      secretRef: draft.secretSource === 'stored' && draft.id ? draft.id : undefined,
    };

    // A tunnel of its own, so testing a draft cannot disturb the tunnel a
    // live session is using — the same reason db.probe forks its own host.
    const tunnelKey = `test:${randomUUID()}`;
    let spec;
    try {
      spec = await resolveWithTunnel(conn, tunnelKey);
    } catch (err) {
      // 1Password, a credential command, an IAM token and the SSH tunnel
      // all fail HERE, before any database network is touched, and that
      // distinction is most of the answer.
      closeTunnel(tunnelKey);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // A password typed into the form beats the stored one: the point of
    // testing is to try the value you are about to save.
    if (draft.password) spec.password = draft.password;

    try {
      const result = await db.probe(spec);
      return {
        ok: result.ok,
        serverVersion: result.serverVersion,
        variant: result.variant as Variant | undefined,
        // Postgres and MySQL both echo connection parameters into some
        // errors. The password must not come back through the seam it was
        // never allowed to cross.
        error: result.error ? redact(result.error, spec.password) : undefined,
      };
    } finally {
      closeTunnel(tunnelKey);
    }
  });

  ipcMain.handle('conn:deleteSecret', async (_e, connectionId: string) => {
    // Close first: a live host is holding the credential we're about to
    // remove, and leaving it running would keep a connection alive that the
    // user believes they just deleted.
    await db.closeConnection(connectionId);
    closeTunnel(connectionId);
    deleteSecret(connectionId);
    Store.dropBuffers(connectionId);
  });

  ipcMain.handle('conn:open', async (_e, connectionId: string) => {
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (!conn) return { ok: false, error: 'No such connection.' };
    try {
      const spec = await resolveWithTunnel(conn, connectionId);
      const ping = (await db.openConnection(connectionId, spec)) as {
        ok: boolean; serverVersion?: string; error?: string; variant?: Variant;
      };
      // Same rule as conn:test, for the same reason: some drivers echo
      // connection parameters back inside an error, and the credential
      // must not reach the window through a failure path when it is not
      // allowed to reach it through a successful one.
      if (ping.error) ping.error = redact(ping.error, spec.password);

      // The server just told us what it actually is. Record it, so the
      // sidebar can say "Redshift" rather than "postgres" on every future
      // launch — including before this connection is opened again.
      if (ping.ok && ping.variant && ping.variant !== conn.variant) {
        Store.saveConnections(
          Store.load().connections.map((c) =>
            c.id === connectionId ? { ...c, variant: ping.variant } : c,
          ),
        );
      }
      return ping;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('conn:close', (_e, connectionId: string) => {
    // A cached catalog outlives the session it was read from, and editing a
    // connection closes and reopens it. Without this, changing the table
    // filter left the AI reading a five-minute-old snapshot that still
    // listed every table the filter was added to hide.
    invalidate(connectionId);
    // The tunnel outlives nothing: a closed connection that leaves an ssh
    // child forwarding a production port is exactly the kind of thing
    // nobody notices until they count processes.
    closeTunnel(connectionId);
    return db.closeConnection(connectionId);
  });
  ipcMain.handle('conn:isOpen', (_e, connectionId: string) => db.isOpen(connectionId));
  ipcMain.handle('conn:states', () => db.openConnectionIds());

  /// Reconnect on demand, for anything that cannot work without the host.
  ///
  /// A session dies under you for reasons that have nothing to do with you
  /// — the server restarted, the laptop slept, an idle timeout fired — and
  /// the first sign of it was a query failing with "connection is not
  /// open", which reads as the app being broken rather than as "press
  /// Connect". Asking to run something IS asking for the connection, so
  /// every path that needs the host opens it here instead of refusing.
  async function ensureOpen(connectionId: string): Promise<void> {
    if (db.isOpen(connectionId)) return;
    // Nothing gets reopened on the way out: quit closes every host, and a
    // late catalog request racing that would fork a child process for a
    // window that is already going.
    if (db.isShuttingDown()) throw new Error('The app is quitting.');
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('That connection no longer exists.');
    const spec = await resolveWithTunnel(conn, connectionId);
    const ping = (await db.openConnection(connectionId, spec)) as {
      ok?: boolean;
      error?: string;
    };
    // Same redaction rule as conn:open: a driver that echoes the DSN back
    // inside an error must not carry the password to the window.
    if (!ping?.ok) throw new Error(redact(ping?.error ?? 'Could not connect.', spec.password));
  }

  ipcMain.handle(
    'conn:introspect',
    async (_e, args: { connectionId: string; schemas?: string[] }) => {
      await ensureOpen(args.connectionId);
      return db.request(args.connectionId, { op: 'introspect', schemas: args.schemas });
    },
  );

  ipcMain.handle('ai:detect', () => detectTools());

  ipcMain.handle(
    'ai:ask',
    async (
      _e,
      args: {
        connectionId: string;
        tool: AiTool;
        mode: 'ask' | 'sql' | 'explain' | 'fix' | 'faster' | 'refine';
        failingSql?: string;
        errorText?: string;
        question: string;
        editorText?: string;
        history?: Array<{ role: 'user' | 'assistant'; text: string }>;
        pinned?: string[];
      },
    ) => {
      const empty = { sql: null, contextTables: [], totalTables: 0 };

      // Everything below is wrapped because a handler that THROWS gives the
      // renderer a rejected promise and nothing to show: the panel's button
      // goes back to idle and the failure is invisible. A thrown error is
      // still an answer, so it comes back as one.
      try {

        // Pins are the user's own answer to "which tables matter", so they
        // steer introspection as well as the prompt: the schema half tells a
        // SQL engine which catalogs to read, the table half tells DynamoDB
        // which tables are worth a describe call.
        const pinned = args.pinned ?? [];
        const pinnedSchemas = pinned
          .map((p) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : ''))
          .filter(Boolean);
        const pinnedTables = pinned.map((p) => (p.includes('.') ? p.slice(p.indexOf('.') + 1) : p));

        // A question about `acme.panel_widget` needs `acme` in the catalog,
        // even when the session is on `acme_cms`. Without this the model is
        // handed a schema listing the table genuinely isn't in, correctly
        // reports that, and the translation fails in a way that reads as the
        // feature being broken rather than as the context being wrong.
        const referenced = [
          ...new Set([
            ...referencedSchemas(`${args.editorText ?? ''}\n${args.failingSql ?? ''}\n${args.question}`),
            ...pinnedSchemas,
          ]),
        ];

        // Everything below talks to the connection host, so it has to be up.
        // Without this the whole Ask surface failed with "connection is not
        // open" whenever the connection had not been opened yet, or had been
        // reopened since — which is a confusing way to say "press Run first".
        await ensureOpen(args.connectionId).catch(() => undefined);

        // What unqualified names in the prompt will resolve to. Asked of the
        // server, because the saved connection and the live session disagree
        // the moment anyone switches schema.
        const current = (await db
          .request(args.connectionId, { op: 'currentSchema' })
          .catch(() => null)) as string | null;

        let snapshot = getCached(args.connectionId);
        if (!snapshot || !cachedCovers(args.connectionId, referenced, pinnedTables)) {
          try {
            const wanted = [
              ...new Set(
                [current, ...cachedSchemaNames(args.connectionId), ...referenced].filter(
                  (x): x is string => Boolean(x),
                ),
              ),
            ];
            snapshot = (await db.request(args.connectionId, {
              op: 'introspect',
              schemas: wanted.length ? wanted : undefined,
              tables: pinnedTables.length ? pinnedTables : undefined,
            })) as SchemaSnapshot;
            putCached(args.connectionId, snapshot, wanted, pinnedTables);
          } catch (err) {
            return {
              ok: false, message: '', ...empty,
              error: `Could not read the schema: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        // For a repair, the failing statement is the best description of what
        // schema matters — far better than the user's words, which may be empty.
        // Names-only index of everything else on this connection. One cheap
        // catalog query, and it is what lets the answer be "it's in acme"
        // rather than "no such table".
        const elsewhere = (await db
          .request(args.connectionId, { op: 'listTables' })
          .catch(() => [])) as Array<{ schema: string; table: string }>;

        const context = buildSchemaContext(
          snapshot,
          `${args.question} ${args.failingSql ?? ''} ${args.errorText ?? ''}`,
          {
            editorText: args.editorText,
            activeSchema: current ?? undefined,
            elsewhere,
            pinned,
            // Only the tuning flow. Everywhere else the index list is bytes
            // spent on something the answer does not turn on.
            indexes: args.mode === 'faster',
          },
        );

        // The plan is fetched HERE rather than asked for: an explanation built
        // on a real plan is worth far more than one built on the model's guess
        // at what the planner would do.
        let plan: string | undefined;
        if ((args.mode === 'explain' || args.mode === 'faster') && args.editorText?.trim()) {
          try {
            // Placeholders are filled from the same value library the
            // editor binds from (src/shared/params.ts). Without it, asking
            // "why is this slow?" about a statement pasted out of an ORM
            // log loses the plan and answers from the text alone — which is
            // exactly the case where the plan matters most.
            const asked = Store.load().connections.find((c) => c.id === args.connectionId);
            const target = { connectionId: args.connectionId, env: asked?.env };
            const filled = bindFor(
              args.editorText.trim().replace(/;\s*$/, ''),
              asked?.engine ?? 'postgres',
              Store.load().params ?? [],
              target,
            );
            const result = (await db.request(args.connectionId, {
              op: 'explain', sql: filled.sql, params: filled.params, analyze: false,
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
          : args.mode === 'refine' ? refinePrompt(input)
          : args.mode === 'explain' ? explainPrompt(input)
          : args.mode === 'faster' ? fasterPrompt(input)
          : args.mode === 'fix'
            ? fixPrompt({ ...input, failingSql: args.failingSql ?? '', errorText: args.errorText ?? '' })
            : askPrompt(input);

        // Repair and translation both sit directly in the typing loop — you
        // are blocked, watching, and you will read the output before running
        // it. Both are short, well-constrained tasks with the schema supplied,
        // so they take the fast model. Open-ended Ask and plan interpretation
        // keep the default model, where reasoning quality is the whole point.
        const fast = args.mode === 'fix' || args.mode === 'sql' || args.mode === 'refine';
        const result = await runOneShot(args.tool, prompt, {
          model: fast
            ? Store.load().settings.aiFastModel[args.tool]
            : Store.load().settings.aiModel[args.tool] || undefined,
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
      } catch (err) {
        // Also to the terminal: the panel gets one line, and a stack is
        // what actually identifies which step gave way.
        console.error('ai:ask failed', err);
        return {
          ok: false, message: '', ...empty,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // The catalog channels reconnect for the same reason running does: the
  // table browser, the schema picker and completion all ask for these on
  // mount, which is exactly when a freshly launched app has no host yet.
  ipcMain.handle('conn:listTables', async (_e, connectionId: string) => {
    await ensureOpen(connectionId);
    return db.request(connectionId, { op: 'listTables' });
  });

  ipcMain.handle('conn:listSchemas', async (_e, connectionId: string) => {
    await ensureOpen(connectionId);
    return db.request(connectionId, { op: 'listSchemas' });
  });

  ipcMain.handle(
    'conn:previewTableFilter',
    async (_e, args: { connectionId: string; filter: string }) => {
      // Unfiltered on purpose: the point is to preview a filter the
      // connection has not been saved with yet, and the saved one would
      // hide exactly the tables a widened pattern is meant to reveal.
      try {
        await ensureOpen(args.connectionId);
        const rows = (await db.request(args.connectionId, {
          op: 'listTables',
          unfiltered: true,
        })) as Array<{ table: string }>;
        const names = rows.map((r) => r.table);
        const matched = filterTableNames(names, args.filter);
        return { total: names.length, matched: matched.length, sample: matched.slice(0, 3) };
      } catch (err) {
        return {
          total: 0, matched: 0, sample: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle('conn:useSchema', async (_e, args: { connectionId: string; name: string }) => {
    await ensureOpen(args.connectionId);
    invalidate(args.connectionId);
    const actual = (await db.request(args.connectionId, {
      op: 'useSchema',
      name: args.name,
    })) as string;
    db.rememberSchema(args.connectionId, actual);
    return actual;
  });

  ipcMain.handle('conn:discoverLocal', () => discoverLocal());

  ipcMain.handle('conn:currentSchema', async (_e, connectionId: string) => {
    await ensureOpen(connectionId);
    return db.request(connectionId, { op: 'currentSchema' });
  });

  ipcMain.handle(
    'conn:setWrites',
    (_e, args: { connectionId: string; enabled: boolean; confirm?: string }) => {
      const connections = Store.load().connections;
      const conn = connections.find((c) => c.id === args.connectionId);
      if (!conn) return { ok: false, error: 'No such connection.' };
      // Typing the name is not ceremony. The accident this prevents is
      // doing exactly the right thing to exactly the wrong server, and a
      // yes/no dialog does not prevent it.
      if (args.enabled && conn.env === 'prod' && args.confirm !== conn.name) {
        return { ok: false, error: `Type ${conn.name} to enable writes on a production connection.` };
      }
      Store.saveConnections(
        connections.map((c) =>
          c.id === args.connectionId ? { ...c, writesEnabled: args.enabled } : c,
        ),
      );
      return { ok: true };
    },
  );

  ipcMain.handle(
    'conn:setTxnMode',
    (_e, args: { connectionId: string; mode: 'auto' | 'manual' }) => {
      Store.saveConnections(
        Store.load().connections.map((c) =>
          c.id === args.connectionId ? { ...c, txnMode: args.mode } : c,
        ),
      );
    },
  );

  ipcMain.handle('txn:commit', async (_e, connectionId: string) => {
    try {
      await db.request(connectionId, { op: 'txn', action: 'commit' });
      writeGate.closed(connectionId);
      return { ok: true };
    } catch (err) {
      // The transaction is gone either way — a commit that failed rolled
      // back — so the UI must stop showing one.
      writeGate.closed(connectionId);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('txn:rollback', async (_e, connectionId: string) => {
    try {
      await db.request(connectionId, { op: 'txn', action: 'rollback' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      writeGate.closed(connectionId);
    }
  });

  ipcMain.handle(
    'query:run',
    async (
      _e,
      args: { connectionId: string; sql: string; params?: unknown[]; origin: QueryOrigin },
    ) => {
      const runId = randomUUID();
      const state = Store.load();
      const conn = state.connections.find((c) => c.id === args.connectionId);
      const kind = classify(args.sql);

      // Running is a request for the connection, not something that has to
      // wait behind one: a dead or never-opened session reopens here.
      await ensureOpen(args.connectionId);

      // Manual mode opens the transaction on the first write and leaves it
      // open. Opening it here rather than in the host keeps one place that
      // knows a transaction exists — the same place that starts the idle
      // clock on it.
      if (writeGate.shouldBeginTransaction(conn, kind)) {
        await db.request(args.connectionId, { op: 'txn', action: 'begin' });
        writeGate.opened(args.connectionId);
      }

      const write = writeGate.shouldWrite(conn, kind);
      await db.request(args.connectionId, {
        op: 'run',
        runId,
        sql: args.sql,
        params: args.params,
        maxRows: state.settings.rowLimit,
        chunkRows: 500,
        write,
      });
      if (writeGate.isOpen(args.connectionId)) writeGate.touched(args.connectionId);
      return { runId, write };
    },
  );

  ipcMain.handle('query:ack', (_e, args: { connectionId: string; runId: string; seq: number }) => {
    db.notify(args.connectionId, { op: 'ack', runId: args.runId, seq: args.seq });
  });

  ipcMain.handle(
    'query:explain',
    async (_e, args: { connectionId: string; sql: string; analyze: boolean; params?: unknown[] }) => {
      // EXPLAIN goes to the server like anything else, so it reconnects
      // like anything else.
      await ensureOpen(args.connectionId);
      return db.request(args.connectionId, {
        op: 'explain',
        sql: args.sql.trim().replace(/;\s*$/, ''),
        analyze: args.analyze,
        params: args.params,
      });
    },
  );

  ipcMain.handle('query:cancel', (_e, args: { connectionId: string; runId: string }) =>
    db.cancelRun(args.connectionId, args.runId),
  );

  ipcMain.handle('perf:slowQuerySupport', (_e, connectionId: string) =>
    db.request(connectionId, { op: 'slowQuerySupport' }),
  );

  ipcMain.handle('perf:slowQueries', (_e, args: { connectionId: string; limit?: number }) =>
    db.request(args.connectionId, {
      op: 'slowQueries',
      // Clamped here rather than in the renderer. This read is cheap but it
      // is not free — pg_stat_statements.max defaults to 5000 — and the cap
      // is a property of what main is willing to ask a server for, not of
      // whatever the pane happens to pass.
      limit: Math.min(500, Math.max(1, args.limit ?? 100)),
    }),
  );

  ipcMain.handle('perf:health', (_e, connectionId: string) =>
    db.request(connectionId, { op: 'health' }),
  );

  ipcMain.handle(
    'perf:killSession',
    (
      _e,
      args: { connectionId: string; sessionId: string; terminate: boolean; confirm?: string },
    ) => {
      const conn = Store.load().connections.find((c) => c.id === args.connectionId);
      if (!conn) return { ok: false, error: 'No such connection.' };
      // The same rule as enabling writes, for the same reason: this is an
      // action against a server, and the accident worth preventing is doing
      // exactly the right thing to exactly the wrong one. Enforced here
      // rather than in the renderer so a bug in a dialog cannot skip it.
      if (conn.env === 'prod' && args.confirm !== conn.name) {
        return {
          ok: false,
          error: `Type ${conn.name} to ${args.terminate ? 'close a connection' : 'cancel a statement'} on a production server.`,
        };
      }
      return db.request(args.connectionId, {
        op: 'killSession',
        sessionId: args.sessionId,
        terminate: args.terminate,
      });
    },
  );

  ipcMain.handle('perf:slowQueryExample', (_e, args: { connectionId: string; digest: string }) =>
    db.request(args.connectionId, { op: 'slowQueryExample', digest: args.digest }),
  );

  ipcMain.handle('perf:resetSlowQueries', async (_e, connectionId: string) => {
    // Re-asked rather than taken on trust. The renderer holds a copy of the
    // support answer, but it was true when the pane opened; privileges can
    // be revoked, and this is the one call here that destroys something.
    const support = (await db.request(connectionId, {
      op: 'slowQuerySupport',
    })) as SlowQuerySupport;
    if (!support.supported) {
      return { ok: false, error: support.reason.detail };
    }
    if (!support.resettable) {
      return {
        ok: false,
        error: 'This user is not allowed to reset the statement counters on this server.',
      };
    }
    try {
      await db.request(connectionId, { op: 'resetSlowQueries' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
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
        rowCount: event.rowCount, affectedRows: event.affectedRows ?? null,
        truncated: event.truncated,
      });
    } else if (event.kind === 'failed') {
      mainWindow?.webContents.send('main:event', {
        kind: 'query:error', runId: event.runId, message: event.message,
      });
    }
  });

  db.onConnectionState((connectionId, state) => {
    // A host that died took its transaction with it, whatever we believed.
    if (state !== 'open') writeGate.forget(connectionId);
    mainWindow?.webContents.send('main:event', { kind: 'conn:state', connectionId, state });
  });

  writeGate.configure({
    rollback: async (connectionId) => {
      await db.request(connectionId, { op: 'txn', action: 'rollback' }).catch(() => undefined);
    },
    notify: (connectionId, txn) => {
      mainWindow?.webContents.send('main:event', {
        kind: 'txn:state', connectionId,
        open: txn.open, statements: txn.statements, expiresAt: txn.expiresAt,
      });
    },
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  closeAllTunnels();
  void db.closeAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
