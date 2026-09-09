import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/// ⌘K. Sections grow with the app; for now it navigates and opens sheets.
export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setSheet = useStore((s) => s.setSheet);
  const select = useStore((s) => s.select);
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      fn();
      setOpen(false);
    };
    return [
      ...envSets
        .filter((e) => !e.archived)
        .map((e) => ({
          id: `envset:${e.id}`,
          label: e.name,
          hint: 'env set',
          run: close(() => select({ kind: 'envSet', id: e.id })),
        })),
      ...connections.map((c) => ({
        id: `conn:${c.id}`,
        label: c.name,
        hint: c.env,
        run: close(() => select({ kind: 'connection', id: c.id })),
      })),
      { id: 'new-connection', label: 'New connection…', run: close(() => setSheet({ kind: 'newConnection' })) },
      { id: 'new-envset', label: 'New environment set…', run: close(() => setSheet({ kind: 'newEnvSet' })) },
      { id: 'settings', label: 'Settings…', run: close(() => setSheet({ kind: 'settings' })) },
    ];
  }, [connections, envSets, select, setSheet, setOpen]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-32 bg-black/40" onClick={() => setOpen(false)}>
      <div
        className="w-[560px] rounded-lg border border-card bg-surface-elevated shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder="Jump to a connection or env set…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              matches[cursor]?.run();
            }
          }}
          className="w-full px-4 py-3 bg-transparent text-sm text-ink outline-none border-b border-card"
        />
        <div className="max-h-[320px] overflow-auto py-1">
          {matches.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-faint">No matches.</p>
          ) : (
            matches.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setCursor(i)}
                onClick={c.run}
                className={`w-full text-left px-4 py-1.5 flex items-baseline gap-3 ${
                  i === cursor ? 'bg-card' : ''
                }`}
              >
                <span className="text-xs text-ink">{c.label}</span>
                <div className="flex-1" />
                {c.hint && <span className="text-[10px] text-ink-faint">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
