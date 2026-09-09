import { useEffect, useState } from 'react';
import { useStore } from './store';

/// One confirm dialog for the whole app, driven from the store. Destructive
/// actions get a red button and Enter is NOT bound to confirm — for a
/// question you can answer wrong once and not undo, the muscle memory of
/// hitting Enter shouldn't be enough.
export function ConfirmHost(): JSX.Element | null {
  const confirm = useStore((s) => s.confirm);
  const askConfirm = useStore((s) => s.askConfirm);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') askConfirm(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, askConfirm]);

  if (!confirm) return null;

  const go = async () => {
    setBusy(true);
    try {
      await confirm.onConfirm();
      askConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-40 bg-black/50"
      onClick={() => askConfirm(null)}
    >
      <div
        className="w-[420px] rounded-lg border border-card bg-surface-elevated shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-ink mb-1.5">{confirm.title}</h2>
        <p className="text-xs text-ink-muted leading-relaxed">{confirm.body}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => askConfirm(null)}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={() => void go()}
            disabled={busy}
            className={`text-xs px-3 py-1.5 rounded text-white disabled:opacity-40 ${
              confirm.destructive
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-accent hover:bg-accent-strong'
            }`}
          >
            {busy ? 'Working…' : confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
