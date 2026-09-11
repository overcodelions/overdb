// Filtering an Ask thread down to the exchanges that mention something.
// Split out from AskPane so the grouping rule — which is the whole reason a
// filter over a conversation is not just `turns.filter()` — can be tested.

import type { AskTurn } from '@shared/types';

/// A question and the answers under it, as one unit. Filtering turn by turn
/// would leave an answer stranded with no question above it — and an answer
/// is only readable under the thing that was asked.
///
/// A thread can open with an assistant turn (a failure appended before any
/// question landed), so the first group is not assumed to start with a user.
export function exchanges(turns: AskTurn[]): AskTurn[][] {
  const out: AskTurn[][] = [];
  for (const turn of turns) {
    if (turn.role === 'user' || !out.length) out.push([turn]);
    else out[out.length - 1].push(turn);
  }
  return out;
}

/// The statement counts as part of the turn: half of what you go looking for
/// months later is a table name that only ever appeared in the SQL.
function matches(turn: AskTurn, needle: string): boolean {
  return turn.text.toLowerCase().includes(needle) || !!turn.sql?.toLowerCase().includes(needle);
}

/// The turns to show for a filter. An empty or whitespace-only filter is not
/// a filter — it returns the thread itself, by identity, so the caller's
/// scroll effect does not fire on a cleared box.
export function filterTurns(turns: AskTurn[], filter: string): AskTurn[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return turns;
  return exchanges(turns)
    .filter((ex) => ex.some((t) => matches(t, needle)))
    .flat();
}
