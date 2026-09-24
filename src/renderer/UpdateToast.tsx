import { useEffect, useState } from 'react';

// The auto-updater's side of the window (see src/main/updater.ts). It keeps
// its own subscription to the update:* events rather than going through a
// store: nothing else in the app cares about them.
//
// The download runs quietly; once it is done this offers a restart. The
// install waits for the next quit either way, so "Later" only hides the
// prompt — the update still applies.
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string };

export function UpdateToast(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      window.overdb.onMainEvent((e) => {
        if (e.kind === 'update:available') {
          setDismissed(false);
          setState({ phase: 'downloading', percent: 0 });
        } else if (e.kind === 'update:progress') {
          setState({ phase: 'downloading', percent: e.percent });
        } else if (e.kind === 'update:downloaded') {
          setDismissed(false);
          setState({ phase: 'ready', version: e.version });
        }
      }),
    [],
  );

  if (state.phase === 'idle' || dismissed) return null;

  return (
    <div className="w-[280px] px-3 py-2 rounded border border-card bg-surface-elevated text-xs text-ink shadow-lg flex flex-col gap-2">
      {state.phase === 'downloading' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-faint">Downloading update…</span>
            <span className="tabular-nums">{state.percent}%</span>
          </div>
          <div className="h-1 rounded-full bg-card overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            Overdb <span className="font-medium">{state.version}</span> is ready to install.
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1 rounded text-white bg-accent hover:bg-accent-strong"
              onClick={() => void window.overdb.invoke('update:quitAndInstall')}
            >
              Restart now
            </button>
            <button
              className="px-2 py-1 rounded text-ink-faint hover:text-ink"
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </div>
        </>
      )}
    </div>
  );
}
