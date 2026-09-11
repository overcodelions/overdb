// A connection's editor buffers.
//
// One buffer per connection meant one scratchpad per database: a day's
// queries piled into a single document you had to scroll past to write the
// next one, with no way to keep a clean slate next to work in progress.
//
// Extra buffers are addressed by suffixing the connection's id, so they live
// in the SAME `buffers` map the single buffer already used. That is the
// whole reason for the scheme: no migration, no second persisted structure
// to keep in step, and a workspace written by an older build opens with
// exactly the one tab it had.

const SEP = '::';

/// Connection ids are UUIDs, so the separator cannot occur inside one and
/// the split back to a connection id is unambiguous.
export function bufferKey(connectionId: string, n: number): string {
  return n === 0 ? connectionId : `${connectionId}${SEP}${n}`;
}

/// Whether a key is one of this connection's buffers. Used when a
/// connection is deleted — every one of its tabs goes with it, not just the
/// first.
export function ownsBuffer(connectionId: string, key: string): boolean {
  return key === connectionId || key.startsWith(connectionId + SEP);
}

function suffix(connectionId: string, key: string): number | null {
  if (!key.startsWith(connectionId + SEP)) return null;
  const n = Number(key.slice(connectionId.length + SEP.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/// Every buffer for a connection, in tab order.
///
/// The base key is always first and always present, even when the map has
/// never heard of it: a connection you have not typed into yet still needs
/// somewhere to type.
export function buffersFor(connectionId: string, buffers: Record<string, string>): string[] {
  const extras = Object.keys(buffers)
    .map((key) => ({ key, n: suffix(connectionId, key) }))
    .filter((x): x is { key: string; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.key);
  return [connectionId, ...extras];
}

/// Highest suffix in use plus one — not "count + 1". Closing tab 2 of 3 and
/// opening a new one must not hand it the key tab 3 is still using.
export function nextBufferKey(connectionId: string, buffers: Record<string, string>): string {
  const highest = Object.keys(buffers).reduce((max, key) => {
    const n = suffix(connectionId, key);
    return n !== null && n > max ? n : max;
  }, 0);
  return bufferKey(connectionId, highest + 1);
}

/// What a tab is called.
///
/// Derived from the text rather than typed by hand: naming a scratch buffer
/// is a chore nobody does, and an unnamed one you have to click to identify
/// is the problem tabs were meant to solve. The leading keyword plus the
/// first table named is almost always enough to tell two apart — the same
/// rule the result tabs use, so the two strips read alike.
export function bufferLabel(sql: string): string {
  const flat = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Empty';
  const m = /^(\w+)(?:.*?\b(?:from|into|update|table)\s+([`"\w.]+))?/i.exec(flat);
  if (!m) return flat.slice(0, 20);
  const verb = m[1].toLowerCase();
  const target = m[2]?.replace(/[`"]/g, '');
  return target ? `${verb} ${target}` : verb;
}

/// Where a span we measured earlier sits NOW.
///
/// Anything that sends text to a model and puts the answer back holds
/// offsets across a round trip that takes seconds, and you are free to keep
/// typing in the meantime — so by the time the answer lands, `from`/`to`
/// may name different characters than the ones that were asked about.
/// Replacing them anyway is how a rewrite eats the statement below it.
///
/// The original text is the anchor: still at those offsets, use them; moved
/// but still present exactly once, follow it; gone or now ambiguous, refuse
/// — there is no honest place to put the answer and dropping it is better
/// than guessing.
export function relocate(
  text: string,
  span: { from: number; to: number; was: string },
): { from: number; to: number } | null {
  if (text.slice(span.from, span.to) === span.was) return { from: span.from, to: span.to };
  const at = text.indexOf(span.was);
  if (at === -1 || at !== text.lastIndexOf(span.was)) return null;
  return { from: at, to: at + span.was.length };
}
