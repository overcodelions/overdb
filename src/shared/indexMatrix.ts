import type { IndexInfo, SchemaSnapshot } from './types';
import type { CellTone } from './fanout';

/// The indexes on the tables a statement read, one row per index and one
/// cell per member.
///
/// Deliberately the same shape as `columnMatrix` in fanout.ts, because it
/// answers the same shape of question and sits directly under it: a row per
/// thing, a column per member, read down. The pane already teaches that
/// way of reading, and a verdict cell plus a paragraph made you learn a
/// second one — which stopped working the moment there were three members
/// and four differences, since prose cannot say which column it is about.
///
/// Rows are keyed by the index's COLUMNS, never its name. Two servers built
/// by different migrations name the same index differently — `idx_a` here
/// and `t_email_idx` there — and matching on names reports every index as
/// both missing and extra. What an index IS, is the columns it covers and
/// whether it is unique.

export interface IndexCell {
  memberId: string;
  text: string;
  tone: CellTone;
}

export interface IndexRow {
  /// `schema.table`, so a join's rows say which table each index is on.
  table: string;
  /// `(a, b)` or `unique (a, b)` — the baseline's spelling where it has
  /// one, otherwise the first member that does.
  label: string;
  cells: IndexCell[];
  interesting: boolean;
}

export interface IndexMatrix {
  rows: IndexRow[];
  /// Rows where every member agrees. Counted rather than drawn: twenty
  /// identical rows are what stops the one that is not from being seen.
  matching: number;
  /// Members whose catalog has not been read. Named, because an index
  /// comparison that has not looked must never render as "same" — that is
  /// the one answer worse than none.
  unread: string[];
  /// Tables that were compared, for a heading.
  tables: string[];
}

/// One index's identity: the columns it covers, folded for comparison.
function key(ix: IndexInfo): string {
  return ix.columns.map((c) => (c ?? '').toLowerCase()).join(',');
}

function label(ix: IndexInfo): string {
  return `${ix.unique ? 'unique ' : ''}(${ix.columns.join(', ')})`;
}

/// Whether every column of this index could be read. MySQL reports no
/// column name at all for a functional index, and Postgres's `attname` is
/// null for an expression one; an index nothing can name is one the
/// comparison has to leave out rather than key as an empty string, since
/// two such indexes would otherwise collide and read as matching.
function readable(ix: IndexInfo): boolean {
  return ix.columns.length > 0 && ix.columns.every((c) => typeof c === 'string' && c !== '');
}

function indexesFor(
  snapshot: SchemaSnapshot | undefined,
  table: { schema: string | null; table: string },
): IndexInfo[] {
  if (!snapshot) return [];
  const wanted = table.table.toLowerCase();
  for (const sc of snapshot.schemas) {
    if (table.schema !== null && sc.name !== table.schema) continue;
    const found = sc.tables.find((t) => t.name.toLowerCase() === wanted);
    if (found) return found.indexes.filter(readable);
  }
  return [];
}

export function indexMatrix(
  members: Array<{ connectionId: string; snapshot: SchemaSnapshot | undefined }>,
  baselineId: string | null,
  tables: Array<{ schema: string | null; table: string }>,
): IndexMatrix {
  const ordered = [...members].sort(
    (a, b) => Number(b.connectionId === baselineId) - Number(a.connectionId === baselineId),
  );
  const baseline = ordered.find((m) => m.connectionId === baselineId) ?? ordered[0] ?? null;
  const unread = ordered.filter((m) => !m.snapshot).map((m) => m.connectionId);

  const rows: IndexRow[] = [];
  let matching = 0;

  for (const table of tables) {
    const byMember = new Map(
      ordered.map((m) => [m.connectionId, indexesFor(m.snapshot, table)]),
    );

    // Baseline order first — it is the reference, so its shape is the one
    // to read down — then anything only the others have.
    const order: string[] = [];
    const labels = new Map<string, string>();
    for (const source of [baseline, ...ordered].filter(Boolean)) {
      for (const ix of byMember.get(source!.connectionId) ?? []) {
        const k = key(ix);
        if (!order.includes(k)) order.push(k);
        if (!labels.has(k)) labels.set(k, label(ix));
      }
    }

    for (const k of order) {
      const base = (byMember.get(baseline?.connectionId ?? '') ?? []).find((ix) => key(ix) === k);
      const cells: IndexCell[] = ordered.map((m) => {
        if (!m.snapshot) {
          // Never "same". We did not look.
          return { memberId: m.connectionId, text: 'not read', tone: 'unknown' as CellTone };
        }
        const here = (byMember.get(m.connectionId) ?? []).find((ix) => key(ix) === k);
        if (!here) return { memberId: m.connectionId, text: 'absent', tone: 'absent' as CellTone };
        if (m.connectionId === baseline?.connectionId) {
          return { memberId: m.connectionId, text: '✓', tone: 'baseline' as CellTone };
        }
        if (!base) {
          // The baseline does not have it, so this cell IS the difference.
          // Calling it "extra" on every other member would report one
          // finding N times.
          return { memberId: m.connectionId, text: 'extra', tone: 'drift' as CellTone };
        }
        // An index that exists but is not unique where the baseline's is
        // unique is a CORRECTNESS difference, not a performance one — the
        // server will accept duplicates the baseline rejects — so it gets
        // its own state rather than passing as a match.
        if (here.unique !== base.unique) {
          return {
            memberId: m.connectionId,
            text: here.unique ? 'unique' : 'not unique',
            tone: 'drift' as CellTone,
          };
        }
        return { memberId: m.connectionId, text: '✓', tone: 'same' as CellTone };
      });

      // `unknown` counts as interesting, and that is the whole point of it
      // being a separate tone: a member whose catalog was never read must
      // surface as unread rather than be folded into the matching tally,
      // which would report "same" about something nobody looked at.
      const interesting = cells.some(
        (c) => c.tone === 'drift' || c.tone === 'absent' || c.tone === 'unknown',
      );
      if (interesting) {
        rows.push({
          table: `${table.schema ? `${table.schema}.` : ''}${table.table}`,
          label: labels.get(k) ?? k,
          cells,
          interesting,
        });
      } else {
        matching++;
      }
    }
  }

  return {
    rows,
    matching,
    unread,
    tables: tables.map((t) => t.table),
  };
}

/// What the differences MEAN, in one line, or null when there is nothing
/// to say.
///
/// The cells say what is different; this says what it costs. A missing
/// index is a performance difference and a lost uniqueness constraint is a
/// correctness one, and those are not the same news — the second is said
/// first, because a server quietly accepting duplicates the baseline
/// rejects is the finding you would want woken up for.
export function indexConsequence(matrix: IndexMatrix): string | null {
  const notUnique = matrix.rows.filter((r) =>
    r.cells.some((c) => c.text === 'not unique'),
  ).length;
  const absent = matrix.rows.filter((r) =>
    r.cells.some((c) => c.tone === 'absent' && c.memberId !== r.cells[0].memberId),
  ).length;

  const parts: string[] = [];
  if (notUnique > 0) {
    parts.push(
      `${notUnique} index${notUnique === 1 ? ' is' : 'es are'} not unique on a member where the baseline's is — duplicates the baseline rejects are possible there.`,
    );
  }
  if (absent > 0) {
    parts.push(
      `${absent} index${absent === 1 ? '' : 'es'} the baseline has ${absent === 1 ? 'is' : 'are'} missing on a member — expect a different plan, not just a different row count.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
