// Naming a duplicate.
//
// A copy that lands as a second row with the SAME name is worse than no
// copy at all: the sidebar then holds two identical labels pointing at
// different databases, and the next thing you do is run a query against
// the wrong one. So a duplicate always arrives with a name that says what
// it is, and the number only appears once it has to.

/// `x` -> `x copy` -> `x copy 2` -> `x copy 3`, skipping anything already
/// taken. Comparison is exact: two names differing only in case ARE two
/// different labels on screen, and pretending otherwise would rename a
/// copy for a clash the user cannot see.
export function copyName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  // Duplicating a duplicate names itself from the ORIGINAL, so a third
  // generation is `x copy 3` rather than `x copy copy`.
  const root = base.replace(/ copy(?: \d+)?$/, '');
  const first = `${root} copy`;
  if (!used.has(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${first} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
