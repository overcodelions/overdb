import { useEffect, useState } from 'react';
import { ConnectionForm } from './ConnectionForm';
import { ImportSheet } from './ImportSheet';
import { useStore } from './store';

/// Backdrop + escape-to-close wrapper shared by every sheet, so no
/// individual sheet has to remember the dismissal rules.
export function SheetHost(): JSX.Element | null {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, setSheet]);

  if (!sheet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center pt-24 bg-black/40"
      onClick={() => setSheet(null)}
    >
      <div
        className="w-[520px] max-h-[70vh] overflow-auto rounded-lg border border-card bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {sheet.kind === 'about' && <AboutSheet />}
        {sheet.kind === 'settings' && <SettingsSheet />}
        {sheet.kind === 'newConnection' && <ConnectionForm onDone={() => setSheet(null)} />}
        {sheet.kind === 'editConnection' && <EditConnectionSheet id={sheet.id} />}
        {sheet.kind === 'importConnections' && <ImportSheet />}
        {sheet.kind === 'newEnvSet' && <PlaceholderSheet title="New environment set" />}
      </div>
    </div>
  );
}

function AboutSheet(): JSX.Element {
  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">overdb</h2>
      <p className="text-xs text-ink-muted leading-relaxed mb-3">
        A database client built around environments rather than connections.
        Sibling to overcli and overgit.
      </p>
      <p className="text-[11px] text-ink-faint leading-relaxed">
        Read-only by default. Credentials are encrypted with your OS keychain and
        never reach this window. AI features use your own installed CLI login, and
        prompts never contain your rows.
      </p>
      <button
        onClick={() => void window.overdb.invoke('app:openExternal', 'https://github.com/overcodelions/overdb')}
        className="mt-4 text-xs text-accent hover:underline"
      >
        github.com/overcodelions/overdb
      </button>
    </div>
  );
}

function SettingsSheet(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-4">Settings</h2>
      <label className="flex items-center justify-between text-xs text-ink mb-3">
        Theme
        <select
          className="field px-2 py-1 text-xs"
          value={settings.theme}
          onChange={(e) => saveSettings({ theme: e.target.value as typeof settings.theme })}
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="flex items-center justify-between text-xs text-ink">
        Row limit
        <input
          type="number"
          className="field px-2 py-1 text-xs w-28 text-right"
          value={settings.rowLimit}
          min={100}
          step={100}
          onChange={(e) => saveSettings({ rowLimit: Number(e.target.value) || 1000 })}
        />
      </label>
      <p className="mt-2 text-[11px] text-ink-faint leading-snug">
        Results stop at this many rows and offer to keep going. Bounded on purpose —
        an unbounded fetch is how a client runs your machine out of memory.
      </p>

      <label className="flex items-center justify-between text-xs text-ink mt-4">
        Offer to explain queries slower than
        <span className="flex items-center gap-1">
          <input
            type="number"
            className="field px-2 py-1 text-xs w-24 text-right"
            value={settings.slowQueryMs}
            min={0}
            step={250}
            onChange={(e) => saveSettings({ slowQueryMs: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="text-ink-faint">ms</span>
        </span>
      </label>
      <p className="mt-1 text-[11px] text-ink-faint leading-snug">0 turns the nudge off.</p>

      <label className="flex items-center justify-between text-xs text-ink mt-4">
        Fast model (claude)
        <input
          className="field px-2 py-1 text-xs w-32 font-mono"
          value={settings.aiFastModel.claude}
          placeholder="haiku"
          onChange={(e) =>
            saveSettings({ aiFastModel: { ...settings.aiFastModel, claude: e.target.value } })
          }
        />
      </label>
      <p className="mt-1 text-[11px] text-ink-faint leading-snug">
        Used for the frequent, low-stakes calls — fixing a failed query, short
        suggestions. Blank uses the CLI&#39;s own default.
      </p>
    </div>
  );
}

function PlaceholderSheet({ title }: { title: string }): JSX.Element {
  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{title}</h2>
      <p className="text-xs text-ink-muted">Not built yet — see docs/PLAN.md.</p>
    </div>
  );
}

function EditConnectionSheet({ id }: { id: string }): JSX.Element {
  const connection = useStore((s) => s.connections.find((c) => c.id === id));
  const setSheet = useStore((s) => s.setSheet);
  if (!connection) {
    return <div className="p-5 text-xs text-ink-muted">That connection no longer exists.</div>;
  }
  // Keyed on the id so switching which connection you're editing resets the
  // form's state instead of carrying the previous one's values over.
  return <ConnectionForm key={id} existing={connection} onDone={() => setSheet(null)} />;
}
