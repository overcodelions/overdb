// Auto-update from GitHub Releases, via electron-updater. The feed is the
// `build.publish` entry in package.json; release.yml uploads the latest*.yml
// files electron-builder writes next to the installers, and those are what
// this reads to learn a new version exists.
//
// Download happens in the background and the install waits for the next
// quit, so an update never lands in the middle of a query or an open
// transaction. The renderer offers a restart once the download is done.
//
// macOS note: Squirrel.Mac refuses an unsigned update, so this only works on
// the signed, notarized builds release.yml makes. That is also why the mac
// target keeps a zip next to the dmg — the zip is what Squirrel installs.

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { MainToRendererEvent } from '../shared/types';

let wired = false;

/// Nightly builds stamp their version as x.y.z-nightly.<date>.<sha>; every
/// tagged release is plain x.y.z.
function isNightlyBuild(): boolean {
  return /-nightly\./.test(app.getVersion());
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err));
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // Updates only exist for a packaged app.
  if (!app.isPackaged) return;
  // Nightlies have no feed of their own yet: they are unsigned on macOS and
  // published under a single moving `nightly` tag, which is not a version
  // electron-updater can compare. Left on, a prerelease version makes
  // electron-updater go looking for a `nightly` channel that does not exist.
  if (isNightlyBuild()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Stable follows tagged releases only. The nightly prerelease must never
  // be offered, and nothing should ever install an older version. The
  // `channel` setter is left alone on purpose: it flips allowDowngrade on
  // as a side effect.
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: () => {},
  };

  const notify = (event: MainToRendererEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('main:event', event);
  };

  autoUpdater.on('update-available', (info) => {
    notify({ kind: 'update:available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    notify({ kind: 'update:progress', percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    notify({ kind: 'update:downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater] update failed', err);
  });

  wired = true;

  // Shortly after launch so it does not compete with the window opening,
  // then every six hours for a window that stays open for days.
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/// Install a downloaded update now instead of at the next quit.
export function quitAndInstall(): void {
  if (!wired) return;
  autoUpdater.quitAndInstall();
}
