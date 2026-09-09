import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Cell, ColumnMeta } from '@shared/types';
import { formatRows, insertTarget, nullBehaviour, type ExportFormat } from '@shared/exportRows';
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
}: {
  columns: ColumnMeta[];
  rows: Cell[][];
  sort?: { column: string; direction: 'asc' | 'desc' } | null;
  sortable?: boolean;
  onSort?(column: string): void;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
    const s = sel ? norm(sel) : { top: 0, bottom: rows.length - 1, left: 0, right: columns.length - 1 };
    const cols = columns.slice(s.left, s.right + 1);
    const body = rows.slice(s.top, s.bottom + 1).map((r) => r.slice(s.left, s.right + 1));
    const text = formatRows(cols, body, format, { headers, nullAs });
    await window.overdb.invoke('app:copyText', text);
    setMenu(null);
    const n = body.length;
    toast(`Copied ${n.toLocaleString()} row${n === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
  };

  useEffect(() => {
    setSel(null);
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
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

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

  return (
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
              className={`absolute top-0 flex items-center gap-1.5 px-2.5 overflow-hidden whitespace-nowrap border-r grid-rule ${
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
                  className={`absolute top-0 px-2.5 text-[11px] leading-[26px] overflow-hidden whitespace-nowrap border-r grid-rule ${
                    isNumericKind(col.kind) ? 'text-right' : ''
                  } ${picked ? 'bg-accent/30 text-ink' : ''}`}
                  style={{ left: vc.start, width: vc.size, height: vr.size }}
                >
                  <CellView value={rows[vr.index][vc.index]} column={col} />
                </div>
              );
            })}
            </div>
          </div>
        ))}
      </div>

      {menu && (
        <CopyMenu
          at={menu}
          selection={selected}
          selectedColumns={selected ? columns.slice(selected.left, selected.right + 1) : columns}
          onCopy={copy}
        />
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
