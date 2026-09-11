import type { SchemaSnapshot, TableInfo } from './types';

/// The foreign-key graph, and where to draw it.
///
/// Pure, and separate from the view, because everything interesting here is
/// arithmetic: which table points at which, how many layers deep that goes,
/// and what order within a layer crosses the fewest edges. A layout computed
/// inside a React component can only be checked by looking at it.
///
/// The graph is DISCOVERED, never declared. Every edge below comes from a
/// foreign key the server actually holds — overdb does not infer a
/// relationship from a column called `user_id`, because a guess drawn in the
/// same ink as a constraint is indistinguishable from one.

export interface ErNode {
  /// `schema.table`, which is what the edges reference.
  id: string;
  schema: string;
  table: string;
  kind: TableInfo['kind'];
  columns: Array<{ name: string; typeName: string; nullable: boolean }>;
  primaryKey: string[];
  /// Columns that are part of some outgoing foreign key, so the view can
  /// mark them without re-walking the edges.
  foreignKeyColumns: string[];
  /// Edges touching this table, in or out. The filter uses it to put the
  /// busiest tables first, which is almost always where you want to start.
  degree: number;
}

/// One end of a relationship, in the vocabulary an ER diagram uses.
///
/// `one` on the referencing side means the foreign key's columns are
/// themselves unique — a genuine 1:1, which is worth distinguishing from
/// the many:1 that most foreign keys are.
export type Cardinality = 'one' | 'many' | 'zero-or-one';

export interface ErEdge {
  id: string;
  name: string;
  /// The table holding the foreign key.
  from: string;
  /// The table it points at.
  to: string;
  columns: string[];
  refColumns: string[];
  /// How many rows of `from` per row of `to`.
  fromCardinality: Cardinality;
  /// Always one row of `to` — or none, when the key is nullable.
  toCardinality: 'one' | 'zero-or-one';
  selfReference: boolean;
}

export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
  /// Foreign keys pointing at a table this snapshot does not contain —
  /// usually a schema that has not been introspected. Named rather than
  /// dropped: an edge silently missing from a diagram is worse than a
  /// diagram that says what it could not draw.
  danglingTargets: string[];
}

function qualify(schema: string | null, table: string, fallbackSchema: string): string {
  return `${schema ?? fallbackSchema}.${table}`;
}

export function buildGraph(snapshot: SchemaSnapshot, schemas?: string[]): ErGraph {
  const wanted = schemas && schemas.length > 0 ? new Set(schemas) : null;
  const included = snapshot.schemas.filter((sc) => !wanted || wanted.has(sc.name));

  const nodes: ErNode[] = [];
  const byId = new Map<string, ErNode>();
  for (const sc of included) {
    for (const table of sc.tables) {
      const fkColumns = [...new Set(table.foreignKeys.flatMap((fk) => fk.columns))];
      const node: ErNode = {
        id: `${sc.name}.${table.name}`,
        schema: sc.name,
        table: table.name,
        kind: table.kind,
        columns: table.columns.map((c) => ({
          name: c.name,
          typeName: c.typeName,
          nullable: c.nullable,
        })),
        primaryKey: table.primaryKey,
        foreignKeyColumns: fkColumns,
        degree: 0,
      };
      nodes.push(node);
      byId.set(node.id, node);
    }
  }

  const edges: ErEdge[] = [];
  const dangling = new Set<string>();

  for (const sc of included) {
    for (const table of sc.tables) {
      const from = `${sc.name}.${table.name}`;
      const node = byId.get(from);
      if (!node) continue;
      const nullableColumns = new Set(
        table.columns.filter((c) => c.nullable).map((c) => c.name),
      );
      // A unique index over exactly the foreign key's columns is what makes
      // a relationship 1:1 rather than many:1 — the same distinction the
      // constraint itself does not record.
      const uniqueSets = [
        table.primaryKey,
        ...table.indexes.filter((ix) => ix.unique).map((ix) => ix.columns),
      ].filter((cols) => cols.length > 0);

      for (const fk of table.foreignKeys) {
        const to = qualify(fk.refSchema, fk.refTable, sc.name);
        if (!byId.has(to)) {
          dangling.add(to);
          continue;
        }
        const unique = uniqueSets.some((cols) => sameSet(cols, fk.columns));
        const optional = fk.columns.some((c) => nullableColumns.has(c));
        edges.push({
          id: `${from}::${fk.name}`,
          name: fk.name,
          from,
          to,
          columns: fk.columns,
          refColumns: fk.refColumns,
          fromCardinality: unique ? (optional ? 'zero-or-one' : 'one') : 'many',
          toCardinality: optional ? 'zero-or-one' : 'one',
          selfReference: from === to,
        });
        node.degree++;
        if (from !== to) {
          const target = byId.get(to);
          if (target) target.degree++;
        }
      }
    }
  }

  return { nodes, edges, danglingTargets: [...dangling].sort() };
}

/// Null-tolerant: `IndexInfo.columns` is a shared type any adapter fills
/// in, and MySQL reports no column name at all for a functional index. A
/// diagram that throws on one unusual index is worse than one that does not
/// call that index unique.
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const fold = (s: string | null | undefined) => (s ?? '').toLowerCase();
  const set = new Set(a.map(fold));
  return b.every((s) => set.has(fold(s)));
}

/// Cut the graph down to what someone is actually looking at.
///
/// `depth` is why this exists: a 900-table schema drawn whole is a hairball,
/// and the useful question is nearly always "this table and what touches
/// it". One hop answers it; two is the most that stays readable.
export function filterGraph(
  graph: ErGraph,
  options: { query?: string; focus?: string; depth?: number; kinds?: Array<TableInfo['kind']> } = {},
): ErGraph {
  const { query = '', focus, depth = 1, kinds } = options;
  const term = query.trim().toLowerCase();

  // Indexed once rather than scanned per node: this runs on every
  // keystroke of the filter box, and a linear lookup inside a filter over
  // every node is quadratic in the table count — which on a 900-table
  // schema is felt.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let keep = new Set(graph.nodes.map((n) => n.id));

  if (kinds && kinds.length > 0) {
    const allowed = new Set(kinds);
    keep = new Set([...keep].filter((id) => allowed.has(byId.get(id)?.kind ?? 'table')));
  }

  if (term !== '') {
    keep = new Set(
      [...keep].filter((id) => {
        const node = byId.get(id);
        return node !== undefined && (node.table.toLowerCase().includes(term) || node.id.toLowerCase().includes(term));
      }),
    );
  }

  if (focus !== undefined) {
    const reachable = new Set<string>([focus]);
    let frontier = new Set<string>([focus]);
    for (let hop = 0; hop < Math.max(0, depth); hop++) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.from) && !reachable.has(edge.to)) next.add(edge.to);
        if (frontier.has(edge.to) && !reachable.has(edge.from)) next.add(edge.from);
      }
      for (const id of next) reachable.add(id);
      frontier = next;
    }
    keep = new Set([...keep].filter((id) => reachable.has(id)));
    // The focus is the point of the view, so it survives a filter that
    // would otherwise exclude it.
    keep.add(focus);
  }

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges, danglingTargets: graph.danglingTargets };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  boxes: Record<string, Box>;
  width: number;
  height: number;
  /// Edges the layer assignment had to ignore to break a cycle. Reported so
  /// the view can draw them differently — a circular reference is a real
  /// property of the schema, not a layout failure to hide.
  backEdges: string[];
}

/// A layered layout: tables that are only pointed AT sit at the top, the
/// tables pointing at them below, and so on down.
///
/// Chosen over a force-directed layout because a schema has a direction and
/// force layouts throw it away: a lookup table should be visibly upstream of
/// the rows referencing it, and a diagram whose shape changes every time you
/// open it cannot be recognised. Within a layer, nodes are ordered by the
/// average position of their neighbours in the layer above — one barycentre
/// pass, which is most of what crossing reduction ever gets you.
export function layoutGraph(
  graph: ErGraph,
  sizes: Record<string, { w: number; h: number }>,
  options: { gapX?: number; gapY?: number } = {},
): Layout {
  const gapX = options.gapX ?? 44;
  const gapY = options.gapY ?? 56;

  const ids = graph.nodes.map((n) => n.id);
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (e.selfReference) continue;
    outgoing.get(e.from)?.push(e.to);
  }

  // Layer = 1 + the deepest thing this table points at. Depth-first with an
  // in-progress set, so a cycle stops at the node that closes it rather than
  // recursing forever; the edge that closed it is reported.
  const layer = new Map<string, number>();
  const inProgress = new Set<string>();
  const backEdges: string[] = [];

  const depthOf = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (inProgress.has(id)) return 0;
    inProgress.add(id);
    let deepest = 0;
    for (const target of outgoing.get(id) ?? []) {
      if (inProgress.has(target)) {
        backEdges.push(`${id}->${target}`);
        continue;
      }
      deepest = Math.max(deepest, depthOf(target) + 1);
    }
    inProgress.delete(id);
    layer.set(id, deepest);
    return deepest;
  };
  for (const id of ids) depthOf(id);

  const layers: string[][] = [];
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    (layers[l] ??= []).push(id);
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // Order within each layer. The top layer is alphabetical — an arbitrary
  // but STABLE starting point, which is what makes the diagram look the
  // same each time you open it. Every layer below is placed at the mean
  // position of what it points at.
  const order = new Map<string, number>();
  layers.forEach((ids_, l) => {
    if (l === 0) {
      ids_.sort((a, b) => a.localeCompare(b));
    } else {
      ids_.sort((a, b) => {
        const ba = barycentre(a, outgoing, order);
        const bb = barycentre(b, outgoing, order);
        return ba === bb ? a.localeCompare(b) : ba - bb;
      });
    }
    ids_.forEach((id, i) => order.set(id, i));
  });

  const boxes: Record<string, Box> = {};
  let y = 0;
  let width = 0;
  for (const ids_ of layers) {
    const rowHeight = Math.max(0, ...ids_.map((id) => sizes[id]?.h ?? 0));
    let x = 0;
    for (const id of ids_) {
      const size = sizes[id] ?? { w: 200, h: 80 };
      boxes[id] = { x, y, w: size.w, h: size.h };
      x += size.w + gapX;
    }
    width = Math.max(width, x - gapX);
    y += rowHeight + gapY;
  }

  return { boxes, width: Math.max(0, width), height: Math.max(0, y - gapY), backEdges };
}

function barycentre(
  id: string,
  outgoing: Map<string, string[]>,
  order: Map<string, number>,
): number {
  const targets = (outgoing.get(id) ?? []).map((t) => order.get(t)).filter((v): v is number => v !== undefined);
  if (targets.length === 0) return Number.MAX_SAFE_INTEGER;
  return targets.reduce((a, b) => a + b, 0) / targets.length;
}

/// Where an edge leaves one box and arrives at another, as an orthogonal
/// path with rounded corners.
///
/// Straight diagonals between boxes are unreadable past a dozen edges: they
/// cross at arbitrary angles and there is no way to follow one with your
/// eye. Orthogonal segments give every edge a spine.
export function edgePath(from: Box, to: Box): string {
  const x1 = from.x + from.w / 2;
  const x2 = to.x + to.w / 2;
  // Leave from the side nearest the target, arrive at the opposite one.
  const upward = to.y + to.h <= from.y;
  const y1 = upward ? from.y : from.y + from.h;
  const y2 = upward ? to.y + to.h : to.y;
  const midY = (y1 + y2) / 2;
  if (Math.abs(x1 - x2) < 1) return `M${x1},${y1} L${x2},${y2}`;
  const r = Math.min(10, Math.abs(midY - y1), Math.abs(x2 - x1) / 2);
  const sx = x2 > x1 ? 1 : -1;
  const sy = midY > y1 ? 1 : -1;
  return [
    `M${x1},${y1}`,
    `L${x1},${midY - r * sy}`,
    `Q${x1},${midY} ${x1 + r * sx},${midY}`,
    `L${x2 - r * sx},${midY}`,
    `Q${x2},${midY} ${x2},${midY + r * sy}`,
    `L${x2},${y2}`,
  ].join(' ');
}

/// The crow's-foot end marker's name, so the view can pick one symbol per
/// cardinality rather than spelling the rule out at each end.
export function footFor(cardinality: Cardinality | 'one' | 'zero-or-one'): 'crow' | 'bar' | 'circle-bar' {
  if (cardinality === 'many') return 'crow';
  return cardinality === 'zero-or-one' ? 'circle-bar' : 'bar';
}
