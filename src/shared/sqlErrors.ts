// Reading a database's error message well enough to offer the fix.
//
// The first query anyone writes against an unfamiliar schema fails on a
// guessed column name. That is the moment of peak need and near-zero effort:
// the catalog is already loaded, the real name is in it, and the distance
// between `id` and `er_id` is small. Sending that to a language model would
// be slower, less reliable, and absurd — so the common case is answered here,
// deterministically, and the model is only a fallback for the rest.

export type SqlErrorKind = 'unknown-column' | 'unknown-table' | 'syntax' | 'other';

export interface ParsedSqlError {
  kind: SqlErrorKind;
  /// The identifier the server complained about, unquoted.
  identifier?: string;
  /// Schema/table qualifier when the message carried one.
  qualifier?: string;
}

/// Each engine words these differently; all three are common enough to be
/// worth matching exactly rather than guessing from keywords.
export function parseSqlError(message: string): ParsedSqlError {
  const m = message ?? '';

  // MySQL/MariaDB 1054, Postgres 42703, SQLite.
  let hit =
    /unknown column '([^']+)'/i.exec(m) ??
    /column "([^"]+)" does not exist/i.exec(m) ??
    /no such column:\s*([^\s,]+)/i.exec(m);
  if (hit) {
    const raw = hit[1];
    const parts = raw.split('.');
    return {
      kind: 'unknown-column',
      identifier: parts[parts.length - 1],
      qualifier: parts.length > 1 ? parts[parts.length - 2] : undefined,
    };
  }

  // MySQL 1146, Postgres 42P01, SQLite.
  hit =
    /table '([^']+)' doesn't exist/i.exec(m) ??
    /relation "([^"]+)" does not exist/i.exec(m) ??
    /no such table:\s*([^\s,]+)/i.exec(m);
  if (hit) {
    const raw = hit[1];
    const parts = raw.split('.');
    return {
      kind: 'unknown-table',
      identifier: parts[parts.length - 1],
      qualifier: parts.length > 1 ? parts[parts.length - 2] : undefined,
    };
  }

  if (/syntax error|you have an error in your sql syntax/i.test(m)) return { kind: 'syntax' };
  return { kind: 'other' };
}

/// Levenshtein, capped. The cap matters: comparing a typo against 400 table
/// names times 40 columns each is a lot of cells, and anything past a small
/// distance is not a suggestion worth making anyway.
export function editDistance(a: string, b: string, max = 4): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    // Whole row already past the cap: no completion of it can come back.
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[t.length];
}

export interface Suggestion {
  name: string;
  distance: number;
  /// Where it was found, for the UI to say "on table X".
  context?: string;
}

/// Rank candidates against a mistyped identifier. Substring matches are
/// promoted ahead of pure edit distance because `id` -> `er_id` is a
/// distance of 3 but obviously right, and that shape (a prefixed key) is
/// extremely common in real schemas.
export function suggestIdentifier(
  typed: string,
  candidates: Array<{ name: string; context?: string }>,
  limit = 3,
): Suggestion[] {
  const lower = typed.toLowerCase();
  const scored: Array<Suggestion & { rank: number }> = [];

  for (const c of candidates) {
    const name = c.name.toLowerCase();
    const distance = editDistance(typed, c.name);
    const contains = name.includes(lower) || lower.includes(name);
    if (!contains && distance > 3) continue;
    // Lower rank sorts first.
    const rank = contains ? Math.min(distance, 1) : distance + 1;
    scored.push({ name: c.name, distance, context: c.context, rank });
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, distance, context }) => ({ name, distance, context }));
}
