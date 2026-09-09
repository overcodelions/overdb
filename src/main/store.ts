// Disk-backed app store. Persists overdb's view of which connections,
// groups, and env sets the user has registered — but NOT any database
// state, and NOT any credential.
//
// Credentials live in a SEPARATE file managed by the host secret store
// (src/main/hostElectron.ts). That split is deliberate: `Store.load()` is
// returned wholesale to the renderer, so it must be physically incapable
// of carrying a secret. Keeping them in one file would make a leak one
// careless spread operator away.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  AppSettings,
  Connection,
  ConnectionGroup,
  DEFAULT_SETTINGS,
  EnvSet,
  StoreSnapshot,
} from '../shared/types';

function storePath(): string {
  return path.join(app.getPath('userData'), 'overdb.json');
}

function emptyState(): StoreSnapshot {
  return { connections: [], groups: [], envSets: [], settings: { ...DEFAULT_SETTINGS }, buffers: {} };
}

function loadFromDisk(): StoreSnapshot {
  const p = storePath();
  if (!fs.existsSync(p)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      ...emptyState(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed?.settings ?? {}) },
    };
  } catch (err) {
    console.error('Failed to load overdb.json, starting fresh:', err);
    return emptyState();
  }
}

let cached: StoreSnapshot | null = null;

function current(): StoreSnapshot {
  if (!cached) cached = loadFromDisk();
  return cached;
}

const SAVE_DEBOUNCE_MS = 250;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave = false;

function writeNow(): void {
  if (!cached) return;
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write: tmp + rename so a crash mid-write doesn't leave a
  // half-written JSON that refuses to decode on next launch.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cached), 'utf-8');
  fs.renameSync(tmp, p);
  pendingSave = false;
}

// Coalesce bursts (a sidebar resize drag fires saveSettings on every
// mousemove) into a single trailing disk write.
function save(): void {
  if (!cached) return;
  pendingSave = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, SAVE_DEBOUNCE_MS);
}

// Flush a pending debounced write on exit so the last change isn't lost
// when the app quits inside the debounce window.
process.once('exit', () => {
  if (pendingSave) {
    try {
      writeNow();
    } catch {
      /* best-effort flush on exit */
    }
  }
});

export const Store = {
  load(): StoreSnapshot {
    return current();
  },
  saveConnections(connections: Connection[]): void {
    current().connections = connections;
    save();
  },
  saveGroups(groups: ConnectionGroup[]): void {
    current().groups = groups;
    save();
  },
  saveEnvSets(envSets: EnvSet[]): void {
    current().envSets = envSets;
    save();
  },
  saveSettings(settings: AppSettings): void {
    current().settings = settings;
    save();
  },
  saveBuffer(connectionId: string, text: string): void {
    const state = current();
    if (!state.buffers) state.buffers = {};
    state.buffers[connectionId] = text;
    // Rides the same 250ms debounce as everything else, so typing does not
    // mean a disk write per keystroke.
    save();
  },
  dropBuffer(connectionId: string): void {
    const state = current();
    if (state.buffers) delete state.buffers[connectionId];
    save();
  },
};
