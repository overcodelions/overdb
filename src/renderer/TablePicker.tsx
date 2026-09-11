import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';

/// Choosing which tables the AI sees.
///
/// A 900-table catalog is megabytes of DDL, so something has to pick a
/// couple of dozen. Scoring names against the question is the right default
/// — you should not need to know your own schema to ask about it — but it is
/// a guess, and until this existed a wrong guess had no remedy: the model
/// said "I don't see an events table" and you had no way to say "that one".
///
/// So the automatic pick stays, and a pin overrides it. Pins are
/// unconditional, survive restarts, and force the table's shape to be loaded
/// even where a describe budget skipped it.
export function TablePicker({
  connectionId,
  onClose,
}: {
  connectionId: string;
  onClose(): void;
}): JSX.Element {
  const conn = useStore((s) => s.connections.find((c) => c.id === connectionId));
  const tableFilter = conn?.tableFilter?.trim();
  const togglePinnedTable = useStore((s) => s.togglePinnedTable);
  const [tables, setTables] = useState<Array<{ schema: string; table: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    window.overdb
      .invoke('conn:listTables', connectionId)
      .then((rows) => {
        if (live) setTables(rows.map((r) => ({ schema: r.schema, table: r.table })));
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [connectionId]);

  const pinned = useMemo(() => new Set(conn?.pinnedTables ?? []), [conn?.pinnedTables]);

  /// Pinned rows are hoisted to the top and are never filtered out by the
  /// search box. What you have chosen should not disappear because you typed
  /// something that does not match it — you would think you had lost it.
  const rows = useMemo(() => {
    if (!tables) return [];
    const needle = filter.trim().toLowerCase();
    const qualify = (t: { schema: string; table: string }) => `${t.schema}.${t.table}`;
    const match = (t: { schema: string; table: string }) =>
      !needle || qualify(t).toLowerCase().includes(needle);
    const isPinned = (t: { schema: string; table: string }) => pinned.has(qualify(t));
    return tables
      .filter((t) => isPinned(t) || match(t))
      .sort(
        (a, b) =>
          Number(isPinned(b)) - Number(isPinned(a)) || qualify(a).localeCompare(qualify(b)),
      )
      .slice(0, 400);
  }, [tables, filter, pinned]);

  const shown = rows.length;
  const total = tables?.length ?? 0;

  return (
    <div className="p-4 flex flex-col gap-3 max-h-[70vh]">
      <div>
        <h2 className="text-sm font-semibold text-ink">Tables the AI sees</h2>
        <p className="mt-1 text-[11px] text-ink-faint leading-relaxed">
          By default overdb picks tables by matching your question against their names — a
          catalog this size does not fit in a prompt. Pin the ones that always matter and they
          go in regardless, ahead of anything it chose on its own.
        </p>
      </div>

      {tableFilter && (
        <p className="text-[10px] text-ink-faint">
          This connection is scoped to{' '}
          <code className="font-mono text-ink-muted">{tableFilter}</code> — tables outside that
          are not listed here. Edit the connection to widen it.
        </p>
      )}

      <input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Find a table"
        className="field px-2 py-1 text-xs"
      />

      {error ? (
        <p className="text-[11px] text-bad-strong">Could not list tables: {error}</p>
      ) : !tables ? (
        <p className="text-[11px] text-ink-faint">Reading the catalog…</p>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto rounded border border-card divide-y divide-card">
            {rows.map((t) => {
              const qualified = `${t.schema}.${t.table}`;
              const on = pinned.has(qualified);
              return (
                <button
                  key={qualified}
                  onClick={() => togglePinnedTable(connectionId, qualified)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-card ${
                    on ? 'text-ink' : 'text-ink-muted'
                  }`}
                >
                  <span
                    className={`w-3.5 shrink-0 text-center ${on ? 'text-accent' : 'text-ink-faint/40'}`}
                    aria-hidden
                  >
                    {on ? '★' : '☆'}
                  </span>
                  <span className="font-mono truncate">{t.table}</span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-ink-faint shrink-0">{t.schema}</span>
                </button>
              );
            })}
            {rows.length === 0 && (
              <p className="px-2.5 py-3 text-[11px] text-ink-faint">Nothing matches “{filter}”.</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <p className="text-[10px] text-ink-faint">
              {pinned.size} pinned · showing {shown} of {total}
              {shown < total && filter.trim() === '' ? ' (narrow the filter to see the rest)' : ''}
            </p>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="text-[11px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
