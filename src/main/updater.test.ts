// Which builds check for updates, and which direction they may move.
//
// electron-updater's `channel` setter flips `allowDowngrade` on as a side
// effect — in overcli that let a build silently install an older version. The
// mock reproduces the setter so a future edit that assigns a channel fails
// here instead of in the field.

import { beforeEach, describe, expect, it, vi } from 'vitest';

let version = '0.2.0';
let isPackaged = true;

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackaged;
    },
    getVersion: () => version,
  },
}));

// Hoisted, so the mock factory below can reach it before the module under
// test is imported.
const { autoUpdater } = vi.hoisted(() => ({
  autoUpdater: {
    _channel: null as string | null,
    allowPrerelease: true,
    allowDowngrade: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    get channel() {
      return this._channel;
    },
    // Mirrors AppUpdater's real setter, side effect and all.
    set channel(value: string | null) {
      this._channel = value;
      this.allowDowngrade = true;
    },
    on: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater }));

import { initAutoUpdater } from './updater';

function init(opts: { version: string; packaged?: boolean }) {
  version = opts.version;
  isPackaged = opts.packaged ?? true;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = false;
  autoUpdater.on.mockClear();
  initAutoUpdater(() => null);
}

describe('auto-updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('follows tagged releases only on a stable build', () => {
    init({ version: '0.2.0' });
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  it('checks shortly after launch', () => {
    autoUpdater.checkForUpdates.mockClear();
    init({ version: '0.2.0' });
    vi.advanceTimersByTime(10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does nothing when running unpackaged', () => {
    init({ version: '0.2.0', packaged: false });
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.autoDownload).toBe(false);
  });

  // No nightly feed exists yet; a nightly must not wander onto stable.
  it('does nothing on a nightly build', () => {
    init({ version: '0.2.0-nightly.20260923.abc1234' });
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.autoDownload).toBe(false);
  });
});
