import { useMemo, useState } from 'react';
import type { Connection, EnvKind } from '@shared/types';
import {
  ago,
  clockTime,
  groupByDay,
  oneLine,
  searchHistory,
  searchSaved,
  suggestName,
  type HistoryEntry,
  type SavedQuery,
} from '@shared/history';
import { useStore } from './store';

/// Everything you have run, and everything you kept.
///
/// Deliberately not the session log, which sits one tab over. The log is
/// this window's activity — including what is still running, and with a
/// Cancel next to it — and it is gone when you quit. This survives, is
/// rolled up per statement, and is searchable, because the question it
/// answers is asked days later: "what was that query".
///
/// Saved queries live in the same pane rather than a separate one because
/// the act that creates one starts here: you find the statement in history
/// and give it a name. Splitting them across two panes would put the
/// starting point and the destination in different places.
///
/// **The layout is one grid, shared by the column header and every row.**
/// That is the whole of it: this list was a flex line with the metadata
/// pushed right, which on a wide window put "1,364 rows · 30 ms" seventeen
/// hundred pixels from the statement it described — and because the parts
/// are optional (a run count only sometimes, rows only on a read) nothing
/// lined up between one row and the next either. Fixed columns and a capped
/// width mean the window's size stops deciding how far the answer sits from
/// the question.

/// One place, because the header and the rows have to agree or the columns
/// are not columns. `rows` and `took` are wider than their figures need:
/// each carries a measure bar under the number.
const COLUMNS = '46px 116px minmax(0, 1fr) 34px 108px 96px 126px';

/// The same grid, with room in the first column for `ago`. Sorting breaks
/// the day grouping (see `Sort`), and without a day heading above it a bare
/// `09:23` says nothing — so the sorted list trades the clock for "3d ago",
/// which needs the width and, at its widest, an ISO date.
const COLUMNS_SORTED = '62px 116px minmax(0, 1fr) 34px 108px 96px 126px';

/// How the list is ordered.
///
/// `recent` is the list this pane is really about: newest first, cut into
/// days. The other two answer a question days cannot — "what did I run that
/// took nine seconds", "what did I run that came back with ten thousand
/// rows" — and to answer it they have to sort ACROSS days, which dissolves
/// the grouping entirely. That is why this is a mode and not a tiebreak:
/// choosing it costs you the day headings, and the header says so.
///
/// Note this is your OWN statements. "What is expensive on this server,
/// across every client" is the Slow queries tab, and it is a better answer
/// to that question than sorting twenty of your own rows will ever be.
type Sort = 'recent' | 'rows' | 'took';

/// How many saved queries stand on the shelf before it folds. Six is about
/// the most you can take in without reading, and leaves history above the
/// fold on a short pane.
const SAVED_SHELF = 6;

/// The environment's colour, in the order the sidebar already sorts by.
/// Same four tones the rest of the app uses for the same idea: this is
/// fine, this is not local, this is production.
const ENV_DOT: Record<EnvKind, string> = {
  local: 'bg-good/80',
  dev: 'bg-good/60',
  sandbox: 'bg-warn/80',
  staging: 'bg-warn/60',
  prod: 'bg-bad/80',
  other: 'bg-ink-faint/70',
};

export function HistoryPane({
  connection,
  onOpen,
}: {
  /// The connection in front, used to default the filter and to say which
  /// entries came from somewhere else.
  connection: Connection | null;
  /// Put a statement in the editor. Never runs it: a statement pulled out
  /// of history is one you are about to read again, and half of them are
  /// there because they went wrong.
  onOpen(sql: string): void;
}): JSX.Element {
  const history = useStore((s) => s.history);
  const savedQueries = useStore((s) => s.savedQueries);
  const connections = useStore((s) => s.connections);
  const slowQueryMs = useStore((s) => s.settings.slowQueryMs);
  const saveQuery = useStore((s) => s.saveQuery);
  const updateSavedQuery = useStore((s) => s.updateSavedQuery);
  const deleteSavedQuery = useStore((s) => s.deleteSavedQuery);
  const clearHistory = useStore((s) => s.clearHistory);
  const askConfirm = useStore((s) => s.askConfirm);
  const toast = useStore((s) => s.toast);

  const [query, setQuery] = useState('');
  const [thisConnectionOnly, setThisConnectionOnly] = useState(true);
  const [failedOnly, setFailedOnly] = useState(false);
  const [writesOnly, setWritesOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showAllSaved, setShowAllSaved] = useState(false);
  const [sort, setSort] = useState<Sort>('recent');

  const envOf = useMemo(() => {
    const byId = new Map(connections.map((c) => [c.id, c.env]));
    return (id: string): EnvKind => byId.get(id) ?? 'other';
  }, [connections]);

  const filtering = query.trim() !== '' || failedOnly || writesOnly || thisConnectionOnly;
  const searching = query.trim() !== '';
  const shownSaved = useMemo(() => searchSaved(savedQueries, query), [savedQueries, query]);
  // Saved is a shelf above the list, not a section of it: however long the
  // library gets, history has to still be the thing this pane opens on.
  // Newest-first is the order the store already keeps (`saveQuery` prepends),
  // so the ones on the shelf are the ones you most recently decided to keep.
  //
  // A search sees everything — that is the point of typing one — and the
  // toggle steps aside while it does, because "show all 23" next to a list
  // that is already showing all 3 matches is a lie.
  const savedShelf = searching || showAllSaved ? shownSaved : shownSaved.slice(0, SAVED_SHELF);
  const shownHistory = useMemo(
    () =>
      searchHistory(history, {
        query,
        connectionId: thisConnectionOnly ? (connection?.id ?? null) : null,
        failedOnly,
        writesOnly,
      }),
    [history, query, thisConnectionOnly, connection?.id, failedOnly, writesOnly],
  );
  const days = useMemo(() => groupByDay(shownHistory), [shownHistory]);
  const sortedHistory = useMemo(() => {
    if (sort === 'recent') return shownHistory;
    const measure = (e: HistoryEntry) => (sort === 'rows' ? e.rowCount : e.durationMs);
    // A write and a failure have no row count. They sort below zero rather
    // than above it: a statement with nothing to measure is not the biggest
    // thing you ran, and pinning it to the top would bury what you asked for.
    return [...shownHistory].sort((a, b) => (measure(b) ?? -1) - (measure(a) ?? -1));
  }, [shownHistory, sort]);

  /// The measures are scaled to what is on screen, not to all of history: a
  /// filtered list is its own comparison, and scaling against a huge
  /// statement you just filtered out would draw everything left as nothing.
  const scale = useMemo(() => {
    let rows = 0;
    let took = 0;
    for (const e of shownHistory) {
      if (e.ok && e.rowCount !== null && e.rowCount > rows) rows = e.rowCount;
      if (e.durationMs !== null && e.durationMs > took) took = e.durationMs;
    }
    return { rows, took };
  }, [shownHistory]);

  const keep = async (entry: HistoryEntry) => {
    const saved = await saveQuery({
      name: suggestName(entry.sql),
      sql: entry.sql,
      connectionId: entry.connectionId,
      tags: [],
    });
    // Straight into rename: a name overdb guessed is a starting point, and
    // making you find the row again to fix it is the difference between a
    // feature people use and one they try once.
    setRenaming(saved.id);
    toast('Saved. Give it a name.');
  };

  const clearFilters = () => {
    setQuery('');
    setFailedOnly(false);
    setWritesOnly(false);
    setThisConnectionOnly(false);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* No title: the rail button you pressed to get here already says
          History, and a pane that repeats its own name is a pane with less
          room for what is in it. What the bar needs is air — it sits
          directly under a tab strip and a splitter, and at py-1.5 it read
          as a third row of chrome rather than as this pane's controls. */}
      <div className="shrink-0 border-b border-card px-3.5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search statements…"
          className="bg-surface-muted border border-card rounded px-2.5 py-1 text-[11px] text-ink placeholder:text-ink-faint w-72"
        />
        {/* Searching and narrowing are two different moves. */}
        <span className="w-px self-stretch bg-rule" />
        {connection && (
          <Check checked={thisConnectionOnly} onChange={setThisConnectionOnly}>
            {connection.name} only
          </Check>
        )}
        <Check checked={failedOnly} onChange={setFailedOnly}>
          failed
        </Check>
        <Check checked={writesOnly} onChange={setWritesOnly}>
          writes
        </Check>
        <div className="flex-1" />
        <span className="text-[10px] text-ink-faint tabular-nums">
          {shownHistory.length} of {history.length}
        </span>
        <button
          onClick={() =>
            askConfirm({
              title: 'Clear the history?',
              body: `All ${history.length} remembered statements go, on every connection. Saved queries are not touched.`,
              confirmLabel: 'Clear it',
              destructive: true,
              onConfirm: () => void clearHistory(),
            })
          }
          disabled={history.length === 0}
          className="text-[10px] px-2 py-1 rounded border border-card text-ink-faint hover:text-ink disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div>
          {/* Present even when empty, with a count. A section that appears
              only once something is in it is a feature nobody finds — the
              row's Save button would have been the only thing that could
              ever tell you it exists. */}
          <GroupHead
            label="Saved"
            count={searching ? shownSaved.length : savedQueries.length}
            of={searching ? savedQueries.length : undefined}
            star
          />

          {savedQueries.length === 0 ? (
            <p className="px-3.5 pb-1 text-[11px] text-ink-faint">
              Nothing saved yet. <span className="text-ink-muted">Save</span> on any row below keeps
              it here under a name.
            </p>
          ) : shownSaved.length === 0 ? (
            <p className="px-3.5 pb-1 text-[11px] text-ink-faint">
              None of the {savedQueries.length} saved queries match.
            </p>
          ) : (
            // Its own ground, and one firm rule to close it off. Sharing the
            // grid with history made a saved query read as a run that
            // happened to have a name — the only thing saying otherwise was
            // a star two rows up. The rules between rows are the hairline
            // `rule`; the one under the shelf is `card`, so the first hard
            // line you meet is the one that introduces the table.
            <div className="bg-surface-muted border-b border-card divide-y divide-rule">
              {savedShelf.map((q) => (
                <SavedRow
                  key={q.id}
                  query={q}
                  connections={connections}
                  envOf={envOf}
                  renaming={renaming === q.id}
                  onRename={(name) => {
                    setRenaming(null);
                    if (name.trim()) void updateSavedQuery(q.id, { name: name.trim() });
                  }}
                  onStartRename={() => setRenaming(q.id)}
                  onOpen={() => onOpen(q.sql)}
                  onCopy={() => {
                    void window.overdb.invoke('app:copyText', q.sql);
                    toast('Copied.');
                  }}
                  onDelete={() =>
                    askConfirm({
                      title: `Delete “${q.name}”?`,
                      body: 'The statement itself may still be in your history.',
                      confirmLabel: 'Delete',
                      destructive: true,
                      onConfirm: () => void deleteSavedQuery(q.id),
                    })
                  }
                />
              ))}
              {!searching && shownSaved.length > SAVED_SHELF && (
                <button
                  onClick={() => setShowAllSaved(!showAllSaved)}
                  className="w-full px-3.5 py-1 text-left text-[10px] text-ink-faint hover:text-ink"
                >
                  {showAllSaved
                    ? 'Show fewer'
                    : `Show all ${shownSaved.length} — or search them above`}
                </button>
              )}
            </div>
          )}

          {history.length === 0 ? (
            <>
              <GroupHead label="History" />
              <p className="px-3.5 pb-2 text-[11px] text-ink-faint max-w-[74ch]">
                Nothing yet. Every statement you run is remembered here, across restarts — one entry
                per statement however many times you run it, so a query you keep coming back to
                stays one line rather than forty.
              </p>
            </>
          ) : shownHistory.length === 0 ? (
            <>
              <GroupHead label="History" />
              {/* Says which filter did it and offers the way back, rather
                  than leaving you to work out whether it was the search or
                  a checkbox. */}
              <p className="px-3.5 pb-2 text-[11px] text-ink-faint">
                No statement matches
                {query.trim() && (
                  <>
                    {' '}
                    <span className="font-mono text-ink">{query.trim()}</span>
                  </>
                )}
                {failedOnly && <span className="text-ink-muted"> among failed statements</span>}
                {writesOnly && <span className="text-ink-muted"> among writes</span>}
                {thisConnectionOnly && connection && (
                  <span className="text-ink-muted"> on {connection.name}</span>
                )}
                .{' '}
                <button onClick={clearFilters} className="text-accent hover:underline">
                  Search all {history.length}
                </button>
              </p>
            </>
          ) : (
            (() => {
              const row = (entry: HistoryEntry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  env={envOf(entry.connectionId)}
                  slowQueryMs={slowQueryMs}
                  scale={scale}
                  sorted={sort !== 'recent'}
                  expanded={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  onOpen={() => onOpen(entry.sql)}
                  onKeep={() => void keep(entry)}
                  onCopy={() => {
                    void window.overdb.invoke('app:copyText', entry.sql);
                    toast('Copied.');
                  }}
                />
              );
              // Sorted, the days are gone and there is one header for the
              // whole list — which is the honest shape of what sorting did.
              return sort === 'recent' ? (
                days.map((day) => (
                  <div key={day.key}>
                    <ColumnHead day={day.label} sort={sort} onSort={setSort} />
                    {day.entries.map(row)}
                  </div>
                ))
              ) : (
                <div>
                  <ColumnHead sort={sort} onSort={setSort} />
                  {sortedHistory.map(row)}
                </div>
              );
            })()
          )}

          {/* Space under a short list, so the footer note does not sit
              directly against the last row like a table summary. */}
          <div className="h-6" />
        </div>
      </div>

      <p className="shrink-0 border-t border-card px-3.5 py-1.5 text-[10px] text-ink-faint">
        Opening a statement puts it in the editor. Nothing here runs on its own — plenty of what is
        in a history is there because it went wrong.
        {filtering && history.length > 0 && shownHistory.length > 0 && (
          <>
            {' '}
            <button
              onClick={clearFilters}
              className="text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
            >
              Clear filters
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label
      className={`flex items-center gap-1.5 text-[11px] cursor-pointer ${
        checked ? 'text-ink-muted' : 'text-ink-faint'
      }`}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/// One of the two standing sections. Days do not use this — their heading
/// is folded into the column header (see `ColumnHead`), which is what keeps
/// a list of eight days from carrying sixteen bands of chrome.
function GroupHead({
  label,
  count,
  of,
  star,
}: {
  label: string;
  count?: number;
  /// The total behind the count, when a search has narrowed it. Without it
  /// a head reading `SAVED 2` over two rows gives no sign that twenty-one
  /// others are being filtered out rather than missing.
  of?: number;
  star?: boolean;
}): JSX.Element {
  // A fixed height rather than padding, so the two standing sections announce
  // themselves at the same weight however much is under them.
  return (
    <div className="flex items-center gap-2.5 px-3.5 h-[30px] bg-surface">
      {star && <span className={count ? 'text-accent' : 'text-ink-faint/60'}>★</span>}
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
      {count !== undefined && (
        <span className="text-[10px] tabular-nums text-ink-faint/60">
          {count}
          {of !== undefined && of !== count && ` of ${of}`}
        </span>
      )}
      <span className="flex-1 h-px bg-rule" />
    </div>
  );
}

/// The day and the column legend, as one row.
///
/// They were two stacked bands — a 30px day heading with a column header
/// sticking beneath it at top-[30px] — which put two uppercase labels
/// between you and every group's first row, and repeated the legend once
/// per day. The day takes the `at` and `where` columns, the two that never
/// needed naming: under `at` are clock times, under `where` is a connection
/// with its environment dot beside it. It is brighter than the legend
/// because it is a heading and they are labels.
///
/// Sticky, because eighty rows down this line is the only thing that still
/// says which afternoon you are reading.
function ColumnHead({
  day,
  sort,
  onSort,
}: {
  /// Absent when sorted — there are no days to name.
  day?: string;
  sort: Sort;
  onSort(sort: Sort): void;
}): JSX.Element {
  return (
    <div
      className="grid gap-3.5 items-baseline px-3.5 pt-2.5 pb-1 border-b border-card text-[10px] uppercase tracking-wide text-ink-faint sticky top-0 z-10 bg-surface"
      style={{ gridTemplateColumns: sort === 'recent' ? COLUMNS : COLUMNS_SORTED }}
    >
      {/* The sort announces itself in the slot the day heading vacated —
          the one place where what you gave up is exactly what you are
          looking at — and doubles as the way back. Sorting is a bigger
          change than a header click usually implies, so it does not get to
          happen silently. */}
      {sort === 'recent' ? (
        <span className="col-span-2 tracking-wider text-ink-muted">{day}</span>
      ) : (
        <button
          onClick={() => onSort('recent')}
          className="col-span-2 text-left tracking-wider text-accent hover:underline"
        >
          by {sort} · back to days
        </button>
      )}
      <span>statement</span>
      <span className="text-right">×</span>
      <SortHead
        label="rows"
        active={sort === 'rows'}
        onClick={() => onSort(sort === 'rows' ? 'recent' : 'rows')}
      />
      <SortHead
        label="took"
        active={sort === 'took'}
        onClick={() => onSort(sort === 'took' ? 'recent' : 'took')}
      />
      <span />
    </div>
  );
}

/// A column header that sorts. Only these two: they are the columns with a
/// measure bar under them, which is already a promise that the numbers are
/// worth comparing — clicking is what lets you finish the comparison.
function SortHead({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`text-right uppercase tracking-wide hover:text-ink ${
        active ? 'text-accent' : ''
      }`}
      title={active ? `Sorted by ${label} — click to go back to days` : `Sort by ${label}`}
    >
      {label}
      {active && ' ↓'}
    </button>
  );
}

function HistoryRow({
  entry,
  env,
  slowQueryMs,
  scale,
  sorted,
  expanded,
  onToggle,
  onOpen,
  onKeep,
  onCopy,
}: {
  entry: HistoryEntry;
  env: EnvKind;
  slowQueryMs: number;
  scale: { rows: number; took: number };
  /// Whether the list has been sorted out of day order, in which case there
  /// is no day heading above this row to date it.
  sorted: boolean;
  expanded: boolean;
  onToggle(): void;
  onOpen(): void;
  onKeep(): void;
  onCopy(): void;
}): JSX.Element {
  // Amber past the threshold the settings already define, so this pane and
  // the rest of the app agree about what counts as slow.
  const slow = slowQueryMs > 0 && entry.durationMs !== null && entry.durationMs >= slowQueryMs;

  return (
    <div
      className={`group grid gap-3.5 items-baseline py-1 text-[11px] border-b border-rule hover:bg-card ${
        entry.ok ? 'px-3.5' : 'pl-3 pr-3.5 border-l-2 border-l-red-400/70'
      }`}
      style={{ gridTemplateColumns: sorted ? COLUMNS_SORTED : COLUMNS }}
    >
      {/* `clockTime` is only readable under a day heading — that is what it
          says on the tin. Sorted, the row has to date itself. */}
      <span className="text-[10px] text-ink-faint tabular-nums">
        {sorted ? ago(entry.at) : clockTime(entry.at)}
      </span>

      {/* Always shown, even when the list is filtered to one connection —
          that is exactly when getting the server wrong costs most. */}
      <span className="flex items-center gap-1.5 min-w-0 text-[10px] text-ink-muted">
        <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${ENV_DOT[env]}`} />
        <span className="truncate">{entry.connectionName}</span>
      </span>

      <button onClick={onToggle} className="min-w-0 text-left">
        <span className="flex items-baseline gap-2 min-w-0">
          {entry.write && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide px-1 rounded-sm bg-warn/15 text-warn/90">
              write
            </span>
          )}
          <span
            className={`font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'truncate block'} ${
              entry.ok ? 'text-ink-muted' : 'text-bad/90'
            }`}
          >
            {expanded ? entry.sql : oneLine(entry.sql, 400)}
          </span>
        </span>
        {entry.error && (
          <span className="block text-[10px] text-ink-faint mt-0.5 truncate">{entry.error}</span>
        )}
      </button>

      {/* Blank at one run. A statement you have come back to three times is
          a different thing from one you ran once. */}
      <span className="text-[10px] text-ink-faint tabular-nums text-right">
        {entry.runs > 1 ? `×${entry.runs}` : ''}
      </span>

      {/* What a write CHANGED, not what it returned — a write always
          returns zero rows and reporting that says nothing. */}
      <Measure
        value={entry.ok ? entry.rowCount : null}
        max={scale.rows}
        tone={entry.write && entry.ok && (entry.rowCount ?? 0) > 0 ? 'good' : 'faint'}
        ramp="rows"
      >
        {!entry.ok
          ? '—'
          : entry.rowCount === null
            ? ''
            : entry.write
              ? `${entry.rowCount.toLocaleString()} changed`
              : entry.rowCount.toLocaleString()}
      </Measure>

      <Measure value={entry.durationMs} max={scale.took} tone={slow ? 'warn' : 'faint'} ramp="took">
        {entry.durationMs === null ? '' : formatMs(entry.durationMs)}
      </Measure>

      {/* A reserved column rather than something that appears on hover at
          the window's edge: present enough to be found, quiet enough not to
          shout on ninety rows. */}
      <span className="flex gap-1 justify-end whitespace-nowrap opacity-30 group-hover:opacity-100">
        <RowButton onClick={onOpen}>Open</RowButton>
        <RowButton onClick={onKeep}>Save</RowButton>
        <RowButton onClick={onCopy}>Copy</RowButton>
      </span>
    </div>
  );
}

function SavedRow({
  query,
  connections,
  envOf,
  renaming,
  onRename,
  onStartRename,
  onOpen,
  onCopy,
  onDelete,
}: {
  query: SavedQuery;
  connections: Connection[];
  envOf(id: string): EnvKind;
  renaming: boolean;
  onRename(name: string): void;
  onStartRename(): void;
  onOpen(): void;
  onCopy(): void;
  onDelete(): void;
}): JSX.Element {
  const written = connections.find((c) => c.id === query.connectionId);
  return (
    <div
      className="group grid gap-3.5 items-baseline px-3.5 py-1 text-[11px] hover:bg-card"
      style={{ gridTemplateColumns: COLUMNS }}
    >
      {/* A name wants room to be a name: it takes the clock and connection
          columns, which a saved query has nothing to put in anyway. */}
      {renaming ? (
        <input
          autoFocus
          defaultValue={query.name}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onRename('');
          }}
          className="col-span-2 bg-surface-muted border border-card rounded px-1.5 py-0 text-[11px] text-ink min-w-0"
        />
      ) : (
        <button
          onClick={onStartRename}
          className="col-span-2 text-[11px] text-ink truncate text-left"
        >
          {query.name}
        </button>
      )}
      <button onClick={onOpen} className="min-w-0 text-left">
        <span className="font-mono text-ink-faint truncate block">{oneLine(query.sql, 400)}</span>
      </button>
      <span />
      {/* A hint, not a restriction — the same statement somewhere else is
          the whole premise of this app. */}
      <span className="flex items-center gap-1.5 min-w-0 text-[10px] text-ink-faint col-span-2">
        {written && (
          <>
            <span
              className={`w-[5px] h-[5px] rounded-full shrink-0 ${ENV_DOT[envOf(written.id)]}`}
            />
            <span className="truncate">{written.name}</span>
          </>
        )}
      </span>
      <span className="flex gap-1 justify-end whitespace-nowrap opacity-30 group-hover:opacity-100">
        <RowButton onClick={onOpen}>Open</RowButton>
        <RowButton onClick={onCopy}>Copy</RowButton>
        <RowButton onClick={onDelete}>Delete</RowButton>
      </span>
    </div>
  );
}

type MeasureTone = 'faint' | 'warn' | 'good';

/// A number and, under it, how big that number is next to the biggest one on
/// screen. Square root rather than linear: history is a few large statements
/// and a long tail of small ones, and a linear scale draws that tail as
/// nothing at all. It is a texture you read down the column, not a chart —
/// the figure above it is still the answer.
function Measure({
  value,
  max,
  tone,
  ramp,
  children,
}: {
  value: number | null;
  max: number;
  tone: MeasureTone;
  ramp: 'rows' | 'took';
  children: React.ReactNode;
}): JSX.Element {
  const fraction = value === null || value <= 0 || max <= 0 ? 0 : Math.sqrt(value / max);
  return (
    <span className="min-w-0 flex flex-col items-end gap-[3px]">
      <span className={`text-[10px] tabular-nums leading-none ${MEASURE_TEXT[tone]}`}>
        {children}
      </span>
      {fraction > 0 && (
        <span className="w-full h-[2px] flex justify-end">
          {/* A floor, so one row out of ten thousand still shows something
              rather than reading as a statement that returned nothing. */}
          <span
            className={`h-full rounded-full ${barColor(fraction, ramp)}`}
            style={{ width: `${Math.max(fraction * 100, 3)}%` }}
          />
        </span>
      )}
    </span>
  );
}

/// Colour carries the same thing the length does, so the column reads at a
/// glance without measuring anything against its neighbours.
///
/// The two ramps say different things and so are different hues. Time runs
/// green → amber → orange, because a slow statement is a problem: that is
/// the same language the slow-query threshold and the rest of the app
/// already speak. A row count is not good or bad at any size, so it stays
/// on the accent hue and only gets more present as it grows.
function barColor(fraction: number, ramp: 'rows' | 'took'): string {
  if (ramp === 'took') {
    if (fraction < 0.34) return 'bg-good/60';
    if (fraction < 0.67) return 'bg-warn/65';
    return 'bg-hot/75';
  }
  if (fraction < 0.34) return 'bg-accent/35';
  if (fraction < 0.67) return 'bg-accent/60';
  return 'bg-accent/85';
}

const MEASURE_TEXT: Record<MeasureTone, string> = {
  faint: 'text-ink-faint',
  warn: 'text-warn/90',
  good: 'text-good/90',
};

function RowButton({
  onClick,
  children,
}: {
  onClick(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="shrink-0 text-[10px] leading-[15px] px-1.5 rounded border border-card text-ink-faint group-hover:text-ink-muted hover:!text-ink"
    >
      {children}
    </button>
  );
}

/// Milliseconds up to a second, then seconds. `1200 ms` reads as a smaller
/// number than `320 ms` at a glance, which is the wrong way round.
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
