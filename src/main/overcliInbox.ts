// Writing into overcli's inbox. See src/shared/overcliHandoff.ts for the
// format and the rules about what may go in it.
//
// "Is overcli there?" is answered by the folder, not by the app: overcli
// creates `~/.overcli/inbox/` the first time it starts with inbox support.
// So the folder existing means an overcli that will read the file — whether
// or not it is running right now — and an older overcli, which would never
// read it, leaves the button hidden. No process probing, no port, no
// guessing at install locations.
//
// Electron-free; `dir` is injectable so a test writes to a temp folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildHandoff, handoffFileName, type HandoffDraft } from '../shared/overcliHandoff';

export function overcliInboxDir(): string {
  return path.join(os.homedir(), '.overcli', 'inbox');
}

export function overcliAvailable(dir: string = overcliInboxDir()): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function sendToOvercli(
  draft: HandoffDraft,
  opts: { dir?: string; now?: number; id?: string } = {},
): { ok: true; id: string } | { ok: false; error: string } {
  const dir = opts.dir ?? overcliInboxDir();
  // Never create the folder: making it would claim an overcli that is not
  // there, and the file would sit unread forever.
  if (!overcliAvailable(dir)) {
    return { ok: false, error: 'overcli isn’t installed here, or is too old to take handoffs.' };
  }
  const built = buildHandoff(draft, { id: opts.id ?? randomUUID(), now: opts.now ?? Date.now() });
  if (!built.ok) return built;
  const name = handoffFileName(built.handoff);
  const final = path.join(dir, name);
  // The tmp name does not end in `.json`, so overcli's watcher skips it
  // until the rename makes it whole in one step.
  const tmp = `${final}.tmp`;
  try {
    fs.writeFileSync(tmp, built.json, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, final);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing to clean up.
    }
    return { ok: false, error: `Could not write to overcli’s inbox: ${(e as Error).message}` };
  }
  return { ok: true, id: built.handoff.id };
}
