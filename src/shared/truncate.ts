// Cutting a name so the part that identifies it survives.
//
// `text-overflow: ellipsis` always eats the tail, which is exactly wrong
// for the names people actually have: `Redshift - @PROD [acme-pipe]`,
// `Redshift - @PROD [EU]` and `Redshift - @PROD [RW]` are three different
// servers that CSS renders as three identical rows. The distinguishing
// fragment is at the end, so the cut has to come out of the middle.
//
// Pure and character-based rather than measured: the sidebar is a fixed
// width the user drags, the font is one system stack, and a character
// budget derived from that width is both good enough and testable.

const ELLIPSIS = '…';

export function middleTruncate(text: string, maxChars: number): string {
  if (maxChars <= 1 || text.length <= maxChars) return text;
  // Below about five characters there is no middle left to speak of, and a
  // head-and-tail cut reads as noise. Fall back to the ordinary tail cut.
  if (maxChars < 6) return text.slice(0, maxChars - 1) + ELLIPSIS;

  // Keep slightly more of the tail than the head: the head is usually the
  // shared prefix ("Redshift - @PROD") and the tail is the part that says
  // which one this is.
  const keep = maxChars - 1;
  const tail = Math.ceil(keep / 2);
  const head = keep - tail;
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - tail)}`;
}

/// How many characters of a connection name fit, given the sidebar width.
///
/// The row is: 12px padding, the engine badge, an 8px gap, the name, then
/// the status dot and 12px padding. 6.15px is the average advance of the
/// system UI stack at 12px — measured rather than assumed, and only ever
/// used to decide when to cut.
export function nameBudget(sidebarWidth: number, badgeWidth: number): number {
  const available = sidebarWidth - 12 - badgeWidth - 8 - 5 - 8 - 12;
  return Math.max(4, Math.floor(available / 6.15));
}
