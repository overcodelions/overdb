import { useEffect, useMemo, useState } from 'react';
import type { Connection, TableInfo } from '@shared/types';
import {
  buildQuery,
  keyAttributes,
  shapeFromTableInfo,
  type Condition,
  type SortOp,
} from '@shared/dynamo';
import { previewStatement } from '@shared/preview';
import { useQuery } from './queryStore';
import { useStore } from './store';

/// Browsing a database instead of remembering it.
///
/// On a relational engine this is a convenience: `select * from orders limit
/// 200` is twelve keystrokes and everyone knows them. On DynamoDB it is the
/// difference between finding your data and not — the statement that finds
/// an item cannot be written without the key schema in front of you, and
/// which index carries which partition key IS the query plan.
///
/// So the panel is built around one idea: you describe your data in
/// ATTRIBUTES, and overdb works out which index makes that a key lookup and
/// says which one it chose and why. Picking the index first would mean
/// knowing the answer before you can ask the question — and picking wrong is
/// not a slower query, it is a full table read. The choice stays overridable;
/// it just stops being something you have to make from nothing.
/// Which schemas are folded, per connection, for the life of the process.
/// Deliberately not in the zustand store: nothing else needs to read it, and
/// nothing persists it — it is where the scrollbar was, not a setting.
const FOLDS = new Map<string, Set<string>>();
const foldMemory = (id: string): Set<string> => new Set(FOLDS.get(id) ?? []);
/// Connections whose fold state has been seeded from the catalog once.
/// Separate from FOLDS because "folded nothing" is a state you can choose
/// (Expand all), and it must not read as "never seeded".
const SEEDED = new Set<string>();

/// Above this many schemas the explorer opens folded. Set where a list stops
/// being something you read and starts being something you scroll.
const FOLD_BY_DEFAULT_ABOVE = 4;

export function TableBrowser({
  conn,
  onInsert,
  onClose,
}: {
  conn: Connection;
  /// Put the statement in the editor. Never auto-runs — the same rule the
  /// AI panel follows.
  onInsert(sql: string): void;
  onClose(): void;
}): JSX.Element {
  const schema = useStore((s) => s.schemas[conn.id]);
  const schemaLoading = useStore((s) => s.schemaLoading[conn.id]);
  const loadSchema = useStore((s) => s.loadSchema);
  const activeSchema = useStore((s) => s.activeSchema[conn.id]);
  const run = useQuery((s) => s.run);
  const running = useQuery((s) => s.running);

  const toggleHiddenSchema = useStore((s) => s.toggleHiddenSchema);
  const showAllSchemas = useStore((s) => s.showAllSchemas);

  const hidden = useMemo(() => new Set(conn.hiddenSchemas ?? []), [conn.hiddenSchemas]);

  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  /// Schemas folded shut. Kept as the exception rather than the rule — the
  /// list opens the way it always has, and folding is something you do to
  /// the eighteen schemas you are not working in.
  ///
  /// Remembered per connection for as long as the app is up: collapsing 26
  /// schemas and then losing it because you looked at another server is the
  /// kind of small betrayal that stops people using the control at all. It
  /// is not persisted to disk — folding is a view, not a setting. Hiding is
  /// the durable one, and that lives on the connection.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => foldMemory(conn.id));
  /// Hidden schemas, revealed temporarily so you can unhide one. Not a mode
  /// you can get stuck in — it resets with the connection.
  const [revealHidden, setRevealHidden] = useState(false);

  /// Revealing is for finding a schema by NAME, not for reading it.
  ///
  /// So the schemas come back folded, however they were left. Unhiding one
  /// of two schemas should not mean scrolling four hundred tables you
  /// deliberately put away to reach the band you were aiming at — the whole
  /// point of the mode is to see the short list of what is hidden.
  const setReveal = (on: boolean) => {
    setRevealHidden(on);
    if (!on) return;
    setOpen(null);
    setCollapsed((prev) => new Set([...prev, ...hidden]));
  };

  useEffect(() => {
    setOpen(null);
    setFilter('');
    setRevealHidden(false);
    setCollapsed(foldMemory(conn.id));
  }, [conn.id]);

  /// Write-through, so the next visit to this connection opens the way you
  /// left it.
  useEffect(() => {
    FOLDS.set(conn.id, collapsed);
  }, [conn.id, collapsed]);

  /// A many-schema connection opens folded.
  ///
  /// Twenty-six schemas expanded is nine hundred rows of scrollbar with the
  /// only structure in the list — the bands — scrolled off the top. Folded,
  /// the panel opens as a contents page you can read at a glance, which is
  /// what you actually came to the explorer for. The schema you are working
  /// in stays open, because it is the one place you were already looking.
  ///
  /// Only ever done ONCE per connection per run, and only before you have
  /// touched a band: seeding over a fold you chose yourself would be the
  /// panel arguing with you.
  useEffect(() => {
    if (!schema || SEEDED.has(conn.id)) return;
    const names = schema.schemas.map((sc) => sc.name).filter((n) => !hidden.has(n));
    SEEDED.add(conn.id);
    // Few enough to take in at once? Then folding them is just an extra
    // click between you and every table you own.
    if (names.length <= FOLD_BY_DEFAULT_ABOVE) return;
    setCollapsed(new Set(names.filter((n) => n !== activeSchema)));
  }, [conn.id, schema, activeSchema, hidden]);


  /// How many rows are rendered at once. There is no virtualization here, so
  /// this is a real ceiling rather than a preference — and with 905 tables
  /// the filter, not the scrollbar, is how you get to one.
  const MAX_ROWS = 400;

  const entries = useMemo(() => {
    const all = (schema?.schemas ?? [])
      // Hidden schemas are gone from browsing AND from filtering: a hidden
      // schema that reappears the moment you type is not hidden, it is
      // lurking. Revealing puts them all back, dimmed.
      .filter((sc) => revealHidden || !hidden.has(sc.name))
      .flatMap((sc) => sc.tables.map((table) => ({ schema: sc.name, table })));
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    // Matched against the qualified name, so `acme_dm.access` narrows to one
    // schema's copy — the only way to pick between three tables all called
    // access_log. Ranked so a name that STARTS with what you typed comes
    // first; on a substring match of 905 names, that is the difference
    // between finding it and scrolling.
    return all
      .map((t) => {
        const name = (t.table.name ?? '').toLowerCase();
        const qualified = `${t.schema}.${t.table.name}`.toLowerCase();
        if (name.startsWith(needle)) return { ...t, rank: 0 };
        if (name.includes(needle)) return { ...t, rank: 1 };
        if (qualified.includes(needle)) return { ...t, rank: 2 };
        return null;
      })
      .filter((t): t is (typeof all)[number] & { rank: number } => t !== null)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.table.name ?? '').length - (b.table.name ?? '').length ||
          (a.table.name ?? '').localeCompare(b.table.name ?? '') ||
          a.schema.localeCompare(b.schema),
      );
  }, [schema, filter, hidden, revealHidden]);

  /// Which schema a table is in only needs saying when there is more than
  /// one — on DynamoDB (one pseudo-schema, the region) it would be a column
  /// of the same word repeated down the panel.
  const visibleSchemas = (schema?.schemas ?? []).filter(
    (sc) => revealHidden || !hidden.has(sc.name),
  );
  const multiSchema = visibleSchemas.length > 1;
  const filtering = filter.trim().length > 0;

  /// Browsing is grouped by schema; filtering is not.
  ///
  /// They are different acts. Browsing 905 tables, the schema is the only
  /// structure there is, and repeating it on every row spends a third of the
  /// width saying the same word — a sticky header says it once. The moment
  /// you type, the schema stops being the structure and becomes the thing
  /// that tells two matches apart, so it moves onto the row.
  const groups = useMemo(() => {
    if (filtering || !multiSchema) {
      return [{ schema: null as string | null, rows: entries.slice(0, MAX_ROWS) }];
    }
    const by = new Map<string, typeof entries>();
    for (const e of entries) by.set(e.schema, [...(by.get(e.schema) ?? []), e]);
    return [...by.entries()]
      // The session's own schema first: it is what unqualified names resolve
      // to, and it is where you are working.
      .sort(([a], [b]) =>
        a === activeSchema ? -1 : b === activeSchema ? 1 : a.localeCompare(b),
      )
      .map(([name, rows]) => ({
        schema: name,
        // Defensive on the name: a catalog row that arrived without one is a
        // bug in the adapter (it was MySQL 8's upper-case information_schema
        // labels), but it must not take the whole panel down with it.
        rows: [...rows].sort((x, y) => (x.table.name ?? '').localeCompare(y.table.name ?? '')),
      }));
  }, [entries, filtering, multiSchema, activeSchema]);

  /// Folded schemas are still THERE — the count in the footer and the
  /// "nothing matches" test both mean the catalog, not what is on screen.
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  const toggleSchema = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  /// Every schema is folded only when there is one to unfold — the button
  /// says which of the two things it will do.
  const allCollapsed =
    groups.length > 0 && groups.every((g) => g.schema !== null && collapsed.has(g.schema));

  const preview = (schemaName: string, table: TableInfo) => {
    const sql = previewStatement(conn.engine, {
      schema: schemaName,
      table: table.name,
      activeSchema,
      // Deliberately not the tab's row cap: on DynamoDB that would make a
      // click cost a thousand item reads. previewStatement decides — a peek
      // there, a normal page on the SQL engines.
    });
    void run(conn.id, sql, conn.engine);
  };

  /// The counts the footer reports are what the panel is SHOWING you: a
  /// hidden schema's 400 tables in the total would make the number a lie
  /// about the list under it. What is hidden gets said separately.
  const total = visibleSchemas.reduce((n, sc) => n + sc.tables.length, 0);
  const hiddenCount = (schema?.schemas ?? []).filter((sc) => hidden.has(sc.name)).length;

  return (
    <div className="h-full flex flex-col bg-surface-muted border-r border-card min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-card">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a table"
          aria-label="Find a table"
          className="field flex-1 min-w-0 px-2 py-1 text-[11px]"
        />
        <button
          onClick={onClose}
          title="Hide the table list"
          aria-label="Hide the table list"
          className="text-ink-faint hover:text-ink text-xs px-1"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {schemaLoading && !schema ? (
          <p className="px-3 py-3 text-[11px] text-ink-faint">Reading the catalog…</p>
        ) : shown === 0 ? (
          <p className="px-3 py-3 text-[11px] text-ink-faint leading-relaxed">
            {total === 0
              ? hiddenCount > 0
                ? `Every schema on this connection is hidden (${hiddenCount}).`
                : 'No tables in the catalog yet.'
              : `Nothing matches “${filter}”. ${total} tables in all.`}
            {conn.tableFilter && (
              <>
                {' '}
                This connection only shows{' '}
                <span className="text-ink-muted">{conn.tableFilter}</span>.
              </>
            )}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.schema ?? '#all'}>
              {group.schema && (
                // A band rather than a caption. It is the only structure a
                // 905-table list has, and it has to survive being scrolled
                // past hundreds of rows that look alike — so it carries a
                // fill, a rule and the accent marker the sidebar uses for
                // the same job.
                <div
                  className={`sticky top-0 z-10 flex items-center bg-surface-elevated border-y border-card group/band hover:bg-card ${
                    group.schema === activeSchema ? 'shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : ''
                  } ${hidden.has(group.schema) ? 'opacity-50' : ''}`}
                >
                  <button
                    onClick={() => toggleSchema(group.schema!)}
                    aria-expanded={!collapsed.has(group.schema)}
                    title={
                      collapsed.has(group.schema)
                        ? `Unfold ${group.schema}`
                        : `Fold ${group.schema}`
                    }
                    className="flex-1 min-w-0 text-left pl-3 pr-2 py-1 flex items-center gap-2"
                  >
                    <span
                      className={`shrink-0 text-[9px] text-ink-faint transition-transform ${
                        collapsed.has(group.schema) ? '' : 'rotate-90'
                      }`}
                    >
                      ▶
                    </span>
                    <span className="text-[11px] font-medium text-ink truncate">{group.schema}</span>
                    {group.schema === activeSchema && (
                      <span className="text-[9px] uppercase tracking-[0.07em] text-accent">
                        active
                      </span>
                    )}
                    <span className="flex-1" />
                    <span className="text-[10px] text-ink-faint tabular-nums">
                      {group.rows.length}
                    </span>
                  </button>
                  {/* The word, not a glyph. An ✕ on a row that also folds
                      reads as "close" or "remove", and neither is what this
                      does — you cannot guess your way back from a symbol.
                      Hiding is the heavier of the two verbs, so it stays out
                      of the way until you are on the band; folding is the
                      one you do all day and it owns the whole row. */}
                  <button
                    onClick={() => toggleHiddenSchema(conn.id, group.schema!)}
                    title={
                      hidden.has(group.schema)
                        ? `Show ${group.schema} in this list again`
                        : `Hide ${group.schema} from this list. Bring it back from “hidden” at the bottom.`
                    }
                    className={`shrink-0 px-2 py-1 text-[10px] text-ink-faint hover:text-ink ${
                      hidden.has(group.schema)
                        ? 'text-accent'
                        : 'opacity-0 group-hover/band:opacity-100 focus-visible:opacity-100'
                    }`}
                  >
                    {hidden.has(group.schema) ? 'unhide' : 'hide'}
                  </button>
                </div>
              )}
              {group.schema && collapsed.has(group.schema) ? null : group.rows.map(({ schema: schemaName, table }) => {
                const key = `${schemaName}.${table.name}`;
                const isOpen = open === key;
                return (
                  <div key={key}>
                    <button
                      onClick={() => {
                        setOpen(isOpen ? null : key);
                        // Selecting a table shows you what is in it. That is
                        // the whole request, and making it a second click on
                        // a separate "preview" button would be ceremony.
                        if (!isOpen) preview(schemaName, table);
                      }}
                      disabled={running}
                      // No rule between rows: at this density a hairline under
                      // every one of 400 rows draws a wall of boxes and the
                      // names stop being the thing you see. Hover and the
                      // selected fill are enough to separate them.
                      className={`w-full text-left px-3 py-[3px] flex items-baseline gap-2 hover:bg-card disabled:opacity-60 ${
                        isOpen ? 'bg-card shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : ''
                      }`}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block text-[11px] text-ink truncate">
                          <Match text={table.name} needle={filter.trim()} />
                        </span>
                        {conn.engine === 'dynamodb' && <KeyLine table={table} open={isOpen} />}
                      </span>
                      {/* Right rail: whichever of these actually tells this
                          row apart from its neighbours. */}
                      {filtering && multiSchema ? (
                        <span
                          className={`shrink-0 text-[10px] ${
                            schemaName === activeSchema ? 'text-ink-muted' : 'text-ink-faint'
                          }`}
                        >
                          {schemaName}
                        </span>
                      ) : conn.engine === 'dynamodb' && table.indexes.length > 0 ? (
                        <span className="shrink-0 text-[9px] text-ink-faint">
                          {table.indexes.length} index{table.indexes.length === 1 ? '' : 'es'}
                        </span>
                      ) : isOpen && table.columns.length ? (
                        <span className="shrink-0 text-[10px] text-ink-faint">
                          {table.columns.length} cols
                        </span>
                      ) : null}
                    </button>
                    {isOpen && (
                      <div className="bg-card px-3 pt-1 pb-2.5">
                        {conn.engine === 'dynamodb' ? (
                          <KeyFinder
                            table={table}
                            onRun={(sql) => void run(conn.id, sql, conn.engine)}
                            onInsert={onInsert}
                            running={running}
                          />
                        ) : (
                          <ColumnList table={table} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {shown >= MAX_ROWS && (
          <p className="px-3 py-2 text-[10px] text-ink-faint leading-relaxed">
            First {MAX_ROWS} shown. Keep typing to narrow — <span className="font-mono">schema.name</span> works too.
          </p>
        )}
      </div>

      {/* Two footers, because revealing is a MODE and a mode with the
          normal controls still in it is just a crowded row — four verbs
          wrapped onto two lines was the panel refusing to say what state it
          was in. While you are looking at what is hidden, the only things
          on offer are the two ways out of it. */}
      {revealHidden ? (
        <div className="shrink-0 border-t border-accent/40 bg-accent/[0.07] px-3 py-1.5 flex items-center gap-3">
          <span className="text-[10px] text-accent truncate">
            {hiddenCount} hidden schema{hiddenCount === 1 ? '' : 's'} — unhide on the band
          </span>
          <div className="flex-1" />
          <button
            onClick={() => {
              showAllSchemas(conn.id);
              setReveal(false);
            }}
            title="Bring every hidden schema back"
            className="shrink-0 whitespace-nowrap text-[10px] text-ink-faint hover:text-ink"
          >
            Unhide all
          </button>
          <button
            onClick={() => setReveal(false)}
            title="Put the hidden schemas away again"
            className="shrink-0 whitespace-nowrap text-[10px] text-accent hover:text-ink"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="shrink-0 border-t border-card px-3 py-1.5 flex items-center gap-3">
          <span className="text-[10px] text-ink-faint truncate">
            {filtering
              ? `${shown} of ${total}`
              : `${total} tables${multiSchema ? ` · ${visibleSchemas.length} schemas` : ''}`}
          </span>
          <div className="flex-1" />
          {/* Hidden schemas say so. Something you cannot see and cannot be
              told about is not hidden, it is lost — and this count is the
              way back to the one you hid by mistake. */}
          {hiddenCount > 0 && (
            <button
              onClick={() => setReveal(true)}
              title={`Show the ${hiddenCount} hidden schema${hiddenCount === 1 ? '' : 's'} so you can bring one back`}
              className="shrink-0 whitespace-nowrap text-[10px] text-ink-faint hover:text-ink"
            >
              {hiddenCount} hidden
            </button>
          )}
          {/* Nineteen schemas is nineteen clicks to get to the one you want,
              which is not folding, it is a chore. */}
          {multiSchema && !filtering && (
            <button
              onClick={() => {
                // Folding every schema and leaving one table's columns open
                // below them is not "collapsed", it is a leftover.
                if (!allCollapsed) setOpen(null);
                setCollapsed(
                  allCollapsed
                    ? new Set()
                    : new Set(groups.map((g) => g.schema).filter((n): n is string => n !== null)),
                );
              }}
              className="shrink-0 whitespace-nowrap text-[10px] text-ink-faint hover:text-ink"
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          <button
            onClick={() => void loadSchema(conn.id, { force: true })}
            className="shrink-0 whitespace-nowrap text-[10px] text-ink-faint hover:text-ink"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}

/// The one line under a table name that earns its space — on DynamoDB only,
/// where the key schema decides what you can ask. On a SQL engine the column
/// count said nothing you needed while browsing, and cost every row a second
/// line: 905 tables at two lines each is a scrollbar and not much else.
function KeyLine({ table, open }: { table: TableInfo; open: boolean }): JSX.Element {
  if (!table.primaryKey.length) {
    return <span className="block text-[10px] text-ink-faint italic">not described yet</span>;
  }
  return (
    <span
      className={`block font-mono text-[10px] truncate ${open ? 'text-ink-muted' : 'text-ink-faint'}`}
    >
      {table.primaryKey.join(' · ')}
    </span>
  );
}

/// What you typed, marked in what you found. Without it a substring match in
/// the middle of `z123_user_mdf_access_setting` is invisible.
function Match({ text, needle }: { text: string; needle: string }): JSX.Element {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="bg-accent/20 text-ink rounded-[2px]">{text.slice(at, at + needle.length)}</span>
      {text.slice(at + needle.length)}
    </>
  );
}

function ColumnList({ table }: { table: TableInfo }): JSX.Element {
  if (!table.columns.length) {
    return <p className="text-[10px] text-ink-faint">Columns load when you open this schema.</p>;
  }
  const pk = new Set(table.primaryKey);
  return (
    <div className="flex flex-col gap-0.5">
      {table.columns.map((c) => (
        <div key={c.name} className="flex items-baseline gap-1.5 text-[10px]">
          <span className={pk.has(c.name) ? 'text-accent' : 'text-ink-muted'}>{c.name}</span>
          <span className="text-ink-faint truncate">{c.typeName}</span>
        </div>
      ))}
    </div>
  );
}

/// The operators DynamoDB accepts on a sort key, in the words of the question
/// being asked rather than the syntax it compiles to.
const OPS: Array<{ value: SortOp; label: string }> = [
  { value: '=', label: 'is' },
  { value: 'begins_with', label: 'starts' },
  { value: '>=', label: 'from' },
  { value: '>', label: 'after' },
  { value: '<=', label: 'to' },
  { value: '<', label: 'before' },
];

const SECTION = 'text-[9px] uppercase tracking-[0.07em] text-ink-faint';

/// The query builder. Every control maps to something DynamoDB charges for,
/// and the verdict line says which of the two prices you are about to pay.
function KeyFinder({
  table,
  onRun,
  onInsert,
  running,
}: {
  table: TableInfo;
  onRun(sql: string): void;
  onInsert(sql: string): void;
  running: boolean;
}): JSX.Element {
  const shape = useMemo(() => shapeFromTableInfo(table), [table]);
  // The first row is prefilled with the table's own partition key: it is the
  // attribute most likely to be wanted, and an empty first row would leave
  // the panel looking like a form with nothing to say.
  const blank = (): Condition[] => [
    { attribute: shape?.keys.partitionKey ?? '', op: '=', value: '' },
  ];
  const [conditions, setConditions] = useState<Condition[]>(blank);
  const [newestFirst, setNewestFirst] = useState(false);
  /// undefined = let the resolver choose. Anything else is the user saying
  /// otherwise, `null` meaning the table itself.
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const [showPaths, setShowPaths] = useState(false);

  useEffect(() => {
    setConditions(blank());
    setNewestFirst(false);
    setOverride(undefined);
    setShowPaths(false);
    // Rebuilt per table: a condition on the last table's keys means nothing
    // against this one's.
  }, [table.name]);

  if (!shape) {
    return (
      <p className="text-[10px] text-ink-faint leading-relaxed">
        This table was listed but not described, so its keys are unknown here. Pin it in the
        table picker and refresh to load them.
      </p>
    );
  }

  const attributes = keyAttributes(shape);
  const { sql, resolution } = buildQuery(shape, { conditions, newestFirst, index: override });
  const scan = resolution.path === 'scan';
  const sortable = Boolean(resolution.partition && resolution.keys.sortKey);
  const listId = `dyn-attrs-${table.name}`;

  const patch = (i: number, next: Partial<Condition>) =>
    setConditions((prev) => prev.map((c, j) => (j === i ? { ...c, ...next } : c)));

  const scale = [
    shape.itemCount ? `${shape.itemCount.toLocaleString()} items` : null,
    shape.sizeBytes ? humanSize(shape.sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2">
        <span className={SECTION}>Find items where</span>

        <datalist id={listId}>
          {attributes.map((a) => (
            <option key={a.name} value={a.name}>{a.role}</option>
          ))}
        </datalist>

        {conditions.map((c, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex gap-1">
              <input
                list={listId}
                value={c.attribute}
                onChange={(e) => patch(i, { attribute: e.target.value })}
                placeholder="attribute"
                aria-label="Attribute"
                className="field flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono"
              />
              <select
                value={c.op}
                onChange={(e) => patch(i, { op: e.target.value as SortOp })}
                aria-label="Operator"
                className="field shrink-0 w-[62px] px-1 py-1 text-[10px]"
              >
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1">
              <input
                value={c.value}
                onChange={(e) => patch(i, { value: e.target.value })}
                placeholder="value"
                aria-label="Value"
                className="field flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono"
              />
              {conditions.length > 1 && (
                <button
                  onClick={() => setConditions((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove this condition"
                  aria-label="Remove this condition"
                  className="shrink-0 px-1.5 text-[10px] text-ink-faint hover:text-ink"
                >
                  ✕
                </button>
              )}
            </div>
            {(c.op === '>=' || c.op === '>') && (
              <input
                value={c.upper ?? ''}
                onChange={(e) => patch(i, { upper: e.target.value })}
                placeholder="up to — optional, makes it a range"
                aria-label="Upper bound"
                className="field px-1.5 py-1 text-[10px] font-mono"
              />
            )}
          </div>
        ))}

        <div className="flex items-center gap-3">
          <button
            onClick={() =>
              setConditions((prev) => [
                ...prev,
                // The sort key of whatever path is in play is almost always
                // the second thing you want to say.
                {
                  attribute: prev.some((c) => c.attribute === resolution.keys.sortKey)
                    ? ''
                    : (resolution.keys.sortKey ?? ''),
                  op: '=',
                  value: '',
                },
              ])
            }
            className="text-[10px] text-accent hover:text-accent-strong"
          >
            + condition
          </button>
          <label
            className={`flex items-center gap-1.5 ${sortable ? '' : 'opacity-50'}`}
            title={
              sortable
                ? `Reverses the order of ${resolution.keys.sortKey}`
                : 'DynamoDB can only reverse the sort key of a key lookup'
            }
          >
            <input
              type="checkbox"
              checked={newestFirst}
              disabled={!sortable}
              onChange={(e) => setNewestFirst(e.target.checked)}
            />
            <span className="text-[10px] text-ink-muted">newest first</span>
          </label>
        </div>
      </div>

      {/* The verdict. One line for what it costs, one for why — and the
          override behind `change`, so the resolver's choice is a default
          rather than a decision taken away. */}
      <div
        className={`rounded border px-2 py-1.5 flex flex-col gap-1 ${
          scan
            ? 'bg-warn/10 border-warn/25'
            : 'bg-good/10 border-good/25'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] flex-1 ${scan ? 'text-warn/90' : 'text-good/90'}`}
          >
            {scan
              ? `Full scan${scale ? ` — ${scale}` : ''}`
              : `Key lookup${resolution.sort ? ', narrowed by sort key' : ''}`}
          </span>
          <button
            onClick={() => setShowPaths((v) => !v)}
            className="text-[10px] text-ink-faint hover:text-ink"
          >
            {showPaths ? 'done' : 'change'}
          </button>
        </div>
        <p className="text-[10px] text-ink-muted leading-snug">{resolution.why}</p>
        {scan && (
          <p className="text-[10px] text-ink-faint leading-snug">
            You are charged for items read, not returned. The row cap stops the read early; it
            does not make it free.
          </p>
        )}

        {showPaths && (
          <div className="flex flex-col gap-1 pt-1">
            <span className={SECTION}>Read from</span>
            {resolution.paths.map((p) => {
              const chosen = p.index === resolution.index;
              return (
                <button
                  key={p.index ?? '#table'}
                  onClick={() => setOverride(p.index)}
                  className={`text-left rounded border px-1.5 py-1 ${
                    chosen ? 'border-accent bg-accent/10' : 'border-card hover:bg-card'
                  }`}
                >
                  <span className="block text-[10px] text-ink">
                    {p.index ?? 'the table'}
                    {p.index && <span className="text-ink-faint"> index</span>}
                    {chosen && override === undefined && (
                      <span className="text-ink-faint"> · chosen for you</span>
                    )}
                  </span>
                  <span className="block font-mono text-[10px] text-ink-faint truncate">
                    {p.keys.partitionKey}
                    {p.keys.sortKey ? ` / ${p.keys.sortKey}` : ''}
                  </span>
                </button>
              );
            })}
            {override !== undefined && (
              <button
                onClick={() => setOverride(undefined)}
                className="self-start text-[10px] text-accent hover:text-accent-strong"
              >
                Let overdb choose again
              </button>
            )}
          </div>
        )}
      </div>

      <pre className="text-[10px] leading-snug font-mono text-ink-muted bg-surface rounded border border-card px-2 py-1.5 whitespace-pre-wrap break-words">
        {sql}
      </pre>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onRun(sql)}
          disabled={running}
          className="text-[10px] px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          Run
        </button>
        <button
          onClick={() => onInsert(sql)}
          className="text-[10px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink"
        >
          Insert
        </button>
        <div className="flex-1" />
        <button
          onClick={() => {
            setConditions(blank());
            setNewestFirst(false);
            setOverride(undefined);
          }}
          className="text-[10px] text-ink-faint hover:text-ink"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
