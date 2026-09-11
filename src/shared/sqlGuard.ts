// Splitting SQL into statements, and classifying what each one does.
//
// READ THIS BEFORE RELYING ON IT FOR SAFETY: classification here is a UX
// affordance, not a security boundary. Its job is to let overdb say "that's
// a write — arm it?" instead of surfacing a raw driver error. The ACTUAL
// read-only guarantee comes from the server: `BEGIN READ ONLY` on Postgres,
// `START TRANSACTION READ ONLY` on MySQL, and SQLite's readOnly open flag.
// If this file and the server ever disagree, the server is right.
//
// The splitter, by contrast, does have to be correct — running half a
// string literal as a statement would be a genuine bug — so it is a real
// character scanner rather than `sql.split(';')`, which breaks on the first
// semicolon inside a string, a comment, or a Postgres dollar-quoted body.

import type { Engine } from './types';

export interface Statement {
  sql: string;
  /// Offset into the original text, so an error can be pointed at the
  /// statement that caused it rather than at the top of the editor.
  start: number;
  end: number;
}

export type StatementKind = 'read' | 'write' | 'ddl' | 'txn' | 'unknown';

/// Split on semicolons that are actually statement terminators.
export function splitStatements(sql: string, engine: Engine = 'postgres'): Statement[] {
  const out: Statement[] = [];
  const mysql = engine === 'mysql';
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (!raw.trim()) return;
    // Offsets bound the TRIMMED text. Whitespace between statements belongs
    // to neither of them, and including it means replacing a statement eats
    // the newline that separated it from the last — which silently welds two
    // statements onto one line.
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    out.push({ sql: raw.trim(), start: start + lead, end: end - trail });
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comments. MySQL also treats `#` as one, and requires `-- ` (with
    // a space) — but treating a bare `--` as a comment everywhere is the
    // safer error, since the alternative is executing comment text.
    if ((ch === '-' && next === '-') || (mysql && ch === '#')) {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // Single-quoted string. Both dialects escape a quote by doubling it;
    // MySQL additionally honours backslash escapes.
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (mysql && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Double quotes are identifiers in Postgres/SQLite and strings in
    // MySQL's default mode. Either way, skip to the close.
    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (mysql && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // MySQL backtick identifier.
    if (ch === '`') {
      i += 1;
      while (i < sql.length && sql[i] !== '`') i += 1;
      i += 1;
      continue;
    }

    // Postgres dollar quoting: $$ … $$ or $tag$ … $tag$. A function body
    // is full of semicolons, and this is the only thing that keeps them
    // from being read as terminators.
    if (ch === '$' && !mysql) {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        i = close < 0 ? sql.length : close + marker.length;
        continue;
      }
    }

    if (ch === ';') {
      push(i);
      i += 1;
      start = i;
      continue;
    }

    i += 1;
  }

  push(sql.length);
  return out;
}

/// Where a REPLACEMENT for a statement has to end.
///
/// `splitStatements` bounds the trimmed text, so `end` stops before the
/// terminating semicolon — correct, because the semicolon separates
/// statements rather than belonging to one. But everything that swaps a
/// statement for another one (a translation, a refine) writes its own
/// terminator, and overwriting only [start, end) leaves the old semicolon
/// stranded on a line by itself. This is the span to overwrite instead.
export function replaceEnd(sql: string, end: number): number {
  let i = end;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  return sql[i] === ';' ? i + 1 : end;
}

/// Strip comments and leading whitespace so classification sees the first
/// real keyword rather than a banner comment.
function firstKeyword(sql: string): string {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (sql[i] === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
  return m ? m[0].toLowerCase() : '';
}

const READ = new Set(['select', 'show', 'describe', 'desc', 'explain', 'analyze', 'pragma', 'values', 'table']);
const WRITE = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'upsert', 'copy', 'load', 'call', 'do']);
const DDL = new Set(['create', 'alter', 'drop', 'truncate', 'rename', 'comment', 'grant', 'revoke', 'vacuum', 'reindex']);
const TXN = new Set(['begin', 'commit', 'rollback', 'start', 'savepoint', 'set', 'use', 'lock', 'unlock']);

export function classify(sql: string): StatementKind {
  const head = firstKeyword(sql);
  if (!head) return 'unknown';

  // A CTE is only a read if its body is. `WITH x AS (DELETE … RETURNING *)
  // SELECT …` opens with `with` and mutates, which is precisely the case a
  // naive first-keyword check gets wrong.
  if (head === 'with') {
    return /\b(insert|update|delete|merge)\b/i.test(stripStrings(sql)) ? 'write' : 'read';
  }

  // `SELECT … FOR UPDATE` takes row locks; calling it a plain read would
  // let it through a read-only gate that should have questioned it.
  if (head === 'select') {
    return /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(stripStrings(sql))
      ? 'write'
      : 'read';
  }

  if (READ.has(head)) return 'read';
  if (WRITE.has(head)) return 'write';
  if (DDL.has(head)) return 'ddl';
  if (TXN.has(head)) return 'txn';
  return 'unknown';
}

/// Blank out string bodies so a keyword mentioned inside a literal — an
/// error message containing the word "delete", say — can't be mistaken for
/// the statement doing one.
function stripStrings(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

/// True when the batch contains anything the server would refuse inside a
/// read-only transaction. Drives the "arm writes?" prompt, nothing more.
export function needsWriteAccess(statements: Statement[]): boolean {
  return statements.some((s) => {
    const kind = classify(s.sql);
    return kind === 'write' || kind === 'ddl';
  });
}

/// The statement the cursor sits in. Offsets are already tracked by the
/// splitter, so this is a lookup — and it is what makes Run mean "run what
/// I am looking at" rather than "run everything in the file", which is the
/// behaviour every other client has and the one that avoids nasty surprises
/// when a buffer holds a scratch query above a real one.
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  if (statements.length === 0) return undefined;
  for (const s of statements) {
    // `end` sits just past the trimmed text, and a cursor resting there —
    // or on the terminating semicolon — still belongs to this statement.
    if (offset >= s.start && offset <= s.end + 1) return s;
  }
  // In the whitespace between statements: belong to the one just above,
  // which is where the cursor was typing.
  let best: Statement | undefined;
  for (const s of statements) if (s.start <= offset) best = s;
  return best ?? statements[0];
}


/// How much damage a statement can do, which is a different question from
/// whether it writes. `DELETE` and `UPDATE` are both writes, and only one of
/// them can lose you something you cannot get back — so the progress bar
/// colours by this, not by `classify`.
export type Severity = 'destructive' | 'mutating' | 'read';

const DESTRUCTIVE = new Set(['delete', 'drop', 'truncate']);
const MUTATING = new Set([
  'update', 'insert', 'replace', 'merge', 'upsert',
  'alter', 'create', 'rename', 'grant', 'revoke', 'call',
]);

export function severity(sql: string): Severity {
  const head = firstKeyword(sql);
  if (!head) return 'read';

  // A data-modifying CTE opens with `with` and can carry any of these, so
  // the body decides — the same reasoning classify() uses.
  if (head === 'with') {
    const body = stripStrings(sql);
    if (/\b(delete|truncate|drop)\b/i.test(body)) return 'destructive';
    if (/\b(insert|update|merge)\b/i.test(body)) return 'mutating';
    return 'read';
  }

  if (DESTRUCTIVE.has(head)) return 'destructive';
  if (MUTATING.has(head)) return 'mutating';
  // `SELECT … FOR UPDATE` takes locks but changes nothing, so it stays a
  // read here even though classify() calls it a write.
  return 'read';
}

/// The past-tense verb for "N rows ___", so a finished write reports what it
/// did rather than the useless "0 rows" a write always returns.
///
/// Falls back to "affected" whenever the verb is not obvious — a CALL, a
/// data-modifying CTE, a dialect we did not enumerate. "3 rows affected" is
/// vague but never wrong, and guessing "deleted" for a procedure that
/// inserted would be worse than vague.
export function affectedVerb(sql: string): string {
  switch (firstKeyword(sql)) {
    case 'delete':
      return 'deleted';
    case 'update':
      return 'updated';
    case 'insert':
      return 'inserted';
    case 'replace':
      return 'replaced';
    case 'truncate':
      return 'truncated';
    default:
      return 'affected';
  }
}
