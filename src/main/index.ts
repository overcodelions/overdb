// Electron main process entry. Creates the window and registers every
// IPC handler the renderer invokes.
//
// This file is the ONLY place allowed to know about both Electron and
// overdb's engine layer, and even then it reaches the engines through
// `dbSupervisor` rather than importing `src/db` directly. `src/db` never
// imports electron — see src/db/noElectron.test.ts for why that matters.

// First, before anything can read the userData path. See devProfile.ts.
import './devProfile';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { CatalogStore } from './catalogStore';
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
  SavedCatalog,
  SchemaSnapshot,
  SecretSource,
  SeedSize,
  SeedStep,
  StoreSnapshot,
  TableInfo,
} from '../shared/types';
import { isRedshift, type Variant } from '../shared/engines';
import { referencedSchemas } from '../shared/qualifiedRefs';
import { filterTableNames } from '../shared/tableFilter';
import { classify } from '../shared/sqlGuard';
import { bindFor } from '../shared/params';
import * as writeGate from './writeGate';
import { discoverLocal } from './discoverLocal';
import { overcliAvailable, sendToOvercli } from './overcliInbox';
import type { HandoffDraft } from '../shared/overcliHandoff';
import { installMenu } from './menu';
import { createSample } from './sample';
import { initAutoUpdater, quitAndInstall } from './updater';
import { detectTools, extractSql, runInvestigation, runOneShot, type AiTool } from './ai';
import { investigatePrompt, revisePrompt, scriptPrompt, type SeedPromptInput } from './seedPrompts';
import {
  SEED_MAX_ROWS,
  connectionChecks,
  isLoopback,
  seedGate,
  seedRefusal,
  sizeGates,
  type Listener,
  type SeedGate,
} from '../shared/seedGate';
import { connectionPort, portOwner } from './portOwner';
import {
  checkSeedScript,
  insertOrder,
  parseInvestigation,
  parseScript,
  seedIdStart,
  type SeedInvestigation,
} from '../shared/seedSql';
import { repoLinkOwner } from '../shared/overcliHandoff';
import { appSchemas, recipeHome, repoLinks, reposFor, reposInOrder, reposNote, suggestSchemas, type RepoLink } from '../shared/repoLinks';
import { scanRepoSchemas, scanTableMentions } from './repoScan';
import { planMapParts } from './mapParts';
import {
  catalogLines,
  emptyMap,
  freshness,
  learnFrom,
  mapSlice,
  mergeInto,
  parseMapAnswer,
  schemaFingerprint,
  schemasFor,
  type DbMap,
} from '../shared/dbMap';
import { gitBehind, gitChanged, gitHead, loadMap, mapPath, saveMap } from './mapper';
import type { MapRun } from '../shared/dbMap';
import { mapPrompt } from './mapPrompts';
import type { BaselineFindValue, BaselineStatsValue, SeedStatsValue } from '../dbhost/protocol';
import { findLinks, parseRecipe, plansFromRecipe, type BaselineRecipe, type FindRequest } from '../shared/baseline';
import { buildPlan, type BuildProgress } from '../shared/baselineBuild';
import type { Cell } from '../shared/types';
import { baselineCodePrompt, type BaselineCodeInput } from './baselinePrompts';
import { devInstanceRefusal, type ProxyConfig, type ProxyTarget } from '../shared/instances';
import * as instances from './instances';
import * as baselines from './baselines';
import { resolve as resolveCredentials } from './credentials';
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
import type { HealthScope } from '../shared/health';

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
  // Open maximized (fills the screen, stays on the desktop).
  mainWindow.maximize();

  if (isDev && DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    // DevTools stay closed by default (View > Toggle Developer Tools, Cmd+Opt+I);
    // set OPEN_DEVTOOLS=1 to have them open on launch.
    if (process.env.OPEN_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'undocked' });
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
    CatalogStore.prune(connections.map((c) => c.id));
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

  // Show one of overdb's own logs in Finder. Only files under overdb's own
  // folder: the renderer cannot point this anywhere else on the disk.
  ipcMain.handle('app:showLog', (_e, file: string) => {
    const resolved = path.resolve(file);
    if (resolved.startsWith(path.join(app.getPath('userData'), path.sep)) && resolved.endsWith('.log')) shell.showItemInFolder(resolved);
  });

  ipcMain.handle('update:quitAndInstall', () => quitAndInstall());

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

  ipcMain.handle('app:createSample', () =>
    createSample(path.join(app.getPath('userData'), 'samples')),
  );

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('overcli:status', () => ({ available: overcliAvailable() }));
  ipcMain.handle('overcli:send', (_e, draft: HandoffDraft) => sendToOvercli(draft));
  ipcMain.handle('overcli:pickRepo', async (_e, args: { name: string }) => {
    const res = await dialog.showOpenDialog({
      title: `Which repo has the code that uses ${args?.name ?? 'this database'}?`,
      buttonLabel: 'Link repo',
      properties: ['openDirectory'],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('repo:pickMany', async (_e, args: { name: string }) => {
    const res = await dialog.showOpenDialog({
      title: `Which repos have the code that uses ${args?.name ?? 'this database'}?`,
      message: 'Choose one or more — hold ⌘ to pick several.',
      buttonLabel: 'Link repos',
      properties: ['openDirectory', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
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
      args: {
        suggestedName: string;
        data: string;
        encoding?: 'utf8' | 'base64';
        extensions?: string[];
        message?: string;
      },
    ) => {
      const res = await dialog.showSaveDialog({
        defaultPath: args.suggestedName,
        message: args.message,
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

  ipcMain.handle('catalog:list', (_e, args: { connectionId: string }) =>
    CatalogStore.list(args.connectionId),
  );
  ipcMain.handle('catalog:save', (_e, catalog: SavedCatalog) => CatalogStore.save(catalog));

  // ---- seed for a ticket ------------------------------------------------
  //
  // The model investigates and writes; none of these handlers runs the
  // script. The window runs it through `query:run` with origin 'seed',
  // which checks the gate again below. See src/shared/seedGate.ts.

  /// In-flight investigations and writes, so Stop and closing the sheet can
  /// end them. A cancelled job's answer is dropped when it arrives.
  const seedJobs = new Map<string, { cancel(): void }>();

  interface SeedContext {
    gate: SeedGate;
    snapshot: SchemaSnapshot;
    schema: string | null;
    tables: TableInfo[];
    stats: SeedStatsValue | null;
    /// The other schemas the seed covers, with their tables and counts.
    others: Array<{ schema: string; tables: TableInfo[]; stats: SeedStatsValue | null }>;
  }

  /// Where a bounded count stops when a server has no estimate.
  const PROMPT_COUNT_CAP = 5_000;

  /// Who holds the port a loopback connection reaches — see portOwner.ts.
  /// Null for SQLite, a socket, a remote host, or an owner lsof cannot see.
  async function seedListener(conn: Connection): Promise<Listener | null> {
    if (conn.engine === 'sqlite' || conn.tunnel || !isLoopback(conn.host) || conn.host?.startsWith('/')) return null;
    const port = connectionPort(conn.engine, conn.port);
    return port ? portOwner(port) : null;
  }

  async function currentSchemaOf(connectionId: string): Promise<string | null> {
    return (await db.request(connectionId, { op: 'currentSchema' }).catch(() => null)) as string | null;
  }

  /// The gate, as cheaply as it can be answered. The connection's own
  /// settings and who holds its port settle it outright almost always — a
  /// confirmed local server, a file or a socket needs nothing from the
  /// database at all. Only when the owner cannot be seen does size decide,
  /// and then from the server's own table statistics: one catalog query,
  /// not a scan. A connection that already failed a check is never asked.
  async function readSeedGate(conn: Connection): Promise<{ gate: SeedGate; listener: Listener | null; stats: SeedStatsValue | null }> {
    const listener = await seedListener(conn);
    const early = listener?.kind === 'forward'
      ? seedGate(conn, { tables: [], listener }).checks.filter((c) => c.id !== 'size')
      : connectionChecks(conn);
    if (early.some((c) => c.ok === false)) return { gate: { ok: false, checks: early }, listener, stats: null };
    if (!sizeGates(conn, listener)) return { gate: seedGate(conn, { tables: [], listener }), listener, stats: null };

    await ensureOpen(conn.id);
    const schema = await currentSchemaOf(conn.id);
    const stats = schema
      ? ((await db.request(conn.id, { op: 'seedStats', schema, countUnknown: true, cap: SEED_MAX_ROWS })) as SeedStatsValue)
      : { tables: [], maxId: null };
    const tables = stats.tables.map((t) => ({
      schema: schema ?? '', table: t.table, rows: t.rows ?? 0, capped: t.capped, approx: t.approx,
    }));
    return { gate: seedGate(conn, { tables, listener }), listener, stats };
  }

  /// Everything a prompt needs: the gate, the catalog of the schema the
  /// session is on — from the cache Ask already keeps when it covers it —
  /// and the table statistics.
  async function readSeedContext(connectionId: string, step?: (s: SeedStep) => void, also: string[] = []): Promise<SeedContext> {
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('That connection no longer exists.');
    const read = await readSeedGate(conn);
    if (!read.gate.ok) {
      return {
        gate: read.gate,
        snapshot: { engine: conn.engine, serverVersion: '', capturedAt: '', schemas: [] },
        schema: null, tables: [], stats: null, others: [],
      };
    }
    await ensureOpen(connectionId);
    const current = await currentSchemaOf(connectionId);
    const extra = current ? [...new Set(also.filter((s) => s !== current))] : [];
    const wanted = current ? [current, ...extra] : undefined;
    let snapshot = wanted && cachedCovers(connectionId, wanted) ? getCached(connectionId) : undefined;
    if (!snapshot) {
      step?.({ kind: 'schema', text: `Reading the catalog of ${wanted?.join(', ') ?? 'the database'}` });
      snapshot = (await db.request(connectionId, {
        op: 'introspect',
        schemas: wanted,
      })) as SchemaSnapshot;
      putCached(connectionId, snapshot, wanted);
    }
    const home = snapshot.schemas.find((s) => s.name === current) ?? snapshot.schemas[0];
    const tables = (home?.tables ?? []).filter((t) => t.kind === 'table');
    const stats = read.stats ?? (home
      ? ((await db.request(connectionId, {
          op: 'seedStats', schema: home.name, countUnknown: false, cap: PROMPT_COUNT_CAP,
        })) as SeedStatsValue)
      : null);
    const others = [];
    for (const name of extra) {
      const sc = snapshot.schemas.find((s) => s.name === name);
      if (!sc) continue;
      const st = (await db.request(connectionId, {
        op: 'seedStats', schema: name, countUnknown: false, cap: PROMPT_COUNT_CAP,
      })) as SeedStatsValue;
      others.push({ schema: name, tables: sc.tables.filter((t) => t.kind === 'table'), stats: st });
    }
    return { gate: read.gate, snapshot, schema: home?.name ?? null, tables, stats, others };
  }

  function seedPromptInput(ctx: SeedContext, need: string, size: SeedSize): SeedPromptInput {
    const names = ctx.tables.map((t) => t.name);
    // A dev database is small enough to show whole; past that, the tables
    // the need names and their foreign-key neighbours.
    const context = buildSchemaContext(ctx.snapshot, need, {
      activeSchema: ctx.schema ?? undefined,
      pinned: names.length <= 60 && ctx.others.length === 0 ? names : undefined,
    });
    // Counts and insert order for the tables the model can see, not the
    // whole database: 900 names of tables it was never shown are noise.
    // Names come qualified when the seed covers more than one schema.
    const included = new Set(context.included.map((n) => n.toLowerCase()));
    const shown = (schema: string | null, table: string) =>
      included.has(table.toLowerCase()) || (!!schema && included.has(`${schema}.${table}`.toLowerCase()));
    const inScope = ctx.tables.filter((t) => shown(ctx.schema, t.name));
    // Tables in the other schemas are written schema-qualified, after the
    // session's own: their rows usually point back at it.
    const elsewhere = ctx.others.flatMap((o) =>
      insertOrder(o.tables.filter((t) => shown(o.schema, t.name))).map((n) => `${o.schema}.${n}`),
    );
    const countsOf = (stats: SeedStatsValue | null, schema: string | null, prefix: string) =>
      (stats?.tables ?? [])
        .filter((t) => shown(schema, t.table) && t.rows !== null)
        .map((t) => ({ table: `${prefix}${t.table}`, rows: t.rows!, capped: t.capped, approx: t.approx }));
    return {
      engine: ctx.snapshot.engine,
      serverVersion: ctx.snapshot.serverVersion,
      schemaContext: context.text,
      need,
      size,
      insertOrder: [...insertOrder(inScope), ...elsewhere],
      counts: [...countsOf(ctx.stats, ctx.schema, ''), ...ctx.others.flatMap((o) => countsOf(o.stats, o.schema, `${o.schema}.`))],
      idStart: seedIdStart([ctx.stats?.maxId ?? null, ...ctx.others.map((o) => o.stats?.maxId ?? null)]),
    };
  }

  /// Every repo linked for this connection that is still on disk, with the
  /// schemas each one's code uses.
  async function linkedRepoLinks(connectionId: string): Promise<RepoLink[]> {
    const st = Store.load();
    const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
    if (!owner) return [];
    const links = repoLinks(owner, st.connections, st.envSets);
    const here = await Promise.all(links.map((l) => fs.stat(l.path).then((s) => s.isDirectory()).catch(() => false)));
    return links.filter((_, i) => here[i]);
  }

  /// The repos to read for work on `schemas`, the first as claude's working
  /// directory, and a note telling it which repo owns which schema.
  /// `all`: every linked repo, the ones for `schemas` first — for a seed,
  /// whose ticket may be about another service's schema.
  async function codeRepos(
    connectionId: string,
    schemas: string[] | null,
    opts: { all?: boolean } = {},
  ): Promise<{ cwd: string; addDirs: string[]; note: string } | null> {
    const links = await linkedRepoLinks(connectionId);
    const picked = opts.all && schemas ? reposInOrder(links, schemas) : reposFor(links, schemas);
    if (picked.length === 0) return null;
    const cwd = picked[0].path;
    return { cwd, addDirs: picked.slice(1).map((l) => l.path), note: reposNote(picked, cwd) };
  }

  async function linkedRepo(connectionId: string): Promise<string | null> {
    return (await linkedRepoLinks(connectionId))[0]?.path ?? null;
  }

  // ---- the database map -----------------------------------------------
  // See src/shared/dbMap.ts. Built once per env set (or lone connection)
  // from its linked repos, kept in overdb's folder unless the setting says
  // the recipe repo, and read by every seed after.

  const mapJobs = new Map<string, { cancel(): void }>();

  /// The connection whose catalog a map is checked against: a branch's
  /// source, since a branch holds the same schemas.
  function mapProbe(connectionId: string): string {
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    return conn?.branchOf && Store.load().connections.some((c) => c.id === conn.branchOf) ? conn.branchOf : connectionId;
  }

  async function mapFileFor(connectionId: string): Promise<{ owner: DbMap['owner']; file: string } | null> {
    const st = Store.load();
    const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
    if (!owner) return null;
    const file = mapPath(owner, {
      location: st.settings.mapLocation ?? 'overdb',
      userData: app.getPath('userData'),
      repo: recipeHome(await linkedRepoLinks(connectionId)),
    });
    return { owner, file };
  }

  async function mapCatalog(connectionId: string, schemas: string[]): Promise<SchemaSnapshot> {
    const probe = mapProbe(connectionId);
    await ensureOpen(probe);
    if (cachedCovers(probe, schemas)) return getCached(probe)!;
    const snap = (await db.request(probe, { op: 'introspect', schemas })) as SchemaSnapshot;
    putCached(probe, snap, schemas);
    return snap;
  }

  /// Which schemas each repo maps: its own, else every app schema.
  async function mapPlan(connectionId: string): Promise<{ links: RepoLink[]; schemasOf: (l: RepoLink) => string[]; all: string[] }> {
    const links = await linkedRepoLinks(connectionId);
    const probe = mapProbe(connectionId);
    await ensureOpen(probe);
    const all = appSchemas((await db.request(probe, { op: 'listSchemas' })) as string[]);
    return { links, all, schemasOf: (l) => (l.schemas?.length ? l.schemas.filter((x) => all.includes(x)) : all) };
  }

  async function mapStatus(connectionId: string) {
    const where = await mapFileFor(connectionId);
    if (!where) return null;
    const map = await loadMap(where.file);
    const links = await linkedRepoLinks(connectionId);
    if (!map) return { file: where.file, map: null, repos: links.length, freshness: null };
    const repos = await Promise.all(
      links.map(async (l) => {
        const head = await gitHead(l.path);
        const was = map.repos.find((r) => r.path === l.path)?.head;
        const behind = was && head && was !== head ? await gitBehind(l.path, was, head) : was === head ? 0 : null;
        return { path: l.path, head, behind };
      }),
    );
    const mapped = Object.keys(map.schemas);
    const snap = mapped.length ? await mapCatalog(connectionId, mapped).catch(() => null) : null;
    const fps: Record<string, string> = {};
    for (const sc of snap?.schemas ?? []) if (mapped.includes(sc.name)) fps[sc.name] = schemaFingerprint(sc);
    const learned = Object.values(map.tables).reduce((n, t) => n + t.rules.filter((r) => r.learnedAt).length, 0);
    // Tables the map has nothing on: mostly ones no code names, which a
    // first map leaves out.
    const unmapped = (snap?.schemas ?? [])
      .filter((sc) => mapped.includes(sc.name))
      .reduce((n, sc) => n + sc.tables.filter((t) => t.kind === 'table' && !map.tables[`${sc.name}.${t.name}`.toLowerCase()]).length, 0);
    return {
      file: where.file,
      map: { builtAt: map.builtAt, updatedAt: map.updatedAt, tables: Object.keys(map.tables).length, links: map.links.length, learned, unmapped, schemas: mapped },
      repos: links.length,
      freshness: freshness(map, { repos, schemas: fps }),
    };
  }

  ipcMain.handle('map:status', async (_e, connectionId: string) => {
    try {
      return { ok: true as const, status: await mapStatus(connectionId) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('map:build', async (_e, args: { jobId: string; connectionId: string; refresh: boolean; rest?: boolean }) => {
    const say = (repo: string | null, step: { kind: string; text: string }) =>
      mainWindow?.webContents.send('main:event', { kind: 'map:progress', jobId: args.jobId, repo, step });
    let cancelled = false;
    const running: Array<{ cancel(): void }> = [];
    mapJobs.set(args.jobId, { cancel: () => ((cancelled = true), running.forEach((j) => j.cancel())) });
    try {
      if (!(await detectTools()).claude) return { ok: false as const, error: 'Mapping reads the code with the claude CLI, which is not installed.' };
      const where = await mapFileFor(args.connectionId);
      if (!where) return { ok: false as const, error: 'That connection no longer exists.' };
      const plan = await mapPlan(args.connectionId);
      if (plan.links.length === 0) return { ok: false as const, error: 'Link the repos whose code uses this database first.' };
      const before = await loadMap(where.file);
      if (args.rest && !before) return { ok: false as const, error: 'Map the database first.' };
      let map = before && (args.refresh || args.rest) ? before : emptyMap(where.owner);
      // The standard tier (Sonnet), unless Settings says otherwise.
      const model = Store.load().settings.aiMapModel || undefined;
      let dropped = 0;
      const failures: string[] = [];

      // A scan first, with no AI: which files name each table. Tables no
      // file names are left out, the rest go in passes that each read one
      // area of the code from a list of files rather than searching the
      // repo, and the schema the connection works in goes first so a seed
      // can use the map before it is finished. See mapParts.ts. A refresh
      // still reads only what git says changed.
      const PART = 50;
      // Five passes at once: each is a claude session reading its own files,
      // and with three a database spread over many repos spent most of its
      // time queued.
      const PASSES = 5;
      const run: MapRun = { startedAt: new Date().toISOString(), ...(model ? { model } : {}), concurrency: PASSES, scans: [], passes: [] };
      const current = await currentSchemaOf(args.connectionId);
      type Focus = { tables: string[]; part: number; of: number; files?: string[]; moreFiles?: number };
      type Task = { l: RepoLink; schemas: string[]; snap: SchemaSnapshot; changed: string[] | null; head: string | null; first: boolean; focus?: Focus };
      const tasks: Task[] = [];
      const remaining = new Map<string, number>();
      let leftOut = 0;
      const mapped = (l: RepoLink, head: string | null, snap: SchemaSnapshot, schemas: string[]) => {
        const fps = Object.fromEntries(snap.schemas.filter((x) => schemas.includes(x.name)).map((x) => [x.name, schemaFingerprint(x)]));
        map = {
          ...map,
          repos: [...map.repos.filter((r) => r.path !== l.path), { path: l.path, head, mappedAt: new Date().toISOString(), schemas }],
          schemas: { ...map.schemas, ...fps },
        };
      };
      for (const l of plan.links) {
        if (cancelled) break;
        const schemas = plan.schemasOf(l);
        if (schemas.length === 0) continue;
        const head = await gitHead(l.path);
        const was = before?.repos.find((r) => r.path === l.path);
        let changed: string[] | null = null;
        if (args.refresh && was?.head && head) {
          if (was.head === head && schemas.every((x) => before?.schemas[x])) {
            say(l.path, { kind: 'note', text: 'No new commits — kept as it was' });
            continue;
          }
          changed = was.head === head ? [] : await gitChanged(l.path, was.head, head);
        }
        const snap = await mapCatalog(args.connectionId, schemas);
        const names = snap.schemas
          .filter((x) => schemas.includes(x.name))
          .flatMap((x) => x.tables.filter((t) => t.kind === 'table').map((t) => `${x.name}.${t.name}`));
        let parts: Array<Omit<Focus, 'part' | 'of'> & { first: boolean }> | null;
        if (changed) {
          parts = null;
        } else if (args.rest) {
          // What the scan left out, asked about anyway: no file list to
          // narrow the search, so these read the repo as passes used to.
          const left = names.filter((n) => !map.tables[n.toLowerCase()]);
          parts = Array.from({ length: Math.ceil(left.length / PART) }, (_, i) => ({ tables: left.slice(i * PART, (i + 1) * PART), first: false }));
        } else {
          say(l.path, { kind: 'note', text: `Finding which files name each of ${names.length} tables` });
          const t0 = Date.now();
          const planned = planMapParts({ tables: names, mentions: await scanTableMentions(l.path, names), first: current ? [current] : [] });
          leftOut += planned.leftOut.length;
          parts = planned.parts;
          run.scans.push({ repo: path.basename(l.path), named: names.length - planned.leftOut.length, total: names.length, parts: parts.length, ms: Date.now() - t0 });
          say(l.path, {
            kind: 'note',
            text: `${names.length - planned.leftOut.length} of ${names.length} tables are named in the code · ${parts.length} part${parts.length === 1 ? '' : 's'} · ${Math.max(1, Math.round((Date.now() - t0) / 1000))} s`,
          });
        }
        if (parts?.length === 0) {
          if (!args.rest) mapped(l, head, snap, schemas);
          continue;
        }
        const of = parts?.length ?? 1;
        if (parts) parts.forEach((p, i) => tasks.push({ l, schemas, snap, changed, head, first: p.first, focus: { ...p, part: i + 1, of } }));
        else tasks.push({ l, schemas, snap, changed, head, first: false });
        remaining.set(l.path, of);
      }
      // The first schema's passes from every repo before anything else.
      tasks.sort((a, b) => Number(b.first) - Number(a.first));
      let firstLeft = tasks.filter((t) => t.first).length;
      const later = tasks.length - firstLeft;
      // How far along, for the pane's counter: `done/total`, as its own kind
      // of step so it is never shown as a line of the log.
      const total = tasks.length;
      let finished = 0;
      const count = () => say(null, { kind: 'parts', text: `${finished}/${total}` });
      count();

      const one = async (t: Task) => {
        if (cancelled) return;
        try {
          await pass(t);
        } finally {
          finished += 1;
          if (!cancelled) count();
        }
      };
      const pass = async (t: Task) => {
        if (cancelled) return;
        const began = Date.now();
        const timed = (ok: boolean) =>
          run.passes.push({
            repo: path.basename(t.l.path),
            part: t.focus?.part ?? 1,
            of: t.focus?.of ?? 1,
            tables: t.focus?.tables.length ?? 0,
            files: t.focus?.files?.length ?? 0,
            ms: Date.now() - began,
            ok,
          });
        const { l, schemas, snap, changed, head, focus } = t;
        const label = focus && focus.of > 1 ? ` · part ${focus.part} of ${focus.of}` : '';
        say(l.path, { kind: 'note', text: `${changed ? `Refreshing from ${changed.length} changed files` : 'Mapping'} · ${schemas.join(', ')}${label}` });
        const job = runInvestigation(mapPrompt({ repo: l.path, schemas, catalog: catalogLines(snap, schemas), changed, focus }), {
          cwd: l.path,
          model,
          timeoutMs: 30 * 60_000,
          onStep: (step) => say(l.path, step),
        });
        running.push(job);
        const result = await job.result;
        if (cancelled) return;
        if (!result.ok) {
          timed(false);
          failures.push(`${path.basename(l.path)}${label}: ${result.error ?? 'claude did not answer'}`);
          say(l.path, { kind: 'note', text: `Stopped${label}: ${result.error ?? 'no answer'}` });
          return;
        }
        const part = parseMapAnswer(result.output, snap, l.path);
        if ('error' in part) {
          timed(false);
          failures.push(`${path.basename(l.path)}${label}: ${part.error}`);
          return;
        }
        timed(true);
        dropped += part.dropped;
        map = mergeInto(map, part);
        // A repo counts as mapped at its commit once its last part is in.
        const left = (remaining.get(l.path) ?? 1) - 1;
        remaining.set(l.path, left);
        if (left === 0 && !args.rest) mapped(l, head, snap, schemas);
        // Saved after every pass, so a long map that is stopped keeps what
        // it has.
        map = { ...map, lastRun: run };
        await saveMap(where.file, map);
        say(l.path, { kind: 'note', text: `Kept ${Object.keys(part.tables).length} tables and ${part.links.length} links${label}` });
        if (t.first && --firstLeft === 0 && later > 0) {
          say(null, { kind: 'note', text: `Ready to seed in ${current} — the rest keeps mapping` });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PASSES, tasks.length) }, async () => {
          while (tasks.length && !cancelled) await one(tasks.shift()!);
        }),
      );
      if (cancelled) return { ok: false as const, error: 'Stopped. What was mapped so far is kept.' };
      if (Object.keys(map.tables).length === 0) return { ok: false as const, error: failures[0] ?? 'Nothing in the code described these tables.' };
      map = { ...map, lastRun: { ...run, finishedAt: new Date().toISOString() } };
      await saveMap(where.file, map);
      return { ok: true as const, tables: Object.keys(map.tables).length, links: map.links.length, dropped, leftOut, failures };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    } finally {
      mapJobs.delete(args.jobId);
    }
  });

  ipcMain.handle('map:read', async (_e, connectionId: string) => {
    const where = await mapFileFor(connectionId).catch(() => null);
    return where ? loadMap(where.file) : null;
  });

  ipcMain.handle('map:clear', async (_e, connectionId: string) => {
    try {
      const where = await mapFileFor(connectionId);
      if (where) await fs.rm(where.file, { force: true });
      // A saved recipe keeps the links it settled from the map, so they
      // outlive the file. Links it read from the data (polymorphic ones)
      // are not the map's, and stay.
      let links = 0;
      // Not every connection can have a base; one that cannot has no recipe.
      let file: string | null = null;
      try {
        file = await recipePath(baselineSource(connectionId).id);
      } catch {
        file = null;
      }
      const raw = file ? await fs.readFile(file, 'utf-8').catch(() => null) : null;
      if (file && raw !== null) {
        const recipe = JSON.parse(raw) as { extraLinks?: Array<{ source: string }> };
        const kept = (recipe.extraLinks ?? []).filter((l) => l.source === 'poly');
        links = (recipe.extraLinks?.length ?? 0) - kept.length;
        if (links > 0) await fs.writeFile(file, `${JSON.stringify({ ...recipe, extraLinks: kept }, null, 2)}\n`);
      }
      return { ok: true as const, links };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('map:cancel', (_e, jobId: string) => {
    mapJobs.get(jobId)?.cancel();
  });

  ipcMain.handle('map:schemasFor', async (_e, args: { connectionId: string; text: string }) => {
    const where = await mapFileFor(args.connectionId);
    const map = where ? await loadMap(where.file) : null;
    return map ? schemasFor(map, args.text) : [];
  });

  ipcMain.handle('repo:suggestSchemas', async (_e, args: { connectionId: string; path: string }) => {
    try {
      await ensureOpen(args.connectionId);
      const all = appSchemas((await db.request(args.connectionId, { op: 'listSchemas' })) as string[]);
      const evidence = await scanRepoSchemas(args.path, all);
      return { ok: true as const, schemas: all, suggested: suggestSchemas(evidence, args.path) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const seedStep = (jobId: string, step: SeedStep) =>
    mainWindow?.webContents.send('main:event', { kind: 'seed:step', jobId, step });

  ipcMain.handle('seed:check', async (_e, connectionId: string) => {
    const repo = await linkedRepo(connectionId);
    try {
      const conn = Store.load().connections.find((c) => c.id === connectionId);
      if (!conn) return { gate: null, repo, error: 'That connection no longer exists.' };
      const { gate } = await readSeedGate(conn);
      let schema: string | null = null;
      let schemas: string[] = [];
      if (gate.ok) {
        await ensureOpen(conn.id);
        schema = await currentSchemaOf(conn.id);
        schemas = appSchemas((await db.request(conn.id, { op: 'listSchemas' })) as string[]);
      }
      return { gate, repo, schema, schemas };
    } catch (err) {
      return { gate: null, repo, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'seed:investigate',
    async (
      _e,
      args: {
        jobId: string;
        connectionId: string;
        tool: AiTool;
        need: string;
        size: SeedSize;
        readRepo: boolean;
        alsoSchemas?: string[];
        useMap?: boolean;
        revise?: { previous: SeedInvestigation; instruction: string };
      },
    ) => {
      let cancelled = false;
      seedJobs.set(args.jobId, { cancel: () => (cancelled = true) });
      try {
        const ctx = await readSeedContext(args.connectionId, (step) => seedStep(args.jobId, step), args.alsoSchemas ?? []);
        if (!ctx.gate.ok) return { ok: false as const, error: 'This connection can’t be seeded.' };
        const input = seedPromptInput(ctx, args.need, args.size);
        const settings = Store.load().settings;
        const model = settings.aiModel[args.tool] || undefined;

        if (args.revise) {
          seedStep(args.jobId, { kind: 'note', text: 'Revising the plan' });
          const result = await runOneShot(args.tool, revisePrompt(input, args.revise.previous, args.revise.instruction), { model });
          if (cancelled) return { ok: false as const, error: 'Stopped.' };
          if (!result.ok) return { ok: false as const, error: result.error ?? 'The model did not answer.' };
          const parsed = parseInvestigation(result.output);
          return 'error' in parsed
            ? { ok: false as const, error: parsed.error }
            : { ok: true as const, investigation: parsed, readCode: false };
        }

        const links = ctx.tables.reduce((n, t) => n + t.foreignKeys.length, 0);
        seedStep(args.jobId, { kind: 'schema', text: `Foreign keys: ${ctx.tables.length} tables, ${links} links` });
        // The log is a glance at what it is doing, so long lists are cut:
        // the prompt gets them whole.
        const order = input.insertOrder;
        seedStep(args.jobId, {
          kind: 'schema',
          text: `Insert order: ${order.slice(0, 8).join(' → ')}${order.length > 8 ? ` → ${order.length - 8} more` : ''}`,
        });
        seedStep(args.jobId, {
          kind: 'count',
          text: `${input.counts.slice(0, 12).map((c) => `${c.table} ${c.approx ? '~' : ''}${c.rows}${c.capped ? '+' : ''}`).join(' · ')}${
            input.counts.length > 12 ? ` · ${input.counts.length - 12} more` : ''
          } (counts only)`,
        });

        // The map, when there is one: the slice of it this need touches.
        const where = args.useMap === false ? null : await mapFileFor(args.connectionId);
        const map = where ? await loadMap(where.file) : null;
        const slice = map ? mapSlice(map, args.need, ctx.snapshot.schemas.map((x) => x.name)) : null;
        if (slice?.tables.length) seedStep(args.jobId, { kind: 'note', text: `From the map: ${slice.tables.length} tables — ${slice.tables.slice(0, 6).join(', ')}${slice.tables.length > 6 ? ', …' : ''}` });
        const mapText = slice?.text || undefined;

        const code =
          args.readRepo && args.tool === 'claude'
            ? await codeRepos(args.connectionId, ctx.snapshot.schemas.map((s) => s.name), { all: true })
            : null;
        const repo = code?.cwd ?? null;
        let result;
        if (code) {
          for (const dir of [code.cwd, ...code.addDirs]) seedStep(args.jobId, { kind: 'note', text: `Reading ${dir.replace(os.homedir(), '~')}` });
          const prompt = investigatePrompt(input, { readable: true, map: mapText });
          const job = runInvestigation(code.note ? `${prompt}\n\n${code.note}` : prompt, {
            cwd: code.cwd,
            addDirs: code.addDirs,
            model,
            onStep: (step) => seedStep(args.jobId, step),
          });
          seedJobs.set(args.jobId, { cancel: () => ((cancelled = true), job.cancel()) });
          result = await job.result;
        } else {
          seedStep(args.jobId, { kind: 'note', text: mapText ? 'Planning from the schema and the map' : 'Planning from the schema alone' });
          result = await runOneShot(args.tool, investigatePrompt(input, { readable: false, map: mapText }), {
            model,
            timeoutMs: 3 * 60_000,
          });
        }
        if (cancelled) return { ok: false as const, error: 'Stopped.' };
        if (!result.ok) return { ok: false as const, error: result.error ?? 'The model did not answer.' };
        const parsed = parseInvestigation(result.output);
        if ('error' in parsed) return { ok: false as const, error: parsed.error };
        // What reading the code taught this seed, the next one knows.
        if (code && map && where) {
          const learned = learnFrom(map, parsed.findings);
          if (learned.added) {
            await saveMap(where.file, learned.map);
            seedStep(args.jobId, { kind: 'note', text: `Added ${learned.added} finding${learned.added === 1 ? '' : 's'} to the map` });
          }
        }
        return { ok: true as const, investigation: parsed, readCode: !!repo, mapTables: slice?.tables.length ?? 0 };
      } catch (err) {
        console.error('seed:investigate failed', err);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      } finally {
        seedJobs.delete(args.jobId);
      }
    },
  );

  ipcMain.handle(
    'seed:write',
    async (
      _e,
      args: { jobId: string; connectionId: string; tool: AiTool; need: string; investigation: SeedInvestigation; alsoSchemas?: string[] },
    ) => {
      let cancelled = false;
      seedJobs.set(args.jobId, { cancel: () => (cancelled = true) });
      try {
        const ctx = await readSeedContext(args.connectionId, undefined, args.alsoSchemas ?? []);
        if (!ctx.gate.ok) return { ok: false as const, error: 'This connection can’t be seeded.' };
        // The size is already in the plan; the prompt's own line about it
        // only has to not contradict it.
        const input = seedPromptInput(ctx, args.need, 'minimal');
        const model = Store.load().settings.aiModel[args.tool] || undefined;

        // One retry with the problems named. A script that fails twice goes
        // back with its problems, rather than round and round on the
        // person's quota.
        let problems: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await runOneShot(args.tool, scriptPrompt(input, args.investigation, problems), {
            model,
            timeoutMs: 3 * 60_000,
          });
          if (cancelled) return { ok: false as const, error: 'Stopped.' };
          if (!result.ok) return { ok: false as const, error: result.error ?? 'The model did not answer.' };
          const script = parseScript(result.output);
          if ('error' in script) {
            problems = [script.error];
            continue;
          }
          const check = checkSeedScript(script, ctx.snapshot, ctx.snapshot.engine, ctx.schema);
          if (check.ok) return { ok: true as const, script, check };
          problems = check.problems;
          if (attempt === 1) {
            return { ok: false as const, error: 'The script failed overdb’s checks twice.', check };
          }
        }
        return { ok: false as const, error: problems[0] ?? 'The model did not return a script.' };
      } catch (err) {
        console.error('seed:write failed', err);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      } finally {
        seedJobs.delete(args.jobId);
      }
    },
  );

  ipcMain.handle('seed:cancel', (_e, jobId: string) => {
    seedJobs.get(jobId)?.cancel();
    seedJobs.delete(jobId);
  });

  // ---- baselines ----------------------------------------------------------
  //
  // Discovery for a baseline. Reads only — the catalog, the server's table
  // statistics and bounded searches built in src/shared/baseline.ts — and
  // only on a connection tagged local, the server the baseline is copied
  // from. See docs/design/baselines.md.

  function baselineSource(connectionId: string): Connection {
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('That connection no longer exists.');
    // Local, or a shared dev, sandbox or staging server: a base of one is
    // that server's copy on this machine. Only ever read.
    const why = devInstanceRefusal(conn);
    if (why) throw new Error(why);
    return conn;
  }

  /// In the linked repo, so it is reviewed with the code and a teammate
  /// builds the same baseline; otherwise in overdb's own data.
  async function recipePath(connectionId: string): Promise<string> {
    const repo = recipeHome(await linkedRepoLinks(connectionId));
    if (repo) {
      // MySQL keeps the one recipe a repo always had: a local server and a
      // shared sandbox of the same app database share it, which is the
      // point. A Postgres or Redshift database in the same repo — a data
      // mart, say — is a different database and gets a file of its own.
      const conn = Store.load().connections.find((c) => c.id === connectionId);
      if (conn?.engine === 'postgres') {
        const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
        return path.join(repo, '.overdb', `baseline-${isRedshift(conn.variant) ? 'redshift' : 'postgres'}-${slug(conn.database || 'default')}.json`);
      }
      return path.join(repo, '.overdb', 'baseline.json');
    }
    return path.join(app.getPath('userData'), 'baselines', `${connectionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  /// Every schema's catalog and the server's table sizes: what discovery
  /// reads, and what a build re-reads so it works from the catalog as it is.
  async function readBaselineCatalog(conn: Connection) {
    await ensureOpen(conn.id);
    const schemas = (await db.request(conn.id, { op: 'listSchemas' })) as string[];
    const snapshot = (await db.request(conn.id, { op: 'introspect', schemas })) as SchemaSnapshot;
    const stats = (await db.request(conn.id, { op: 'baselineStats', schemas })) as BaselineStatsValue;
    return { snapshot, stats };
  }

  ipcMain.handle('baseline:discover', async (_e, connectionId: string) => {
    try {
      const conn = baselineSource(connectionId);
      const { snapshot, stats } = await readBaselineCatalog(conn);
      const file = await recipePath(conn.id);
      let recipe: BaselineRecipe | null = null;
      let recipeError: string | undefined;
      const raw = await fs.readFile(file, 'utf-8').catch(() => null);
      if (raw !== null) {
        const parsed = parseRecipe(raw);
        if ('error' in parsed) recipeError = parsed.error;
        else {
          // A recipe is only applied to the database it describes: the same
          // engine, its tenant's table present. One that is not is set aside
          // — said, not silently used — and this database starts fresh.
          const has = (ref: { schema: string; table: string }) =>
            snapshot.schemas.some((sc) => sc.name === ref.schema && sc.tables.some((t) => t.name === ref.table));
          if (parsed.engine !== snapshot.engine || (parsed.tenant && !has(parsed.tenant))) {
            recipeError = `The recipe at ${file} is for another database${parsed.tenant ? ` (its tenant is ${parsed.tenant.schema}.${parsed.tenant.table})` : ''}; this one starts fresh, and saving replaces it.`;
          } else recipe = parsed;
        }
      }
      return { ok: true as const, snapshot, stats, repo: await linkedRepo(conn.id), recipe, recipePath: file, recipeError };
    } catch (err) {
      console.error('baseline:discover failed', err);
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('baseline:find', async (_e, args: { connectionId: string; req: FindRequest }) => {
    try {
      const conn = baselineSource(args.connectionId);
      await ensureOpen(conn.id);
      const value = (await db.request(conn.id, { op: 'baselineFind', req: args.req })) as BaselineFindValue;
      return { ok: true as const, rows: value.rows };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('baseline:distinct', async (_e, args: { connectionId: string; schema: string; table: string; columns: string[]; sample: number; limit: number }) => {
    try {
      const conn = baselineSource(args.connectionId);
      await ensureOpen(conn.id);
      const rows = (await db.request(conn.id, { op: 'baselineDistinct', ...args })) as Cell[][];
      return { ok: true as const, rows };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('baseline:measure', async (_e, args: { connectionId: string; schema: string; table: string; column: string; values: string[] }) => {
    try {
      const conn = baselineSource(args.connectionId);
      await ensureOpen(conn.id);
      const rows = (await db.request(conn.id, {
        op: 'baselineCount', schema: args.schema, table: args.table, column: args.column, values: args.values,
      })) as number;
      return { ok: true as const, rows };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('baseline:save', async (_e, args: { connectionId: string; recipe: BaselineRecipe }) => {
    try {
      const conn = baselineSource(args.connectionId);
      const file = await recipePath(conn.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(args.recipe, null, 2)}\n`);
      return { ok: true as const, path: file };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- building a baseline, ticket copies, the proxy -----------------------

  const builds = new Map<string, { cancelled: boolean; kill?: () => void }>();

  const buildTunnels = new Map<string, string>();
  ipcMain.handle('baseline:build', async (_e, args: { jobId: string; connectionId: string }) => {
    const signal: { cancelled: boolean; kill?: () => void } = { cancelled: false };
    builds.set(args.jobId, signal);
    const progress = (p: BuildProgress) =>
      mainWindow?.webContents.send('main:event', { kind: 'baseline:progress', jobId: args.jobId, progress: p });
    try {
      const conn = baselineSource(args.connectionId);
      const raw = await fs.readFile(await recipePath(conn.id), 'utf-8').catch(() => null);
      if (raw === null) return { ok: false as const, error: 'Save the recipe first.' };
      const recipe = parseRecipe(raw);
      if ('error' in recipe) return { ok: false as const, error: recipe.error };
      progress({ stage: 'start', text: 'Reading the catalog as it is now' });
      const { snapshot, stats } = await readBaselineCatalog(conn);
      const plans = plansFromRecipe(recipe, snapshot, stats, findLinks(snapshot));
      const plan = buildPlan(recipe, plans, snapshot);
      for (const w of plan.warnings) progress({ stage: 'start', text: w });
      // The source's address and credential, resolved here and handed to
      // the builder process only — never to the window.
      // A shared server is reached the way its connection says — through its
      // SSH tunnel, over its TLS — on a tunnel of the build's own.
      const tunnelKey = `baseline-build:${args.jobId}`;
      const spec = await resolveWithTunnel(conn, tunnelKey, { readOnly: true });
      buildTunnels.set(args.jobId, tunnelKey);
      const tenantStart = recipe.tenant ? recipe.starts.find((s) => s.ref.table === recipe.tenant!.table && s.ref.schema === recipe.tenant!.schema) : undefined;
      const baseline = await baselines.buildBaseline({
        source: conn,
        endpoint: {
          host: spec.host ?? '127.0.0.1',
          port: spec.port ?? (conn.engine === 'postgres' ? 5432 : 3306),
          user: spec.user,
          password: spec.password ?? '',
          ...(conn.engine === 'postgres' ? { database: spec.database } : {}),
          ...(spec.ssl && spec.ssl !== 'disable'
            ? { tls: { engine: spec.engine, ssl: spec.ssl, sslRootCert: spec.sslRootCert, sslCert: spec.sslCert, sslKey: spec.sslKey, tlsServerName: spec.tlsServerName, host: spec.host } }
            : {}),
        },
        plan,
        serverVersion: snapshot.serverVersion,
        // A Postgres copy is created from the catalog discovery read, the
        // planned tables only.
        ...(conn.engine === 'postgres'
          ? {
              redshift: isRedshift(conn.variant) || /redshift/i.test(snapshot.serverVersion),
              catalog: snapshot.schemas.flatMap((sc) =>
                sc.tables
                  .filter((t) => t.kind === 'table' && plan.tables.some((p) => p.ref.schema === sc.name && p.ref.table === t.name))
                  .map((t) => ({ schema: sc.name, table: t.name, columns: t.columns, primaryKey: t.primaryKey, indexes: t.indexes, foreignKeys: t.foreignKeys })),
              ),
            }
          : {}),
        recipeSavedAt: recipe.savedAt,
        label: tenantStart?.label || recipe.starts[0]?.label || conn.name,
        onProgress: progress,
        signal,
      });
      return { ok: true as const, baseline };
    } catch (err) {
      console.error('baseline:build failed', err);
      const log = (err as { log?: string })?.log;
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), ...(log ? { log } : {}) };
    } finally {
      builds.delete(args.jobId);
      const key = buildTunnels.get(args.jobId);
      if (key) closeTunnel(key);
      buildTunnels.delete(args.jobId);
    }
  });

  const codeJobs = new Map<string, { cancel(): void }>();

  /// Read the linked repo for what the schema cannot say. The same
  /// read-only investigation the seed flow uses: Read, Grep and Glob, no
  /// shell, no MCP, no dotenv (src/main/seedNeverExecutes.test.ts). The
  /// answer goes back raw; the window keeps only suggestions that name a
  /// link or table its catalog has.
  ipcMain.handle('baseline:readCode', async (_e, args: { jobId: string; connectionId: string; input: BaselineCodeInput }) => {
    try {
      const conn = baselineSource(args.connectionId);
      const code = await codeRepos(conn.id, args.input.schemas ?? null);
      if (!code) return { ok: false as const, error: 'Link the repo your services live in first.' };
      if (!(await detectTools()).claude) return { ok: false as const, error: 'Reading the code needs the claude CLI.' };
      const model = Store.load().settings.aiModel.claude || undefined;
      const prompt = baselineCodePrompt(args.input);
      const job = runInvestigation(code.note ? `${prompt}\n\n${code.note}` : prompt, {
        cwd: code.cwd,
        addDirs: code.addDirs,
        model,
        onStep: (step) => mainWindow?.webContents.send('main:event', { kind: 'baseline:codeStep', jobId: args.jobId, step }),
      });
      let cancelled = false;
      codeJobs.set(args.jobId, { cancel: () => ((cancelled = true), job.cancel()) });
      const result = await job.result;
      if (cancelled) return { ok: false as const, error: 'Stopped.' };
      return result.ok ? { ok: true as const, output: result.output } : { ok: false as const, error: result.error ?? 'claude did not answer.' };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    } finally {
      codeJobs.delete(args.jobId);
    }
  });

  ipcMain.handle('baseline:cancelReadCode', (_e, jobId: string) => {
    codeJobs.get(jobId)?.cancel();
    codeJobs.delete(jobId);
  });

  ipcMain.handle('baseline:cancelBuild', (_e, jobId: string) => {
    const b = builds.get(jobId);
    if (!b) return;
    b.cancelled = true;
    b.kill?.();
  });

  ipcMain.handle('baseline:serverFor', (_e, args: { engine: string; serverVersion: string }) => baselines.serverFor(args.engine, args.serverVersion));
  /// `brew install` one MySQL or MariaDB formula, only when a person presses
  /// the button for it. The formula is checked in instances.ts.
  ipcMain.handle('baseline:installServer', async (_e, args: { jobId: string; formula: string }) => {
    let last = 0;
    return instances.installServer(args.formula, (line) => {
      // Brew is chatty; a line every quarter second is plenty to show it moving.
      if (Date.now() - last < 250 && !/^==>|Error|Warning/.test(line)) return;
      last = Date.now();
      mainWindow?.webContents.send('main:event', { kind: 'baseline:installProgress', jobId: args.jobId, line });
    });
  });

  ipcMain.handle('baseline:instances', async () => ({
    baselines: await baselines.baselines(),
    tickets: await baselines.tickets(),
    proxies: await baselines.proxyStates(),
  }));

  ipcMain.handle('ticket:create', async (_e, args: { baselineId: string; name: string; note: string }) => {
    try {
      const all = await baselines.baselines();
      const base = all.find((b) => b.id === args.baselineId);
      const source = base ? Store.load().connections.find((c) => c.id === base.sourceConnectionId) : undefined;
      if (!base || !source) return { ok: false as const, error: 'The base or the connection it came from no longer exists.' };
      const made = await baselines.createTicket({ ...args, source });
      return { ok: true as const, ...made };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('ticket:start', async (_e, id: string) => {
    try {
      return { ok: true as const, ticket: await baselines.startTicket(id) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('ticket:stop', async (_e, id: string) => {
    await baselines.stopTicket(id);
  });

  ipcMain.handle('baseline:rename', (_e, args: { id: string; label: string }) => baselines.renameBaseline(args.id, args.label));

  ipcMain.handle('ticket:connection', async (_e, id: string) => {
    const t = (await baselines.tickets()).find((x) => x.id === id);
    const source = t && Store.load().connections.find((c) => c.id === t.sourceConnectionId);
    return source ? baselines.branchConnection(id, source) : null;
  });

  ipcMain.handle('ticket:reset', async (_e, id: string) => {
    const t = (await baselines.tickets()).find((x) => x.id === id);
    // Its connection's session points at files that are about to go.
    if (t) await db.closeConnection(t.connectionId).catch(() => undefined);
    await baselines.resetTicket(id);
    // Made again from the base as it is now: a rebuilt base may log in
    // with a password the branch's connection does not have yet.
    const source = t && Store.load().connections.find((c) => c.id === t.sourceConnectionId);
    return source ? baselines.branchConnection(id, source) : null;
  });

  ipcMain.handle('ticket:delete', async (_e, id: string) => {
    const t = await baselines.deleteTicket(id);
    if (t) await db.closeConnection(t.connectionId).catch(() => undefined);
    return { connectionId: t?.connectionId ?? null };
  });

  /// A proxy carries services' traffic to its base's own server when no
  /// branch is chosen. Never to production: a base cannot be built from
  /// one, and a proxy for one is refused here too, whatever the window asks.
  const proxySource = (source: string) => {
    const conn = Store.load().connections.find((c) => c.id === source);
    if (!conn) throw new Error('That base’s connection no longer exists.');
    const why = devInstanceRefusal(conn);
    if (why) throw new Error(why);
    return conn;
  };

  ipcMain.handle('proxy:configure', async (_e, args: { source: string; next: Partial<ProxyConfig> & { enabled?: boolean } }) => {
    if (args.next.enabled) proxySource(args.source);
    return baselines.configureProxy(args.source, args.next);
  });
  ipcMain.handle('proxy:route', async (_e, args: { source: string; target: ProxyTarget }) => {
    try {
      proxySource(args.source);
      return { ok: true as const, state: await baselines.routeProxy(args.source, args.target) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  /// The sidebar connection for one proxy, built here so a stored password
  /// is copied without crossing to the window. Null when it is off — and
  /// when a remote base's proxy points at its own server: services then
  /// reach that server itself, and its own connection already shows it.
  ipcMain.handle('proxy:connection', async (_e, sourceId: string) => {
    const state = (await baselines.proxyStates()).find((p) => p.source === sourceId);
    if (!state?.running) return null;
    const source = Store.load().connections.find((c) => c.id === sourceId);
    if (!source) return null;
    const target = state.config.target;
    if (target.kind === 'server' && source.env !== 'local') return baselines.proxyServerConnection(source, state.config.port);
    const tickets = target.kind === 'ticket' ? await baselines.tickets() : [];
    const name = target.kind === 'ticket' ? tickets.find((x) => x.id === target.id)?.name ?? 'a branch' : 'your server';
    // On a branch, an account with no password to copy uses the branch's
    // superuser, whose password its base keeps.
    const adminRef = target.kind === 'ticket' ? await baselines.adminRefFor(target.id) : undefined;
    return baselines.proxyConnection(source, state.config.port, name, adminRef);
  });

  ipcMain.handle('proxy:clients', (_e, source: string) => baselines.proxyClients(source).catch(() => []));

  // The background helper: keeps the proxy and ticket copies running while
  // overdb is closed. Installed only from here, at a person's request.
  ipcMain.handle('helper:status', () => baselines.helperStatus());
  ipcMain.handle('helper:enable', async () => {
    try {
      return { ok: true as const, status: await baselines.enableHelper() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('helper:disable', async () => {
    try {
      return { ok: true as const, status: await baselines.disableHelper() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

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

      // A seed statement is held to the seed gate here too, so the window
      // cannot talk its way past it: the connection must still pass, and
      // only INSERTs and reads get through — the teardown is saved for a
      // person to run from the editor, not run from here.
      if (args.origin === 'seed') {
        const refusal = seedRefusal(conn);
        if (refusal) throw new Error(refusal);
        // The port's owner can change between checking and running — a
        // tunnel opened on the same port in the meantime.
        const listener = conn ? await seedListener(conn) : null;
        if (listener?.kind === 'forward') {
          throw new Error(`Seeding refused: ${listener.process} is forwarding this port.`);
        }
        const insert = /^\s*(?:--[^\n]*\n\s*)*insert\b/i.test(args.sql);
        if (kind !== 'read' && !(kind === 'write' && insert)) {
          throw new Error('Seeding refused: only INSERT statements and reads may run from the seed flow.');
        }
      }

      // Running is a request for the connection, not something that has to
      // wait behind one: a dead or never-opened session reopens here.
      await ensureOpen(args.connectionId);

      // A seed always runs inside a transaction, whatever the connection's
      // own mode, so what it wrote can be looked at before it is kept.
      if (args.origin === 'seed' && kind === 'write' && !writeGate.isOpen(args.connectionId)) {
        await db.request(args.connectionId, { op: 'txn', action: 'begin' });
        writeGate.opened(args.connectionId);
      }

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

  // Every perf read opens the connection first, the same as the catalog
  // reads above. These were the last handlers that did not: the pane is
  // opened against a connection, so asking what a server is spending its
  // time on IS asking for the connection — and refusing instead put
  // "connection is not open" in the log once per poll, forever, for a pane
  // the user was looking at. The polling itself is gated on the status dot
  // in the renderer, so a connection the user closed stays closed.
  ipcMain.handle('perf:slowQuerySupport', async (_e, connectionId: string) => {
    await ensureOpen(connectionId);
    return db.request(connectionId, { op: 'slowQuerySupport' });
  });

  ipcMain.handle('perf:slowQueries', async (_e, args: { connectionId: string; limit?: number }) => {
    await ensureOpen(args.connectionId);
    return db.request(args.connectionId, {
      op: 'slowQueries',
      // Clamped here rather than in the renderer. This read is cheap but it
      // is not free — pg_stat_statements.max defaults to 5000 — and the cap
      // is a property of what main is willing to ask a server for, not of
      // whatever the pane happens to pass.
      limit: Math.min(500, Math.max(1, args.limit ?? 100)),
    });
  });

  ipcMain.handle('perf:health', async (_e, connectionId: string, scope?: HealthScope) => {
    await ensureOpen(connectionId);
    return db.request(connectionId, { op: 'health', scope });
  });

  ipcMain.handle(
    'perf:killSession',
    async (
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
      // After the prod guard, so a refusal never opens anything — and
      // reported rather than thrown, because this handler answers with
      // { ok, error } and the pane toasts what it finds there.
      try {
        await ensureOpen(args.connectionId);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return db.request(args.connectionId, {
        op: 'killSession',
        sessionId: args.sessionId,
        terminate: args.terminate,
      });
    },
  );

  ipcMain.handle(
    'perf:slowQueryExample',
    async (_e, args: { connectionId: string; digest: string }) => {
      await ensureOpen(args.connectionId);
      return db.request(args.connectionId, { op: 'slowQueryExample', digest: args.digest });
    },
  );

  ipcMain.handle('perf:resetSlowQueries', async (_e, connectionId: string) => {
    // Reported rather than thrown, the same as every other failure here:
    // this handler answers with { ok, error } and the pane toasts it.
    try {
      await ensureOpen(connectionId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
  void baselines.resumeProxy();
  installMenu((command) => mainWindow?.webContents.send('main:event', { kind: 'menu', command }));
  initAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let instancesStopped = false;
app.on('before-quit', (event) => {
  closeAllTunnels();
  void db.closeAll();
  // A mysqld left running would hold its port and its data directory past
  // overdb's lifetime. Stopping one is a clean InnoDB shutdown, so quitting
  // waits for it.
  if (!instancesStopped) {
    event.preventDefault();
    void (async () => {
      // Quitting stops the proxy and every ticket copy. When services may be
      // using them, that is a question, not a side effect.
      const use = await baselines.inUse().catch(() => ({ proxy: false, connections: 0, running: [] as string[] }));
      if (use.proxy || use.running.length > 0) {
        const lines = [
          ...(use.proxy ? [`Your services connect through overdb${use.connections ? ` (${use.connections} open connection${use.connections === 1 ? '' : 's'})` : ''}. Quitting stops the proxy, so they reach no database until overdb is open again.`] : []),
          ...(use.running.length ? [`Running branches stop too (their data is kept): ${use.running.join(', ')}.`] : []),
        ];
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Quit anyway', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: 'Quit overdb?',
          detail: lines.join('\n\n'),
        });
        if (response !== 0) return;
      }
      instancesStopped = true;
      await baselines.shutdown().catch(() => undefined);
      app.quit();
    })();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
