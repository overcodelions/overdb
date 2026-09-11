import { useEffect, useRef, useState } from 'react';
import { BottomRail } from './BottomRail';
import { CommandPalette } from './CommandPalette';
import { ConfirmHost } from './ConfirmHost';
import { QueryPane } from './QueryPane';
import { Resizer } from './Resizer';
import { Sidebar } from './Sidebar';
import { SheetHost } from './Sheets';
import { TitleBar } from './TitleBar';
import { subscribeToMainEvents } from './queryStore';
import { useStore } from './store';
import { useThemeEffect } from './useThemeEffect';

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready);
  const hydrate = useStore((s) => s.hydrate);
  const settings = useStore((s) => s.settings);
  const selection = useStore((s) => s.selection);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const toasts = useStore((s) => s.toasts);

  useThemeEffect();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // One subscription for the whole app: result chunks, completion, and
  // failures all arrive on the single main:event channel.
  useEffect(() => subscribeToMainEvents(), []);

  // Connection state is pushed, so a window that has just loaded knows
  // nothing about hosts that have been open since before it existed — a
  // reload used to leave every status dot hollow on connections it was
  // still querying. Asked after the subscription is installed, so a push
  // that lands during the round trip is not the one that gets overwritten.
  useEffect(() => {
    let live = true;
    void window.overdb.invoke('conn:states').then((open) => {
      if (live) useStore.getState().seedConnStates(open);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!useStore.getState().paletteOpen);
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        useStore.getState().toggleSidebar();
      } else if (mod && e.key.toLowerCase() === 't') {
        // A clean slate on the connection you are looking at. Only when one
        // is selected — there is nothing to open a tab on otherwise.
        const sel = useStore.getState().selection;
        if (sel?.kind === 'connection') {
          e.preventDefault();
          useStore.getState().newBuffer(sel.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  return (
    <div className="h-full flex flex-col bg-surface text-ink">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        {settings.sidebarVisible && <SidebarWithResize />}
        <div className="flex-1 min-w-0">
          {!ready ? null : selection ? <QueryPane /> : <Welcome />}
        </div>
      </div>
      <BottomRail />
      <SheetHost />
      <CommandPalette />
      <ConfirmHost />
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-3 py-2 rounded border text-xs shadow-lg ${
                t.tone === 'error'
                  ? 'bg-bad/10 border-bad/40 text-bad-strong'
                  : 'bg-surface-elevated border-card text-ink'
              }`}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// Width lives in settings so it survives a restart. The drag is tracked
/// through a ref rather than state: re-rendering the whole tree on every
/// mousemove makes the divider feel like it's lagging behind the cursor.
function SidebarWithResize(): JSX.Element {
  const width = useStore((s) => s.settings.sidebarWidth);
  const saveSettings = useStore((s) => s.saveSettings);

  return (
    <>
      <div style={{ width }} className="shrink-0 min-w-0">
        <Sidebar />
      </div>
      <Resizer
        axis="x"
        label="Sidebar width"
        value={width}
        min={180}
        max={480}
        fallback={260}
        onChange={(w) => saveSettings({ sidebarWidth: w })}
      />
    </>
  );
}

function Welcome(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <h1 className="text-sm font-semibold text-ink">No connection selected</h1>
      <p className="text-xs text-ink-muted max-w-sm leading-relaxed">
        Add a Postgres, MySQL, or SQLite connection to get started. Group the same
        database across local, staging, and prod into an environment set to query
        them all at once.
      </p>
      <button
        onClick={() => setSheet({ kind: 'newConnection' })}
        className="mt-1 text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
      >
        New connection
      </button>
      <p className="text-[11px] text-ink-faint mt-2">or press ⌘K</p>
    </div>
  );
}
