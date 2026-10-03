// Installing the background helper as a macOS LaunchAgent, and removing
// it. Only ever at a person's request, from the proxy panel. See
// src/helper/index.ts.
//
// The agent runs overdb's own binary as node (ELECTRON_RUN_AS_NODE), on
// overdb's compiled helper script, starts at login and is restarted by
// launchd if it dies. `launchctl` is spawned with an argv, never a shell
// (src/main/noShellExec.test.ts).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface HelperPaths {
  /// Overdb's instances directory: records, data directories, the socket.
  root: string;
  /// The compiled helper script.
  script: string;
  /// The binary that runs it: overdb's own executable.
  exec: string;
}

/// One agent per data directory, so a dev profile never replaces the real one.
export function helperLabel(root: string): string {
  const def = path.join(os.homedir(), 'Library', 'Application Support', 'Overdb', 'instances');
  return root === def ? 'app.overdb.helper' : `app.overdb.helper.${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
}

export function plistPath(root: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${helperLabel(root)}.plist`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(p: HelperPaths): string {
  const label = helperLabel(p.root);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.exec)}</string>
    <string>${xml(p.script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>OVERDB_INSTANCES</key><string>${xml(p.root)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(p.root, 'helper.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(p.root, 'helper.log'))}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

const domain = () => `gui/${os.userInfo().uid}`;

export async function isInstalled(root: string): Promise<boolean> {
  return fs.access(plistPath(root)).then(() => true).catch(() => false);
}

export async function install(p: HelperPaths): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Running in the background is macOS-only for now.');
  const file = plistPath(p.root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, plist(p));
  // A stale registration under the same label would make bootstrap fail.
  await launchctl(['bootout', `${domain()}/${helperLabel(p.root)}`]);
  const r = await launchctl(['bootstrap', domain(), file]);
  if (r.code !== 0) {
    await fs.rm(file, { force: true });
    throw new Error(`launchctl could not start the helper: ${r.out || `exit ${r.code}`}`);
  }
}

export async function uninstall(root: string): Promise<void> {
  await launchctl(['bootout', `${domain()}/${helperLabel(root)}`]);
  await fs.rm(plistPath(root), { force: true });
}
