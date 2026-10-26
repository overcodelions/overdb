// What agents are doing with this machine's connections, kept where the app
// can see it.
//
// `overdb serve --mcp` is a process of its own, started by the agent's
// client, never by the app — so the app learns about it only through disk.
// Each server writes two things under userData/agents:
//
//   clients/<pid>.json   while it runs: which client started it, from where,
//                        since when. Removed on the way out; a file left by a
//                        server that died is ignored, then removed, once its
//                        pid is gone.
//   activity.jsonl       one line per tool call (src/mcp/queryLog.ts): the
//                        tool, the connection, the statement or question, how
//                        it went. Never rows, never bound values.
//
// The app reads both when asked (the Agents chip and sheet poll); nothing
// here opens a database.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { appendLogLine, readLogTail } from '../mcp/queryLog';
import type { QueryLogEntry } from '../mcp/tools';
import type { AgentActivity, AgentClient } from '../shared/types';

function agentsDir(): string {
  return path.join(app.getPath('userData'), 'agents');
}
const clientsDir = () => path.join(agentsDir(), 'clients');
const activityFile = () => path.join(agentsDir(), 'activity.jsonl');

/// This server's presence file. `client` is filled in once the client says
/// who it is (MCP's initialize); until then the file says only that one
/// connected.
export function startPresence(): { identify(client: { name: string; version?: string } | undefined): void; end(): void; who(): AgentClient } {
  const file = path.join(clientsDir(), `${process.pid}.json`);
  const me: AgentClient = { pid: process.pid, cwd: process.cwd(), since: new Date().toISOString() };
  const write = () => {
    try {
      fs.mkdirSync(clientsDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(me), { mode: 0o600 });
    } catch {
      // The app will not show this client; the tools still work.
    }
  };
  write();
  return {
    identify(client) {
      if (!client?.name) return;
      me.client = client.name;
      if (client.version) me.version = client.version;
      write();
    },
    end() {
      fs.rmSync(file, { force: true });
    },
    who: () => me,
  };
}

/// Each call, with the client that made it, into the shared activity log.
export function activityRecorder(who: () => AgentClient, log: (line: string) => void): (entry: QueryLogEntry) => void {
  return (entry) => {
    const me = who();
    try {
      appendLogLine(activityFile(), { ...entry, pid: me.pid, ...(me.client ? { client: me.client } : {}) });
    } catch (e) {
      log(`can't write the activity log: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/// The servers running now, oldest first.
export function connectedClients(): AgentClient[] {
  let names: string[];
  try {
    names = fs.readdirSync(clientsDir());
  } catch {
    return [];
  }
  const out: AgentClient[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(clientsDir(), name);
    let c: AgentClient;
    try {
      c = JSON.parse(fs.readFileSync(file, 'utf-8')) as AgentClient;
    } catch {
      continue;
    }
    if (typeof c.pid !== 'number' || !alive(c.pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    out.push(c);
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

export function recentActivity(limit: number): AgentActivity[] {
  return readLogTail<AgentActivity>(activityFile(), limit);
}

/// What to register with an MCP client: this binary, started headless. A
/// dev build is Electron plus the app's folder.
export function serveCommand(): string[] {
  return app.isPackaged ? [process.execPath, 'serve', '--mcp'] : [process.execPath, app.getAppPath(), 'serve', '--mcp'];
}
