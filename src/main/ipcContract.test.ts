// Contract test for the renderer ↔ main IPC seam.
//
// `IPCInvokeMap` (in src/shared/types.ts) is the typed contract: every
// channel the renderer can call lives there with its argument and return
// shape. The actual handlers register via `ipcMain.handle('channel', ...)`
// in src/main/index.ts. TypeScript will catch shape mismatches but
// CANNOT catch a missing or mistyped channel name — the renderer's
// `window.overdb.invoke(...)` accepts any key from the map, but at
// runtime Electron just returns undefined / errors when no handler is
// listening.
//
// This test parses both files at test time and asserts the sets of keys
// match exactly. It will fail loudly the next time someone:
//   - adds a key to IPCInvokeMap but forgets the handler,
//   - renames a key on one side and not the other,
//   - registers a handler that no IPCInvokeMap entry references.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ipcInvokeMapKeys } from './ipcInvokeMapKeys';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/// Every registration, IN ORDER and with repeats — the set-based reader
/// below cannot see a channel registered twice.
function ipcHandleList(): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf-8');
  const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
  return [...src.matchAll(re)].map((m) => m[1]);
}

function ipcHandleChannels(): Set<string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf-8');
  const channels = new Set<string>();
  // Catch both `ipcMain.handle('foo', ...)` and `ipcMain.handle("foo", ...)`.
  const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    channels.add(m[1]);
  }
  return channels;
}

describe('IPC contract', () => {
  it('every IPCInvokeMap key has a matching ipcMain.handle registration', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    const missing = [...keys].filter((k) => !channels.has(k)).sort();
    expect(
      missing,
      `IPCInvokeMap declares these channels but no ipcMain.handle is registered for them:\n  - ${missing.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('every ipcMain.handle registration has a matching IPCInvokeMap entry', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    const orphan = [...channels].filter((c) => !keys.has(c)).sort();
    expect(
      orphan,
      `ipcMain.handle registers these channels but they're not declared in IPCInvokeMap (renderer cannot invoke them through the typed wrapper):\n  - ${orphan.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('registers each channel exactly once', () => {
    // Electron throws "Attempted to register a second handler" on the second
    // registration, which happens during startup — so the app comes up with
    // every handler AFTER the duplicate missing, and the renderer's calls
    // hang instead of failing. Cheap to prevent, expensive to diagnose.
    const seen = new Map<string, number>();
    for (const channel of ipcHandleList()) {
      seen.set(channel, (seen.get(channel) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([c, n]) => `${c} (${n}x)`);
    expect(
      duplicated,
      `These IPC channels are registered more than once, which crashes startup:\n  - ${duplicated.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('finds a non-trivial number of channels (sanity check on the parser)', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    // A floor, not a target: anything this low would mean the parser
    // silently matched nothing — fail before declaring "they match!".
    expect(keys.size).toBeGreaterThan(10);
    expect(channels.size).toBeGreaterThan(10);
  });
});
