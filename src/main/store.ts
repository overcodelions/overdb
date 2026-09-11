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
  AskTurn,
  EnvSet,
  ParamBinding,
  StoreSnapshot,
} from '../shared/types';
import { ownsBuffer } from '../shared/buffers';
import {
  recordRun,
  worthRecording,
  type HistoryEntry,
  type RunRecord,
  type SavedQuery,
} from '../shared/history';

function storePath(): string {
  return path.join(app.getPath('userData'), 'overdb.json');
}

function emptyState(): StoreSnapshot {
  return {
    connections: [], groups: [], envSets: [], settings: { ...DEFAULT_SETTINGS },
    buffers: {}, bufferState: { active: {}, schema: {} }, askThreads: {},
    history: [], savedQueries: [], params: [],
  };
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
      // A workspace written before tabs existed has no bufferState at all,
      // and one written mid-flight could have half of it. Both halves are
      // filled in here so nothing downstream has to test for them.
      bufferState: {
        active: parsed?.bufferState?.active ?? {},
        schema: parsed?.bufferState?.schema ?? {},
      },
      askThreads: parsed?.askThreads ?? {},
      history: parsed?.history ?? [],
      savedQueries: parsed?.savedQueries ?? [],
      params: parsed?.params ?? [],
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
  fs.writeFileSync(tmp, JSON.stringify(cached), { encoding: 'utf-8', mode: 0o600 });
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
  saveBuffer(key: string, text: string): void {
    const state = current();
    if (!state.buffers) state.buffers = {};
    state.buffers[key] = text;
    // Rides the same 250ms debounce as everything else, so typing does not
    // mean a disk write per keystroke.
    save();
  },
  saveBufferState(bufferState: StoreSnapshot['bufferState']): void {
    current().bufferState = bufferState;
    save();
  },
  /// One connection's Ask thread, replaced wholesale — a thread is small and
  /// a partial write of a conversation is worse than a whole one.
  saveAskThread(connectionId: string, turns: AskTurn[]): void {
    const state = current();
    if (!state.askThreads) state.askThreads = {};
    if (turns.length) state.askThreads[connectionId] = turns;
    else delete state.askThreads[connectionId];
    save();
  },
  /// One completed run, folded in here rather than in the renderer.
  ///
  /// The fold is a read-modify-write, and two windows — or a fan-out
  /// finishing while you run something else — would race if each held its
  /// own copy of the array. Doing it in the one process that owns the file
  /// makes that impossible rather than unlikely.
  recordRun(run: RunRecord): HistoryEntry[] {
    const state = current();
    if (!worthRecording(run.sql)) return state.history ?? [];
    state.history = recordRun(state.history ?? [], run);
    save();
    return state.history;
  },
  clearHistory(): void {
    current().history = [];
    save();
  },
  saveQueries(saved: SavedQuery[]): void {
    current().savedQueries = saved;
    save();
  },
  saveParams(params: ParamBinding[]): void {
    current().params = params;
    save();
  },
  /// One buffer, when its tab is closed. The schema it remembered goes with
  /// it — left behind, it would be handed to whichever tab later reused the
  /// key and silently switch the session on open.
  dropBuffer(key: string): void {
    const state = current();
    if (state.buffers) delete state.buffers[key];
    if (state.bufferState) delete state.bufferState.schema[key];
    save();
  },
  /// Every buffer a connection owns, when the connection itself goes. A
  /// plain delete of the id left the extra tabs behind as orphans that
  /// nothing could ever open or clean up.
  dropBuffers(connectionId: string): void {
    const state = current();
    if (!state.buffers) return;
    for (const key of Object.keys(state.buffers)) {
      if (ownsBuffer(connectionId, key)) delete state.buffers[key];
    }
    if (state.bufferState) {
      delete state.bufferState.active[connectionId];
      for (const key of Object.keys(state.bufferState.schema)) {
        if (ownsBuffer(connectionId, key)) delete state.bufferState.schema[key];
      }
    }
    // The conversation was about this database. It goes with it.
    if (state.askThreads) delete state.askThreads[connectionId];
    save();
  },
};
