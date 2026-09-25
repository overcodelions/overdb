import { useEffect, useMemo, useState } from 'react';
import { ensureTerminated, formatSql } from '@shared/formatSql';
import { suggestionBlock } from '@shared/suggestion';
import { useStore } from './store';
import { ERD_TAB, HEALTH_TAB, HISTORY_TAB, SLOW_TAB, useQuery } from './queryStore';

interface Command {
  id: string;
  label: string;
  hint?: string;
  /// Extra text the filter searches but never shows. A saved query is found
  /// as often by a table in it as by the name someone gave it, and putting
  /// the whole statement in the label would make every row unreadable.
  keywords?: string;
  run: () => void;
}

/// ⌘K. Sections grow with the app; for now it navigates and opens sheets.
export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setActiveTab = useQuery((s) => s.setActive);
  const setSheet = useStore((s) => s.setSheet);
  const openSample = useStore((s) => s.openSample);
  const select = useStore((s) => s.select);
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const savedQueries = useStore((s) => s.savedQueries);
  const selection = useStore((s) => s.selection);
  const newBuffer = useStore((s) => s.newBuffer);
  const setBuffer = useStore((s) => s.setBuffer);
  const formatStyle = useStore((s) => s.settings.formatStyle);
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
      // Saved queries, by name. The History pane is where you make one and
      // where you go to browse them; this is how you get one back when you
      // already know what it is called, which is most of the time and does
      // not want a pane at all.
      ...savedQueries
        .map((q) => ({
          q,
          // A saved query's own connection is a hint, not a restriction —
          // running the same statement somewhere else is the premise of the
          // app — so wherever you are standing wins, and its own connection
          // is only the fallback for opening one from nowhere in particular.
          target:
            selection?.kind === 'connection'
              ? selection.id
              : connections.some((c) => c.id === q.connectionId)
                ? q.connectionId
                : null,
        }))
        // Nowhere to put it: no connection selected, and the one it was
        // written against is gone. A row that cannot do anything is worse
        // than a row that is not there.
        .filter((x): x is { q: (typeof savedQueries)[number]; target: string } => !!x.target)
        .map(({ q, target }) => ({
          id: `saved:${q.id}`,
          label: q.name,
          hint: 'saved',
          keywords: `${q.sql} ${q.tags.join(' ')}`,
          run: close(() => {
            if (selection?.kind !== 'connection' || selection.id !== target) {
              select({ kind: 'connection', id: target });
            }
            // A tab of its own, not appended to whatever you were typing:
            // reaching for ⌘K is starting something, and the note says
            // where it came from so it is not mistaken for your own typing
            // a week later.
            const key = newBuffer(target);
            setBuffer(
              key,
              suggestionBlock(ensureTerminated(formatSql(q.sql, formatStyle)), `Saved · ${q.name}`),
            );
          }),
        })),
      // The standing views. They live behind tabs at the bottom of the
      // query pane, which is the right place to have them and the wrong
      // place to discover them.
      {
        id: 'view-history',
        label: 'History and saved queries',
        hint: 'view',
        run: close(() => setActiveTab(HISTORY_TAB)),
      },
      {
        id: 'view-health',
        label: 'Server health',
        hint: 'view',
        run: close(() => setActiveTab(HEALTH_TAB)),
      },
      {
        id: 'view-diagram',
        label: 'Schema diagram',
        hint: 'view',
        run: close(() => setActiveTab(ERD_TAB)),
      },
      {
        id: 'view-slow',
        label: 'Slow queries',
        hint: 'view',
        run: close(() => setActiveTab(SLOW_TAB)),
      },
      { id: 'new-connection', label: 'New connection…', run: close(() => setSheet({ kind: 'newConnection' })) },
      { id: 'new-envset', label: 'New environment set…', run: close(() => setSheet({ kind: 'newEnvSet' })) },
      { id: 'import', label: 'Import connections…', keywords: 'datagrip dbeaver pgpass intellij', run: close(() => setSheet({ kind: 'importConnections' })) },
      { id: 'settings', label: 'Settings…', run: close(() => setSheet({ kind: 'settings' })) },
      // Help. Worded as the question someone has when they reach for it.
      { id: 'help-basics', label: 'How overdb works', hint: 'help', keywords: 'help environment set baseline drift', run: close(() => setSheet({ kind: 'basics' })) },
      { id: 'help-shortcuts', label: 'Keyboard shortcuts', hint: 'help', keywords: 'keys hotkeys', run: close(() => setSheet({ kind: 'shortcuts' })) },
      { id: 'help-sample', label: 'Try the sample database', hint: 'help', keywords: 'demo example', run: close(() => void openSample()) },
      { id: 'help-about', label: 'About overdb', hint: 'help', run: close(() => setSheet({ kind: 'about' })) },
    ];
  }, [
    connections,
    envSets,
    savedQueries,
    selection,
    formatStyle,
    newBuffer,
    setBuffer,
    select,
    setSheet,
    openSample,
    setOpen,
    setActiveTab,
  ]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q));
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
          placeholder="Jump to a connection, env set or saved query — or type help…"
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
