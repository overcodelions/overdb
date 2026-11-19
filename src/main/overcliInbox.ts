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
import {
  buildConnectionPush,
  CONNECTIONS_STATUS_FILE,
  connectionPushFileName,
  parseOvercliOrg,
  type HostedConnection,
  type OvercliOrg,
  type PushState,
} from '../shared/hostedConnection';

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

/// Where overcli picks up a connection to push to its org's server. See
/// `ConnectionPush` in src/shared/hostedConnection.ts for why it is not the
/// inbox itself.
export function overcliConnectionsDir(): string {
  return path.join(overcliInboxDir(), 'connections');
}

/// The same rule as `overcliAvailable`: the folder is made by an overcli
/// that reads it, so its existence is the whole answer.
export function overcliTakesConnections(dir: string = overcliConnectionsDir()): boolean {
  return overcliAvailable(dir);
}

export function sendConnectionToOvercli(
  connection: HostedConnection,
  opts: { dir?: string; now?: number; id?: string } = {},
): { ok: true; id: string; file: string } | { ok: false; error: string } {
  const dir = opts.dir ?? overcliConnectionsDir();
  if (!overcliTakesConnections(dir)) {
    return { ok: false, error: 'This overcli can’t publish connections yet. Update it, then try again.' };
  }
  const push = buildConnectionPush(connection, { id: opts.id ?? randomUUID(), now: opts.now ?? Date.now() });
  const file = connectionPushFileName(push);
  const final = path.join(dir, file);
  const tmp = `${final}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(push, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, final);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing to clean up.
    }
    return { ok: false, error: `Could not write to overcli’s inbox: ${(e as Error).message}` };
  }
  return { ok: true, id: push.id, file };
}

/// Which org overcli would publish to, or that it is signed in to none —
/// the step people miss. `null` when overcli says nothing (an older one).
export function overcliOrg(dir: string = overcliConnectionsDir()): OvercliOrg | null {
  try {
    return parseOvercliOrg(JSON.parse(fs.readFileSync(path.join(dir, CONNECTIONS_STATUS_FILE), 'utf-8')));
  } catch {
    return null;
  }
}

/// Where a push has got to: overcli moves it to `done/` once the server has
/// it, to `rejected/` (with a reason beside it) if the server said no, and
/// leaves it where it is while it waits — for a sign-in, mostly.
export function connectionPushState(file: string, dir: string = overcliConnectionsDir()): PushState {
  // Only a name overdb made: never a path out of the folder.
  if (!/^[\w.-]+\.json$/.test(file) || file.startsWith('.')) return { state: 'unknown' };
  const exists = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (exists(path.join(dir, 'done', file))) return { state: 'sent' };
  if (exists(path.join(dir, 'rejected', file))) {
    let reason = 'overcli didn’t say why.';
    try {
      reason = fs.readFileSync(path.join(dir, 'rejected', `${file}.reason.txt`), 'utf-8').trim().slice(0, 500) || reason;
    } catch {
      // The move is the answer; the reason is a courtesy.
    }
    return { state: 'rejected', reason };
  }
  if (exists(path.join(dir, file))) return { state: 'waiting' };
  return { state: 'unknown' };
}
