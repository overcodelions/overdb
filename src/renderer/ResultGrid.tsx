import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Cell, ColumnMeta } from '@shared/types';
import { formatRows, insertTarget, nullBehaviour, type ExportFormat } from '@shared/exportRows';
import { needsValue, type FilterOp, type GridFilter } from '@shared/gridView';
import { CellView, isNumericKind } from './Cell';
import { useStore } from './store';

// 26 rather than 24: a row of dense monospace ids needs a little air to
// stay scannable, and the cost is two rows per screen.
const ROW_H = 26;
// The gutter is what makes "select a row" a gesture rather than a drag
// across every column.
const GUTTER = 54;

interface Selection {
  r1: number; c1: number; r2: number; c2: number;
}

const norm = (s: Selection) => ({
  top: Math.min(s.r1, s.r2), bottom: Math.max(s.r1, s.r2),
  left: Math.min(s.c1, s.c2), right: Math.max(s.c1, s.c2),
});

/// Built rather than taken off the shelf: sorting and filtering here are
/// server-side re-queries, which removes most of what a grid library gives
/// you. What's left is two-axis virtualization — a `select *` on a
/// 120-column table needs column virtualization too — and that is two
/// useVirtualizer calls.
export function ResultGrid({
  columns,
  rows,
  sort,
  sortable,
  onSort,
  filters,
  onFilter,
  canEdit,
  onEditCell,
}: {
  columns: ColumnMeta[];
  rows: Cell[][];
  sort?: { column: string; direction: 'asc' | 'desc' } | null;
  sortable?: boolean;
  onSort?(column: string): void;
  /// Applied by re-asking the server, never by hiding rows — see
  /// src/shared/gridView.ts for why that distinction is the whole point.
  filters?: GridFilter[];
  onFilter?(filter: GridFilter | null, column: string): void;
  /// Whether this column's cells can be written back, and why not when they
  /// cannot. Answered by the caller, which has the catalog — see
  /// src/shared/rowEdit.ts.
  canEdit?(columnIndex: number): { ok: boolean; reason?: string };
  /// A committed edit. The grid does not apply it optimistically: the row is
  /// re-read, because a trigger or default may store something else.
  onEditCell?(rowIndex: number, columnIndex: number, value: string | null): void;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [filterAt, setFilterAt] = useState<{ column: string; x: number; y: number } | null>(null);
  /// The cell being edited, if any. One at a time, by construction.
  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null);
  // A ref, not state: this changes on every mousedown/up and re-rendering a
  // virtualized grid for it would make the drag stutter.
  const dragging = useRef(false);
  const toast = useStore((s) => s.toast);

  const widths = useMemo(() => {
    const sample = rows.slice(0, 50);
    return columns.map((col, i) => {
      let longest = col.name.length + col.typeName.length + 3;
      for (const row of sample) {
        const v = row[i];
        const len = v === null ? 4 : String(typeof v === 'object' ? 'binary' : v).length;
        if (len > longest) longest = len;
      }
      return Math.min(420, Math.max(90, longest * 7.4 + 24));
    });
  }, [columns, rows]);

  const rowVirt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const colVirt = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => widths[i],
    overscan: 4,
  });
  const totalWidth = GUTTER + colVirt.getTotalSize();

  const copy = async (format: ExportFormat, headers: boolean, nullAs?: string) => {
    try {
      const s = sel ? norm(sel) : { top: 0, bottom: rows.length - 1, left: 0, right: columns.length - 1 };
      const cols = columns.slice(s.left, s.right + 1);
      const body = rows.slice(s.top, s.bottom + 1).map((r) => r.slice(s.left, s.right + 1));
      const text = formatRows(cols, body, format, { headers, nullAs });
      await window.overdb.invoke('app:copyText', text);
      setMenu(null);
      const n = body.length;
      toast(`Copied ${n.toLocaleString()} row${n === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
    } catch (err) {
      setMenu(null);
      toast(`Could not copy: ${String(err)}`);
    }
  };

  useEffect(() => {
    setSel(null);
    // A cell being edited belongs to rows that no longer exist once the
    // statement has been re-run — leaving the input open would put it on
    // whatever row happens to be at that index now.
    setEditing(null);
  }, [columns, rows.length]);

  // The drag ends wherever the mouse is released, including outside the
  // grid — otherwise letting go over the sidebar leaves it stuck selecting.
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  // Dismiss the menu on any outside click.
  useEffect(() => {
    if (!menu && !filterAt) return;
    const close = () => {
      setMenu(null);
      setFilterAt(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, [menu, filterAt]);

  if (columns.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        No result columns — the statement returned nothing to show.
      </div>
    );
  }

  const selected = sel ? norm(sel) : null;
  const inSel = (r: number, c: number) =>
    !!selected && r >= selected.top && r <= selected.bottom && c >= selected.left && c <= selected.right;
  const rowPicked = (r: number) => !!selected && r >= selected.top && r <= selected.bottom;

  const active = (filters ?? []).length;

  return (
    <div className="h-full relative">
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={(e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          void copy('tsv', false);
        } else if (mod && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setSel({ r1: 0, c1: 0, r2: rows.length - 1, c2: columns.length - 1 });
        }
      }}
      className="h-full overflow-auto relative outline-none select-none"
    >
      <div
        className="sticky top-0 z-10 flex bg-surface-muted border-b border-card"
        style={{ width: totalWidth, height: ROW_H + 4 }}
      >
        <div
          onClick={() => setSel({ r1: 0, c1: 0, r2: rows.length - 1, c2: columns.length - 1 })}
          title="Select every row"
          className="sticky left-0 z-20 shrink-0 bg-surface-muted border-r grid-rule cursor-default"
          style={{ width: GUTTER, height: ROW_H + 4 }}
        />
        <div className="relative shrink-0" style={{ width: colVirt.getTotalSize(), height: ROW_H + 4 }}>
        {colVirt.getVirtualItems().map((vc) => {
          const col = columns[vc.index];
          const sorted = sort?.column === col.name ? sort.direction : null;
          return (
            <div
              key={vc.key}
              onClick={() => (sortable && onSort ? onSort(col.name) : undefined)}
              // A right-aligned numeric column needs a right-aligned label,
              // or the header floats over the wrong part of its own column.
              className={`group/head absolute top-0 flex items-center gap-1.5 px-2.5 overflow-hidden whitespace-nowrap border-r grid-rule ${
                isNumericKind(col.kind) ? 'justify-end' : ''
              } ${sortable ? 'cursor-pointer hover:bg-card' : 'cursor-default'}`}
              style={{ left: vc.start, width: vc.size, height: ROW_H + 4 }}
              title={
                `${col.name} · ${col.typeName}` +
                (col.sourceTable ? '' : ' · not editable (no source table)') +
                (sortable ? ' · click to sort' : '')
              }
            >
              <span className={`text-[11px] font-medium truncate ${sorted ? 'text-accent' : 'text-ink'}`}>
                {col.name}
              </span>
              <span className="text-[10px] text-ink-faint truncate">{col.typeName}</span>
              {sorted && (
                <span className="text-[9px] text-accent shrink-0">{sorted === 'asc' ? '▲' : '▼'}</span>
              )}
              {onFilter && (
                <button
                  onClick={(e) => {
                    // Not a sort: the header's own click is already spoken
                    // for, and a filter that sorted as a side effect would
                    // re-run twice for one gesture.
                    e.stopPropagation();
                    const box = (e.target as HTMLElement).getBoundingClientRect();
                    setFilterAt({ column: col.name, x: box.left, y: box.bottom + 4 });
                  }}
                  title={`Filter on ${col.name}`}
                  aria-label={`Filter on ${col.name}`}
                  className={`ml-auto shrink-0 leading-none px-0.5 ${
                    filterOf(filters, col.name)
                      ? 'text-accent'
                      : 'text-ink-faint/0 group-hover/head:text-ink-faint hover:!text-ink'
                  }`}
                >
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1.5 2h9l-3.4 4v3.6L4.9 10.5V6L1.5 2z" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        </div>
      </div>

      <div style={{ height: rowVirt.getTotalSize(), width: totalWidth, position: 'relative' }}>
        {rowVirt.getVirtualItems().map((vr) => (
          <div
            key={vr.key}
            className={`absolute left-0 flex border-b grid-rule ${
              vr.index % 2 === 1 && !rowPicked(vr.index) ? 'grid-row-alt' : ''
            } ${rowPicked(vr.index) ? 'bg-accent/20' : ''}`}
            style={{ top: vr.start, height: vr.size, width: totalWidth }}
          >
            <div
              onMouseDown={(e) => {
                // Right-click must not collapse a multi-row selection — that
                // is exactly the selection you were about to copy.
                if (e.button === 2) return;
                if (e.shiftKey && sel) setSel({ ...sel, r2: vr.index, c2: columns.length - 1 });
                else setSel({ r1: vr.index, c1: 0, r2: vr.index, c2: columns.length - 1 });
                dragging.current = true;
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!rowPicked(vr.index)) {
                  setSel({ r1: vr.index, c1: 0, r2: vr.index, c2: columns.length - 1 });
                }
                setMenu({ x: e.clientX, y: e.clientY });
              }}
              onMouseEnter={() => {
                if (dragging.current) {
                  setSel((prev) =>
                    prev ? { ...prev, r2: vr.index, c2: columns.length - 1 } : prev,
                  );
                }
              }}
              title="Select this row — drag or shift-click to extend"
              className={`sticky left-0 z-[2] shrink-0 text-right pr-2 text-[10px] leading-[26px] tabular-nums border-r grid-rule cursor-default ${
                rowPicked(vr.index)
                  ? 'bg-accent/60 text-white font-medium shadow-[inset_3px_0_0_rgb(var(--c-accent))]'
                  : 'bg-surface text-ink-faint'
              }`}
              style={{ width: GUTTER, height: ROW_H }}
            >
              {vr.index + 1}
            </div>
            <div className="relative shrink-0" style={{ width: colVirt.getTotalSize(), height: vr.size }}>
            {colVirt.getVirtualItems().map((vc) => {
              const col = columns[vc.index];
              const picked = inSel(vr.index, vc.index);
              return (
                <div
                  key={vc.key}
                  onMouseDown={(e) => {
                    if (e.button === 2) return; // right-click keeps the selection
                    if (e.shiftKey && sel) setSel({ ...sel, r2: vr.index, c2: vc.index });
                    else setSel({ r1: vr.index, c1: vc.index, r2: vr.index, c2: vc.index });
                    dragging.current = true;
                  }}
                  onMouseEnter={() => {
                    if (dragging.current) {
                      setSel((prev) => (prev ? { ...prev, r2: vr.index, c2: vc.index } : prev));
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!inSel(vr.index, vc.index)) {
                      setSel({ r1: vr.index, c1: vc.index, r2: vr.index, c2: vc.index });
                    }
                    setMenu({ x: e.clientX, y: e.clientY });
                  }}
                  onDoubleClick={() => {
                    if (!onEditCell || !canEdit) return;
                    const check = canEdit(vc.index);
                    if (!check.ok) {
                      // Never silently inert: "why can't I type here" is the
                      // whole question, and the reason answers it.
                      toast(check.reason ?? 'This cell is not editable.', 'error');
                      return;
                    }
                    const value = rows[vr.index][vc.index];
                    setEditing({
                      r: vr.index,
                      c: vc.index,
                      draft:
                        value === null || typeof value === 'object' ? '' : String(value),
                    });
                  }}
                  title={onEditCell ? 'Double-click to edit' : undefined}
                  className={`absolute top-0 px-2.5 text-[11px] leading-[26px] overflow-hidden whitespace-nowrap border-r grid-rule ${
                    isNumericKind(col.kind) ? 'text-right' : ''
                  } ${picked ? 'bg-accent/30 text-ink' : ''}`}
                  style={{ left: vc.start, width: vc.size, height: vr.size }}
                >
                  {editing && editing.r === vr.index && editing.c === vc.index ? (
                    <input
                      autoFocus
                      value={editing.draft}
                      onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                      onMouseDown={(e) => e.stopPropagation()}
                      onBlur={() => setEditing(null)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') setEditing(null);
                        if (e.key !== 'Enter') return;
                        const before = rows[vr.index][vc.index];
                        const draft = editing.draft;
                        setEditing(null);
                        // An unchanged cell writes nothing. An UPDATE that
                        // sets a column to what it already holds still fires
                        // triggers and still shows up in a binlog.
                        if (String(before ?? '') === draft) return;
                        // An emptied cell means NULL where the column allows
                        // it — the confirmation shows which was chosen.
                        onEditCell?.(
                          vr.index,
                          vc.index,
                          draft === '' && col.nullable !== false ? null : draft,
                        );
                      }}
                      aria-label={`Edit ${col.name}`}
                      className={`w-full bg-surface-elevated text-ink text-[11px] leading-[24px] px-1 -mx-1 outline-none border border-accent rounded-[2px] font-mono ${
                        isNumericKind(col.kind) ? 'text-right' : ''
                      }`}
                    />
                  ) : (
                    <CellView value={rows[vr.index][vc.index]} column={col} />
                  )}
                </div>
              );
            })}
            </div>
          </div>
        ))}
      </div>

      {filterAt && onFilter && (
        <FilterMenu
          at={filterAt}
          column={filterAt.column}
          current={filterOf(filters, filterAt.column)}
          onApply={(f) => {
            onFilter(f, filterAt.column);
            setFilterAt(null);
          }}
          onClose={() => setFilterAt(null)}
        />
      )}

      {menu && (
        <CopyMenu
          at={menu}
          selection={selected}
          selectedColumns={selected ? columns.slice(selected.left, selected.right + 1) : columns}
          onCopy={copy}
        />
      )}
    </div>

      {/* Column headers with nothing under them read as a grid that has not
          finished loading. It has: the statement ran and matched nothing, and
          saying so is the difference between "no results" and "no answer yet".
          It sits outside the scroller so it stays put when the header row is
          scrolled sideways. */}
      {rows.length === 0 && (
        <div
          className="absolute inset-x-0 bottom-0 flex flex-col items-center justify-center gap-1 px-8 text-center pointer-events-none"
          style={{ top: ROW_H + 4 }}
        >
          <div className="text-xs text-ink-muted">No rows.</div>
          <div className="text-[11px] text-ink-faint">
            {active > 0
              ? `The statement ran — nothing matched, with ${active} column filter${
                  active === 1 ? '' : 's'
                } applied. Clear ${active === 1 ? 'it' : 'them'} to see whether the query itself is empty.`
              : 'The statement ran and returned an empty result — nothing matched.'}
          </div>
        </div>
      )}
    </div>
  );
}

function CopyMenu({
  at,
  selection,
  selectedColumns,
  onCopy,
}: {
  at: { x: number; y: number };
  selection: { top: number; bottom: number; left: number; right: number } | null;
  selectedColumns: ColumnMeta[] | null;
  onCopy(format: ExportFormat, headers: boolean, nullAs?: string): void;
}): JSX.Element {
  const count = selection ? selection.bottom - selection.top + 1 : 0;
  const cols = selection ? selection.right - selection.left + 1 : 0;
  // INSERT is only meaningful for a single-table selection; say why rather
  // than offering something that would generate nonsense.
  const insertable = selectedColumns ? insertTarget(selectedColumns) : { ok: false as const, reason: '' };
  const formats: Array<{ f: ExportFormat; label: string }> = [
    { f: 'tsv', label: 'Copy as TSV' },
    { f: 'csv', label: 'Copy as CSV' },
    { f: 'json', label: 'Copy as JSON' },
    { f: 'insert', label: 'Copy as INSERT' },
    { f: 'markdown', label: 'Copy as Markdown' },
  ];
  return (
    <div
      className="fixed z-50 min-w-[220px] rounded-md border border-card bg-surface-elevated shadow-2xl py-1"
      style={{ left: at.x, top: at.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-ink-faint">
        {count.toLocaleString()} row{count === 1 ? '' : 's'} × {cols} column{cols === 1 ? '' : 's'}
      </div>
      {formats.map(({ f, label }) => {
        const blocked = f === 'insert' && !insertable.ok;
        return (
          <button
            key={f}
            onClick={() => !blocked && onCopy(f, true)}
            disabled={blocked}
            title={blocked ? insertable.reason : nullBehaviour(f)}
            className={`w-full text-left px-3 py-1 text-xs ${
              blocked ? 'text-ink-faint cursor-default' : 'text-ink hover:bg-card'
            }`}
          >
            {label}
            {blocked && <span className="ml-1.5 text-[10px]">— not a single table</span>}
          </button>
        );
      })}
      <div className="my-1 border-t border-card" />
      <button
        onClick={() => onCopy('tsv', false)}
        className="w-full text-left px-3 py-1 text-xs text-ink hover:bg-card"
      >
        Copy without headers
      </button>
      <button
        onClick={() => onCopy('csv', true, 'NULL')}
        title="Keeps NULL distinguishable from an empty string."
        className="w-full text-left px-3 py-1 text-xs text-ink hover:bg-card"
      >
        Copy as CSV, NULL explicit
      </button>
    </div>
  );
}

function filterOf(filters: GridFilter[] | undefined, column: string): GridFilter | null {
  return filters?.find((f) => f.column === column) ?? null;
}

const FILTER_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'starts', label: 'starts with' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'at least' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'at most' },
  { value: 'is null', label: 'is null' },
  { value: 'is not null', label: 'is not null' },
];

/// One column's filter.
///
/// It re-runs the statement, so it commits on Enter or Apply rather than on
/// every keystroke — a filter that fired per character would send a query
/// per character, and on a 12M-row table that is a real bill.
function FilterMenu({
  at,
  column,
  current,
  onApply,
  onClose,
}: {
  at: { x: number; y: number };
  column: string;
  current: GridFilter | null;
  onApply(filter: GridFilter | null): void;
  onClose(): void;
}): JSX.Element {
  const [op, setOp] = useState<FilterOp>(current?.op ?? '=');
  const [value, setValue] = useState(current?.value ?? '');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const commit = () => onApply({ column, op, value: needsValue(op) ? value : undefined });

  return (
    <div
      className="fixed z-50 w-[236px] rounded-md border border-card bg-surface-elevated shadow-2xl p-2 flex flex-col gap-1.5"
      style={{ left: at.x, top: at.y }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="text-[10px] text-ink-faint truncate font-mono">{column}</div>
      <select
        value={op}
        onChange={(e) => setOp(e.target.value as FilterOp)}
        aria-label="Filter operator"
        className="field px-1.5 py-1 text-[11px]"
      >
        {FILTER_OPS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {needsValue(op) && (
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          aria-label="Filter value"
          className="field px-1.5 py-1 text-[11px] font-mono"
        />
      )}
      <div className="flex items-center gap-1.5">
        <button
          onClick={commit}
          className="text-[11px] px-2 py-1 rounded bg-accent text-white hover:bg-accent-strong"
        >
          Apply
        </button>
        {current && (
          <button
            onClick={() => onApply(null)}
            className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink"
          >
            Clear
          </button>
        )}
        <div className="flex-1" />
        {/* Said once, here, because "why did my row count change" is the
            question this answers. */}
        <span className="text-[9px] text-ink-faint">re-runs the query</span>
      </div>
    </div>
  );
}
