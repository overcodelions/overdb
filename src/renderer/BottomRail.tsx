import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RESIZER_PX } from './Resizer';
import { useStore } from './store';

/// The one bar that ends the window.
///
/// There used to be two: a 36px footer under the sidebar and a 28px status
/// bar under the results, whose top rules sat 8px apart. Rather than keep
/// two heights in agreement across two files, there is now a single rail
/// spanning both columns — the seam it was misaligned across no longer
/// exists.
///
/// It is also where the results pane's tab strip stopped carrying two jobs.
/// The strip is now only "which statement"; everything that is *not* an
/// answer to what you just ran — the server's health, the diagram, slow
/// queries, your history and this session's log — lives out here as window
/// furniture, and the Table/Chart switch sits next to the row count it
/// describes rather than beside five things that are not views of a table.
const MAIN_SLOT = 'bottom-rail-main';

export function BottomRail(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const setSheet = useStore((s) => s.setSheet);

  return (
    <div className="h-7 shrink-0 border-t border-card bg-surface-muted flex items-stretch text-[11px] text-ink-faint">
      {settings.sidebarVisible && (
        // The rail reproduces the column structure above it exactly —
        // sidebar, resizer, main — rather than folding the resizer into the
        // sidebar half. Carrying the handle's width made this cell one
        // border thickness too wide in the wrong place: the rail's rule
        // landed 5px right of the sidebar's own, so the long vertical line
        // down the window took a visible jog on its last 28px.
        <>
          <div
            style={{ width: settings.sidebarWidth }}
            className="shrink-0 min-w-0 border-r border-card px-3 flex items-center gap-2"
          >
            <button
              onClick={() => setSheet({ kind: 'newConnection' })}
              className="text-ink-muted hover:text-accent flex items-center gap-1.5 whitespace-nowrap"
            >
              <span className="text-sm leading-none">+</span>
              New connection
            </button>
            <div className="flex-1" />
            <button
              onClick={() => setSheet({ kind: 'importConnections' })}
              title="Import from DataGrip, DataSpell, IntelliJ, DBeaver or ~/.pgpass"
              className="hover:text-accent"
            >
              Import
            </button>
          </div>
          {/* The resizer's own column, continued. Nothing to drag down here
              — it exists so the main slot starts where the pane above it
              does. */}
          <div style={{ width: RESIZER_PX }} className="shrink-0" />
        </>
      )}
      <div
        id={MAIN_SLOT}
        className="flex-1 min-w-0 px-3.5 flex items-center gap-3 overflow-x-auto"
      />
    </div>
  );
}

/// Fills the rail's right-hand half from whichever pane is mounted.
///
/// A portal rather than lifted state: what belongs on the rail is the
/// current pane's business — the row count, its filters, its view switch —
/// and hoisting all of that into a shared store to render it one level up
/// would trade a layout problem for an ownership one.
export function RailSlot({ children }: { children: ReactNode }): JSX.Element | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // After mount, so the rail below us is in the document by the time we
  // look for it. Re-run on every render is unnecessary; it never moves.
  useEffect(() => setSlot(document.getElementById(MAIN_SLOT)), []);
  return slot ? createPortal(children, slot) : null;
}
