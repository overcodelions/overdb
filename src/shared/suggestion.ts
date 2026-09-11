// Dropping a model's SQL into the editor.
//
// Two things go wrong when a suggestion lands at the cursor. It welds itself
// into the middle of the statement you were reading, and — a week later —
// there is no way to tell which of the six queries in the tab you wrote and
// which one an assistant wrote. So a suggestion goes at the END, and it
// arrives with a line saying where it came from.

/// A suggestion, with its provenance on the line above it.
///
/// The note is folded to a single line before it is commented: a note
/// carrying a newline would put its second half BELOW the `--` and into the
/// executable part of the buffer, which is a way to run something nobody
/// wrote.
export function suggestionBlock(sql: string, note: string, at: Date = new Date()): string {
  const when = at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const line = note.replace(/\s+/g, ' ').trim();
  // `-- ` with the trailing space, not `--`: MySQL only treats a double dash
  // as a comment when whitespace follows it.
  return `-- ${line}${line ? ' · ' : ''}${when}\n${sql.trim()}`;
}
