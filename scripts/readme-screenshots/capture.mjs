// Regenerates the README screenshots in docs/screenshots/.
//
// Runs the built app against a throwaway HOME (fictional acme-shop SQLite
// files and acme connections, see seed.mjs) and its own `readme-shots`
// profile, so none of your own connections, history or paths can end up in
// an image. Only the seeded SQLite files are ever opened; every network
// connection points at a `.example` host and is never clicked.
//
//   npm run build
//   npm i --no-save playwright-core
//   node scripts/readme-screenshots/capture.mjs
//
// Framing needs Python 3 with Pillow (`pip3 install pillow`).

import { _electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..', '..');
const work = path.join(fs.realpathSync(os.tmpdir()), 'overdb-readme-shots');
const raw = path.join(work, 'raw');
const PROFILE = 'readme-shots';
// What the Agents sheet's register command reads as in a packaged build.
const PACKAGED = '/Applications/Overdb.app/Contents/MacOS/Overdb';

// The capture may itself be started from a dev session (overdb's, or
// another Electron app's): its dev-server URL and npm variables would point
// the window at the wrong renderer.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'VITE_DEV_SERVER_URL' || k.startsWith('ELECTRON_') || k.startsWith('npm_')) delete env[k];
  }
  return env;
}

async function launch(home) {
  const app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules', '.bin', 'electron'),
    args: ['.', '--force-device-scale-factor=2'],
    cwd: repo,
    env: { ...cleanEnv(), HOME: home, OVERDB_PROFILE: PROFILE },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.center();
  });
  await page.waitForTimeout(2500);
  return { app, page };
}

// Rewrites the sandbox HOME to `~` and the dev build's register command to
// the packaged one, and drops hover titles. Then refuses to go on if
// anything that names this machine is still on screen.
async function tidy(page, swaps) {
  const leaks = await page.evaluate(({ swaps, forbidden }) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      for (const [from, to] of swaps) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.split(from).join(to);
    }
    document.querySelectorAll('[title]').forEach((e) => (e.title = ''));
    const text = document.body.innerText + ' ' + [...document.querySelectorAll('input, textarea')].map((e) => e.value).join(' ');
    return forbidden.filter((f) => text.includes(f));
  }, { swaps, forbidden: [os.homedir(), os.userInfo().username, repo, '/private/var/', '/var/folders/'] });
  if (leaks.length) throw new Error(`refusing to capture: the window still shows ${leaks.join(', ')}`);
}

let userData;
async function seed(theme) {
  if (!userData) {
    // Ask Electron where the profile lives rather than guessing per platform.
    const { app } = await launch(os.homedir());
    userData = await app.evaluate(({ app }) => app.getPath('userData'));
    await app.close();
  }
  // This process's pid stands in for a connected agent: it outlives the app.
  execFileSync('node', [path.join(here, 'seed.mjs'), work, userData, theme, String(process.pid)], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(path.join(work, 'seed-ids.json'), 'utf8'));
}

async function session(theme, scenes) {
  const ids = await seed(theme);
  const { app, page } = await launch(ids.home);
  const { exec, appPath } = await app.evaluate(({ app }) => ({ exec: process.execPath, appPath: app.getAppPath() }));
  const swaps = [[`${exec} ${appPath}`, PACKAGED], [ids.home, '~']];
  try {
    const shot = async (name, wait = 1500) => {
      await page.waitForTimeout(wait);
      await tidy(page, swaps);
      await page.screenshot({ path: path.join(raw, `${name}.png`) });
      console.log('  ', name);
    };
    await scenes(page, shot);
  } finally {
    await app.close();
  }
}

const esc = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};

// Clicks into the editor, replaces what is there, and leaves the cursor in
// the statement so Run picks it.
async function write(page, sql) {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText(sql);
}

fs.rmSync(raw, { recursive: true, force: true });
fs.mkdirSync(raw, { recursive: true });

console.log('dark');
await session('dark', async (page, shot) => {
  // A one-time hint about a database that is in two environments.
  await page.getByText('Not now', { exact: true }).first().click({ timeout: 2000 }).catch(() => {});

  // Hero: one connection, a query and its result, the sidebar beside it.
  await page.getByText('acme-shop · prod', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Meta+Enter');
  await shot('hero', 2500);

  // The Agents chip's menu.
  await page.getByRole('button', { name: /Agents read/ }).first().click();
  await shot('agents-chip');
  await esc(page);

  // The Agents sheet, then what agents are told.
  await page.getByRole('button', { name: 'Agents', exact: true }).last().click();
  await shot('agents');
  await page.getByText('What agents are told', { exact: true }).first().click();
  await shot('agents-told');
  await esc(page);

  // An environment set: one statement on every member, against the baseline.
  await page.getByText('acme-shop', { exact: true }).first().click();
  await page.waitForTimeout(800);
  await write(page, "-- EU customers, in every environment\nSELECT * FROM customers WHERE region = 'EU' ORDER BY id;");
  await page.getByRole('button', { name: 'Run on 3' }).click();
  await shot('env-set', 2500);

  await page.getByRole('button', { name: 'Schema drift' }).click();
  await shot('schema-drift', 2500);

  // Tables: the list, one opened, its rows. Sidebar folded to give it room.
  await page.getByText('acme-shop · prod', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.getByRole('button', { name: /\d+ tables$/ }).first().click();
  await page.waitForTimeout(800);
  await page.getByText('orders', { exact: true }).first().click();
  await shot('tables', 2000);
});

execFileSync('python3', [path.join(here, 'frame.py'), raw, path.join(repo, 'docs', 'screenshots')], { stdio: 'inherit' });
fs.rmSync(userData, { recursive: true, force: true });
