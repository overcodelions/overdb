import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SchemaSnapshot } from '@shared/types';
import {
  buildGraph,
  edgePath,
  filterGraph,
  layoutGraph,
  type Box,
  type ErGraph,
  type ErNode,
} from '@shared/erGraph';
import { useStore } from './store';

/// The foreign-key graph, drawn.
///
/// The point of this view is not decoration: it is the fastest way to learn
/// a schema you did not write. Which is also why it opens FOCUSED rather
/// than showing everything — a 900-table diagram is a hairball and teaches
/// nothing, so the default is one table and what touches it, and widening
/// is a deliberate act.
///
/// Every edge here comes from a constraint the server holds. A column named
/// `user_id` with no foreign key behind it is not drawn, because a guess
/// rendered in the same ink as a fact is indistinguishable from one.

const NODE_MIN_W = 190;
const NODE_MAX_W = 320;
const HEADER_H = 26;
const ROW_H = 15;
/// Past this a node is a wall of text at any zoom the whole diagram fits in.
const MAX_ROWS = 14;

type Detail = 'none' | 'keys' | 'all';

export function ErdView({
  snapshot,
  connectionName,
  onPickTable,
}: {
  snapshot: SchemaSnapshot | undefined;
  connectionName: string;
  /// Jump the editor at a table. The diagram is for reading; acting on what
  /// you found belongs back in the query pane.
  onPickTable?(schema: string, table: string): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const [detail, setDetail] = useState<Detail>('keys');
  const [schemaFilter, setSchemaFilter] = useState<string>('');

  const full = useMemo(
    () => (snapshot ? buildGraph(snapshot, schemaFilter ? [schemaFilter] : undefined) : null),
    [snapshot, schemaFilter],
  );

  const graph = useMemo(() => {
    if (!full) return null;
    return filterGraph(full, {
      query,
      focus: focus ?? undefined,
      depth,
    });
  }, [full, query, focus, depth]);

  const sizes = useMemo(() => {
    if (!graph) return {};
    return Object.fromEntries(graph.nodes.map((n) => [n.id, nodeSize(n, detail)]));
  }, [graph, detail]);

  const layout = useMemo(
    () => (graph ? layoutGraph(graph, sizes) : null),
    [graph, sizes],
  );

  if (!snapshot) {
    return (
      <Empty>
        The schema has not been read yet. Connect, and the diagram is built from the foreign keys
        the server reports.
      </Empty>
    );
  }
  if (!full || full.nodes.length === 0) {
    return <Empty>No tables in this schema.</Empty>;
  }

  // Tables with the most relationships first: on an unfamiliar schema they
  // are where the model lives, and starting anywhere else is a guess.
  const busiest = [...full.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-card px-3.5 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tables…"
          className="bg-surface-muted border border-card rounded px-2 py-0.5 text-[11px] text-ink placeholder:text-ink-faint w-40"
        />

        {snapshot.schemas.length > 1 && (
          <select
            value={schemaFilter}
            onChange={(e) => {
              setSchemaFilter(e.target.value);
              setFocus(null);
            }}
            className="bg-surface-muted border border-card rounded px-1.5 py-0.5 text-[11px] text-ink"
          >
            <option value="">every schema</option>
            {snapshot.schemas.map((sc) => (
              <option key={sc.name} value={sc.name}>
                {sc.name}
              </option>
            ))}
          </select>
        )}

        {focus !== null ? (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-ink-muted font-mono">{focus}</span>
            <label className="flex items-center gap-1 text-ink-faint">
              hops
              <select
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="bg-surface-muted border border-card rounded px-1 py-0.5 text-ink"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <button
              onClick={() => setFocus(null)}
              className="text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
            >
              show all {full.nodes.length}
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-ink-faint">
            {full.nodes.length} tables, {full.edges.length} relationship
            {full.edges.length === 1 ? '' : 's'} — click one to see just its neighbourhood
          </span>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-px">
          {(['none', 'keys', 'all'] as Detail[]).map((d) => (
            <button
              key={d}
              onClick={() => setDetail(d)}
              title={
                d === 'none'
                  ? 'Table names only'
                  : d === 'keys'
                    ? 'Only the columns that take part in a key'
                    : 'Every column'
              }
              className={`px-2 py-0.5 text-[11px] rounded ${
                detail === d ? 'bg-accent/20 text-ink' : 'text-ink-faint hover:text-ink-muted hover:bg-card'
              }`}
            >
              {d === 'none' ? 'Names' : d === 'keys' ? 'Keys' : 'Columns'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <Canvas
          graph={graph ?? { nodes: [], edges: [], danglingTargets: [] }}
          layout={layout}
          detail={detail}
          focus={focus}
          onFocus={setFocus}
          onOpen={onPickTable}
          connectionName={connectionName}
          onToast={toast}
        />

        <div className="w-52 shrink-0 border-l border-card overflow-y-auto">
          <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Most connected
          </p>
          {busiest.slice(0, 60).map((n) => (
            <button
              key={n.id}
              onClick={() => setFocus(n.id)}
              className={`w-full text-left px-3 py-1 text-[11px] flex items-center gap-2 hover:bg-card ${
                focus === n.id ? 'text-ink bg-card' : 'text-ink-muted'
              }`}
            >
              <span className="truncate font-mono">{n.table}</span>
              <span className="ml-auto tabular-nums text-ink-faint">{n.degree}</span>
            </button>
          ))}
        </div>
      </div>

      {full.danglingTargets.length > 0 && (
        <p className="shrink-0 border-t border-card px-3.5 py-1.5 text-[10px] text-ink-faint">
          {full.danglingTargets.length} foreign key
          {full.danglingTargets.length === 1 ? '' : 's'} point outside what has been read —{' '}
          <span className="font-mono">{full.danglingTargets.slice(0, 3).join(', ')}</span>
          {full.danglingTargets.length > 3 && ', …'}. Those edges are not drawn.
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-10 text-center text-xs text-ink-faint">
      {children}
    </div>
  );
}

function visibleColumns(node: ErNode, detail: Detail): ErNode['columns'] {
  if (detail === 'none') return [];
  if (detail === 'all') return node.columns.slice(0, MAX_ROWS);
  const keys = new Set([...node.primaryKey, ...node.foreignKeyColumns]);
  return node.columns.filter((c) => keys.has(c.name)).slice(0, MAX_ROWS);
}

function nodeSize(node: ErNode, detail: Detail): { w: number; h: number } {
  const rows = visibleColumns(node, detail);
  const longest = Math.max(
    node.table.length,
    ...rows.map((c) => c.name.length + c.typeName.length + 3),
    0,
  );
  const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, longest * 6.6 + 26));
  const hidden = detail === 'all' && node.columns.length > MAX_ROWS ? ROW_H : 0;
  return { w, h: HEADER_H + rows.length * ROW_H + hidden + (rows.length > 0 ? 6 : 0) };
}

function Canvas({
  graph,
  layout,
  detail,
  focus,
  onFocus,
  onOpen,
  connectionName,
  onToast,
}: {
  graph: ErGraph;
  layout: ReturnType<typeof layoutGraph> | null;
  detail: Detail;
  focus: string | null;
  onFocus(id: string | null): void;
  onOpen?(schema: string, table: string): void;
  connectionName: string;
  onToast(message: string, kind?: 'error' | 'info'): void;
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit whenever the drawn graph changes shape. Landing zoomed into a
  // corner of a diagram you just asked for is the fastest way to make a
  // canvas feel broken.
  const shape = `${layout?.width}x${layout?.height}:${graph.nodes.length}:${detail}:${focus}`;
  useEffect(() => {
    if (!layout || size.w === 0 || layout.width === 0) return;
    const pad = 32;
    const k = Math.min(1.4, Math.max(0.12, Math.min(
      (size.w - pad * 2) / layout.width,
      (size.h - pad * 2) / Math.max(1, layout.height),
    )));
    setView({
      x: (size.w - layout.width * k) / 2,
      y: (size.h - layout.height * k) / 2,
      k,
    });
    // Deliberately keyed on the SHAPE rather than the layout object: the
    // object is rebuilt on every render of the parent, and refitting on
    // each one would fight the user's pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, size.w, size.h]);

  const boxes = layout?.boxes ?? {};
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );

  /// Edges touching whatever is under the cursor, so hovering a table lights
  /// up its relationships instead of leaving you to trace lines by eye.
  const lit = useMemo(() => {
    if (hover === null) return null;
    return new Set(
      graph.edges.filter((e) => e.from === hover || e.to === hover).map((e) => e.id),
    );
  }, [hover, graph.edges]);

  const save = async (format: 'svg' | 'png') => {
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const name = `${connectionName.replace(/[^\w.-]+/g, '-')}-schema`;
    try {
      const markup = serialize(svg, layout.width, layout.height);
      if (format === 'svg') {
        const res = await window.overdb.invoke('app:saveFile', {
          suggestedName: `${name}.svg`,
          data: markup,
          extensions: ['svg'],
        });
        if (res.saved) onToast(`Saved ${res.path}`);
        else if (res.error) onToast(res.error, 'error');
        return;
      }
      const png = await rasterize(markup, layout.width, layout.height);
      const res = await window.overdb.invoke('app:saveFile', {
        suggestedName: `${name}.png`,
        data: png,
        encoding: 'base64',
        extensions: ['png'],
      });
      if (res.saved) onToast(`Saved ${res.path}`);
      else if (res.error) onToast(res.error, 'error');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div ref={boxRef} className="flex-1 min-w-0 relative overflow-hidden">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block cursor-grab active:cursor-grabbing"
        onWheel={(e) => {
          // Trackpad pinch arrives as a ctrl-wheel; a plain wheel pans, the
          // way every other canvas on this machine behaves.
          if (e.ctrlKey || e.metaKey) {
            const box = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - box.left;
            const py = e.clientY - box.top;
            setView((v) => {
              const k = Math.min(3, Math.max(0.08, v.k * (1 - e.deltaY / 400)));
              // Keep the point under the cursor fixed while scaling.
              return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
            });
          } else {
            setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
          }
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <defs>
          <marker id="erd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L7,4 L0,7" fill="none" stroke="rgb(var(--c-ink-faint))" strokeWidth="1.4" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {graph.edges.map((e) => {
            const a = boxes[e.from];
            const b = boxes[e.to];
            if (!a || !b) return null;
            const on = lit === null ? false : lit.has(e.id);
            return (
              <g key={e.id} opacity={lit === null || on ? 1 : 0.22}>
                {e.selfReference ? (
                  <path
                    d={selfLoop(a)}
                    fill="none"
                    stroke={on ? 'rgb(var(--c-accent))' : 'rgb(var(--c-ink-faint) / 0.75)'}
                    strokeWidth={on ? 2 : 1.2}
                    markerEnd="url(#erd-arrow)"
                  />
                ) : (
                  <path
                    d={edgePath(a, b)}
                    fill="none"
                    stroke={on ? 'rgb(var(--c-accent))' : 'rgb(var(--c-ink-faint) / 0.75)'}
                    strokeWidth={on ? 2 : 1.2}
                    markerEnd="url(#erd-arrow)"
                  />
                )}
                {/* The cardinality, written rather than drawn as feet: a
                    crow's foot at this scale is three pixels of noise, and
                    "many → 1" is unambiguous at any zoom. */}
                {on && (
                  <text
                    x={(a.x + a.w / 2 + b.x + b.w / 2) / 2}
                    y={(a.y + b.y) / 2}
                    textAnchor="middle"
                    className="fill-ink-muted text-[10px]"
                  >
                    {e.columns.join(', ')} → {e.refColumns.join(', ')}
                    {e.toCardinality === 'zero-or-one' ? ' (optional)' : ''}
                  </text>
                )}
              </g>
            );
          })}

          {graph.nodes.map((n) => {
            const box = boxes[n.id];
            if (!box) return null;
            return (
              <Node
                key={n.id}
                node={n}
                box={box}
                detail={detail}
                focused={focus === n.id}
                dim={lit !== null && hover !== n.id && !graph.edges.some(
                  (e) => lit.has(e.id) && (e.from === n.id || e.to === n.id),
                )}
                onEnter={() => setHover(n.id)}
                onLeave={() => setHover(null)}
                onClick={() => onFocus(focus === n.id ? null : n.id)}
                onDoubleClick={() => onOpen?.(n.schema, n.table)}
              />
            );
          })}
        </g>
      </svg>

      <div className="absolute bottom-2 left-2 flex items-center gap-1">
        {[
          { label: '−', act: () => setView((v) => ({ ...v, k: Math.max(0.08, v.k / 1.25) })) },
          { label: '+', act: () => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.25) })) },
        ].map((b) => (
          <button
            key={b.label}
            onClick={b.act}
            className="w-6 h-6 rounded border border-card bg-surface-elevated text-ink-muted hover:text-ink text-xs"
          >
            {b.label}
          </button>
        ))}
        <span className="ml-1 text-[10px] text-ink-faint tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
      </div>

      <div className="absolute top-2 right-2 flex items-center gap-1">
        {(['svg', 'png'] as const).map((f) => (
          <button
            key={f}
            onClick={() => void save(f)}
            className="px-2 py-0.5 rounded border border-card bg-surface-elevated text-[11px] text-ink-muted hover:text-ink uppercase"
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

function Node({
  node,
  box,
  detail,
  focused,
  dim,
  onEnter,
  onLeave,
  onClick,
  onDoubleClick,
}: {
  node: ErNode;
  box: Box;
  detail: Detail;
  focused: boolean;
  dim: boolean;
  onEnter(): void;
  onLeave(): void;
  onClick(): void;
  onDoubleClick(): void;
}): JSX.Element {
  const rows = visibleColumns(node, detail);
  const pk = new Set(node.primaryKey);
  const fk = new Set(node.foreignKeyColumns);
  const hiddenCount = detail === 'all' ? node.columns.length - rows.length : 0;

  return (
    <g
      transform={`translate(${box.x},${box.y})`}
      opacity={dim ? 0.3 : 1}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="cursor-pointer"
    >
      <rect
        width={box.w}
        height={box.h}
        rx={5}
        fill="rgb(var(--c-surface-elevated))"
        stroke={focused ? 'rgb(var(--c-accent))' : 'var(--c-card-border)'}
        strokeWidth={focused ? 2 : 1}
      />
      <rect width={box.w} height={HEADER_H} rx={5} fill="rgb(var(--c-surface-muted))" />
      <rect y={HEADER_H - 5} width={box.w} height={5} fill="rgb(var(--c-surface-muted))" />
      <line x1={0} x2={box.w} y1={HEADER_H} y2={HEADER_H} stroke="var(--c-card-border)" strokeWidth={1} />
      <text x={9} y={17} className="fill-ink text-[11px] font-medium">
        {node.table}
      </text>
      {/* A view is not a table and its "relationships" are not enforced —
          saying which is which costs one word. */}
      {node.kind !== 'table' && (
        <text x={box.w - 8} y={17} textAnchor="end" className="fill-ink-faint text-[9px] uppercase">
          {node.kind}
        </text>
      )}

      {rows.map((c, i) => (
        <g key={c.name} transform={`translate(0,${HEADER_H + 4 + i * ROW_H})`}>
          <text x={9} y={10} className="fill-ink-muted text-[10px] font-mono">
            {pk.has(c.name) ? '◆ ' : fk.has(c.name) ? '◇ ' : '  '}
            {c.name}
          </text>
          <text x={box.w - 8} y={10} textAnchor="end" className="fill-ink-faint text-[9px] font-mono">
            {c.typeName}
            {c.nullable ? '?' : ''}
          </text>
        </g>
      ))}
      {hiddenCount > 0 && (
        <text
          x={9}
          y={HEADER_H + 4 + rows.length * ROW_H + 10}
          className="fill-ink-faint text-[9px]"
        >
          +{hiddenCount} more
        </text>
      )}
    </g>
  );
}

/// A self-reference is a loop out of the right side and back into it. Drawn
/// rather than skipped because "this table points at itself" is exactly the
/// thing a reader needs told — a tree hiding in a flat table.
function selfLoop(box: Box): string {
  const x = box.x + box.w;
  const y1 = box.y + box.h * 0.35;
  const y2 = box.y + box.h * 0.65;
  return `M${x},${y1} C${x + 34},${y1 - 10} ${x + 34},${y2 + 10} ${x},${y2}`;
}

/// A standalone SVG file, with the theme variables resolved.
///
/// The live diagram is painted in `var(--c-…)` so it follows the app's
/// theme. Those variables do not exist outside our window, so an exported
/// file would be black on black — every one is substituted for the value it
/// currently has before the markup leaves.
function serialize(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const root = getComputedStyle(document.documentElement);
  const pad = 24;

  // The pan/zoom transform belongs to the window, not to the file.
  clone.querySelector('g[transform]')?.setAttribute('transform', 'translate(0,0)');

  const resolve = (value: string): string =>
    value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => root.getPropertyValue(name).trim() || 'currentColor');

  for (const el of Array.from(clone.querySelectorAll<SVGElement>('*'))) {
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr);
      if (v && v.includes('var(')) el.setAttribute(attr, resolve(v));
    }
    // Text colour comes from Tailwind classes, which the file will not have.
    const cls = el.getAttribute('class') ?? '';
    if (el.tagName === 'text') {
      const token = cls.includes('fill-ink-faint')
        ? '--c-ink-faint'
        : cls.includes('fill-ink-muted')
          ? '--c-ink-muted'
          : '--c-ink';
      el.setAttribute('fill', `rgb(${root.getPropertyValue(token).trim()})`);
      const size = /text-\[(\d+)px\]/.exec(cls)?.[1] ?? '11';
      el.setAttribute('font-size', size);
      el.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');
    }
    el.removeAttribute('class');
  }

  // Assembled by hand rather than by patching `outerHTML`: the file needs a
  // painted background (a transparent PNG of dark-mode text is invisible on
  // anything it gets pasted into) and that rect has to come first.
  const background = `rgb(${root.getPropertyValue('--c-surface').trim()})`;
  const w = width + pad * 2;
  const h = height + pad * 2;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-pad} ${-pad} ${w} ${h}">`,
    `<rect x="${-pad}" y="${-pad}" width="${w}" height="${h}" fill="${background}"/>`,
    clone.innerHTML,
    '</svg>',
  ].join('\n');
}

/// The same markup as a PNG, base64 for the save channel. Twice the pixels,
/// because a diagram is text and a 1× raster of small text is unreadable.
async function rasterize(markup: string, width: number, height: number): Promise<string> {
  const scale = 2;
  const pad = 24;
  const w = (width + pad * 2) * scale;
  const h = (height + pad * 2) * scale;
  // btoa only takes latin-1, and a table name can be anything the server
  // allows; encode to UTF-8 bytes first.
  const bytes = new TextEncoder().encode(markup);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const url = `data:image/svg+xml;base64,${btoa(binary)}`;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The diagram could not be rasterised.'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas available.');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}
