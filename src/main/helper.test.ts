import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { helperLabel, plist } from './helperInstall';
import { HelperClient } from './helperClient';

const ROOT = path.resolve(__dirname, '..', '..');

describe('the background helper', () => {
  it('never reaches electron: it runs as plain node', () => {
    // Everything the helper imports, transitively, within src.
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf-8').replace(/\/\/[^\n]*/g, '');
      expect(text, `${path.relative(ROOT, file)} imports electron`).not.toMatch(/from 'electron'|require\('electron'\)/);
      for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)) {
        const base = path.resolve(path.dirname(file), m[1]);
        const found = [`${base}.ts`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
        if (found) visit(found);
      }
    };
    visit(path.join(ROOT, 'src', 'helper', 'index.ts'));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('is installed under a label of its own per data directory', () => {
    const real = path.join(os.homedir(), 'Library', 'Application Support', 'Overdb', 'instances');
    expect(helperLabel(real)).toBe('app.overdb.helper');
    expect(helperLabel('/tmp/elsewhere')).toMatch(/^app\.overdb\.helper\.[0-9a-f]{8}$/);
  });

  it('writes an agent that runs overdb’s binary as node on the helper script', () => {
    const xml = plist({ root: '/data & co/instances', script: '/app/dist/helper/index.js', exec: '/Applications/Overdb.app/Contents/MacOS/Overdb' });
    expect(xml).toContain('<string>/Applications/Overdb.app/Contents/MacOS/Overdb</string>');
    expect(xml).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>');
    expect(xml).toContain('<string>/data &amp; co/instances</string>');
    expect(xml).toContain('<key>KeepAlive</key><true/>');
  });

  it('answers over its socket, and reads the records it shares with overdb', async () => {
    // The compiled helper, as launchd would run it — but with plain node.
    const script = path.join(ROOT, 'dist', 'helper', 'index.js');
    if (!fs.existsSync(script)) return; // built by `npm run build`
    const root = fs.mkdtempSync(path.join('/tmp', 'ovh-'));
    fs.writeFileSync(path.join(root, 'records.json'), JSON.stringify({ baselines: [], tickets: [], proxy: { enabled: false } }));
    const child = spawn(process.execPath, [script], { env: { ...process.env, OVERDB_INSTANCES: root }, stdio: 'ignore' });
    try {
      const client = new HelperClient(path.join(root, 'helper.sock'));
      let pid = 0;
      for (let i = 0; i < 50 && !pid; i++) {
        pid = await client.ping().then((r) => r.pid, () => 0);
        if (!pid) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pid).toBe(child.pid);
      expect(await client.tickets()).toEqual([]);
      const state = await client.proxyState();
      expect(state).toMatchObject({ running: false, configured: false, config: { port: 3306 } });
      await expect(client.call('nonsense' as never)).rejects.toThrow(/Unknown operation/);
      expect(fs.statSync(path.join(root, 'helper.sock')).mode & 0o777).toBe(0o600);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
