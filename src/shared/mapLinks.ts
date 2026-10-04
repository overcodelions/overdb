// What the database map tells a base about its links.
//
// A base guesses most of its links from column names, and the ones that
// could mean more than one table are put to a person. The map has read the
// code, and its links are cited (`path:line`), so it can settle those
// guesses: confirm one, point one at the table the code really uses, or
// add a link the names never suggested. Foreign keys are facts already and
// are left alone. See src/shared/dbMap.ts and src/shared/baseline.ts.

import type { DbMap } from './dbMap';
import { isAudit, keyOf, tableKey, type Link, type TableRef } from './baseline';
import type { SchemaSnapshot } from './types';

export interface MapLinkResult {
  links: Link[];
  confirmed: number;
  corrected: number;
  added: number;
}

interface Col {
  ref: TableRef;
  column: string;
  /// The table's own single-column key: declared, or read off its name
  /// where none is declared, as in every Redshift table.
  isKey: boolean;
}

export function linksFromMap(map: DbMap, snapshot: SchemaSnapshot, links: readonly Link[]): MapLinkResult {
  // Real-case names by lower-case `schema.table.column`.
  const cols = new Map<string, Col>();
  for (const sc of snapshot.schemas)
    for (const t of sc.tables) {
      const pk = keyOf(t)?.toLowerCase() ?? null;
      for (const c of t.columns)
        cols.set(`${sc.name}.${t.name}.${c.name}`.toLowerCase(), { ref: { schema: sc.name, table: t.name }, column: c.name, isKey: c.name.toLowerCase() === pk });
    }

  const out = links.map((l) => ({ ...l }));
  const holding = (c: Col) =>
    out.find((l) => !l.when && l.columns.length === 1 && tableKey(l.from) === tableKey(c.ref) && l.columns[0].toLowerCase() === c.column.toLowerCase());
  let confirmed = 0;
  let corrected = 0;
  let added = 0;

  for (const m of map.links) {
    const a = cols.get(m.from.toLowerCase());
    const b = cols.get(m.to.toLowerCase());
    if (!a || !b || tableKey(a.ref) === tableKey(b.ref)) continue;
    // Which end holds the reference: the one pointing at the other's key.
    // Both keys is a one-to-one extension, and the end a link already starts
    // from holds it. Neither is not a reference at all — one column of a
    // join on two, `deal.client_id = partner.client_id` beside the partner
    // ids — and following it would copy every partner of the client for
    // each deal. The map does not promise an order, so neither is assumed.
    const [from, to] =
      b.isKey && !a.isKey ? [a, b]
        : a.isKey && !b.isKey ? [b, a]
          : a.isKey && b.isKey ? (holding(a) ? [a, b] : holding(b) ? [b, a] : [null, null])
            : [null, null];
    if (!from || !to) continue;
    const cited = { why: m.why, ...(m.ref ? { ref: m.ref } : {}) };
    const existing = holding(from);
    if (existing?.source === 'fk') continue;
    // A polymorphic column is settled by its type values, not by one target.
    if (out.some((l) => l.when && tableKey(l.from) === tableKey(from.ref) && l.columns[0]?.toLowerCase() === from.column.toLowerCase())) continue;
    if (existing) {
      if (existing.cited) continue;
      if (tableKey(existing.to) === tableKey(to.ref)) {
        Object.assign(existing, { alternatives: [], cited });
        confirmed += 1;
      } else {
        Object.assign(existing, { to: to.ref, refColumns: [to.column], alternatives: [], source: 'code', cited });
        corrected += 1;
      }
      continue;
    }
    if (isAudit(from.column)) continue;
    out.push({ from: from.ref, columns: [from.column], to: to.ref, refColumns: [to.column], source: 'code', audit: false, alternatives: [], cited });
    added += 1;
  }
  return { links: out, confirmed, corrected, added };
}
