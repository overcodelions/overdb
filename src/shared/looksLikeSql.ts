// Telling a query from a question.
//
// This gates whether ⌘↵ runs your text or offers to translate it, so it has
// to be conservative in one specific direction: mistaking SQL for English
// means overdb quietly rewrites a query you had already written correctly,
// which is far worse than mistaking English for SQL — that just produces a
// syntax error, and the error panel already offers to fix those.
//
// So the rule is deliberately blunt and explainable: if the statement opens
// with a keyword that can legally open a SQL statement, it is SQL. No
// scoring, no confidence threshold, nothing the user cannot predict.
//
// The one exception is prose that opens with a keyword anyway — "select all
// the panels that are for partners in north america" — because that is not a
// query anyone wrote correctly, it is a sentence the server can only answer
// with a syntax error. `looksLikeSqlShapedProse` below is that exception, and
// it is kept just as predictable: keyword at the front, an English word in
// the body, and not one character of SQL punctuation anywhere.

/// Keywords that can begin a statement in any dialect overdb speaks.
const LEADING_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'replace', 'merge', 'with',
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment', 'grant', 'revoke',
  'show', 'describe', 'desc', 'explain', 'analyze', 'pragma', 'set', 'use',
  'begin', 'commit', 'rollback', 'savepoint', 'start', 'call', 'do', 'values',
  'table', 'vacuum', 'reindex', 'lock', 'unlock', 'copy', 'load', 'attach', 'detach',
]);

/// Strip leading comments and whitespace so a banner comment above a query
/// doesn't make it look like prose.
function firstWord(text: string): string {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
  return m ? m[0].toLowerCase() : '';
}

export function looksLikeSql(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true; // nothing to translate
  // An opening parenthesis is a legal start for a parenthesised SELECT or a
  // UNION arm, and never how anyone phrases a question.
  if (trimmed.startsWith('(')) return true;
  return LEADING_KEYWORDS.has(firstWord(trimmed));
}

/// A question typed where SQL goes often ends in a semicolon anyway — the
/// habit comes from the last twenty statements. It is punctuation for the
/// database, not part of what you are asking, so it comes off before the
/// text is classified or sent to a model.
export function stripTrailingSemicolons(text: string): string {
  let out = text.trim();
  while (out.endsWith(';')) out = out.slice(0, -1).trimEnd();
  return out;
}

/// Punctuation that only shows up in SQL. Any of it and the statement is
/// taken at its word, however English the rest of it reads — the cost of
/// rewriting a query someone already wrote correctly is much higher than
/// the cost of letting prose hit a syntax error.
const SQL_PUNCTUATION = /[(),;=<>!*'"`.\[\]{}@?|%^&+\/\\-]/;

/// Words that are ordinary English and never a bare identifier in a real
/// statement. Deliberately short: every entry is a word that, if it ever
/// were someone's column name, would still have to appear in a statement
/// with no SQL punctuation anywhere in it to be mistaken for prose.
const PROSE_WORDS = new Set([
  'the', 'that', 'those', 'these', 'this', 'me', 'my', 'mine', 'we', 'our',
  'us', 'i', 'you', 'your', 'please', 'which', 'who', 'whose', 'whom',
  'every', 'everything', 'anything', 'something', 'someone', 'about', 'many',
  'much', 'are', 'were', 'was', 'been', 'their', 'there', 'here', 'want',
  'need', 'give', 'find', 'tell', 'each', 'good', 'best', 'worst',
]);

/// Prose that happens to open with a SQL keyword.
///
/// "select all the panels that are for partners in north america" opens with
/// SELECT, so the blunt rule above calls it SQL, and the server then answers
/// with a syntax error for a sentence that was never a query. This is the
/// narrow escape hatch: keyword at the front, not one character of SQL
/// punctuation anywhere, and an English word in the body that no schema
/// would produce. All three, or it is treated as the query it claims to be.
export function looksLikeSqlShapedProse(text: string): boolean {
  const trimmed = stripTrailingSemicolons(text);
  if (!looksLikeSql(trimmed)) return false; // the plain rule already has it
  if (SQL_PUNCTUATION.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Four words, because the short statements are the real ones: `show
  // tables`, `select 1`, `commit`. Nobody phrases a request in three.
  if (words.length < 4) return false;
  return words.slice(1).some((w) => PROSE_WORDS.has(w.toLowerCase()));
}

/// A question worth translating: not SQL, and long enough to be a request
/// rather than a stray word or a half-typed identifier.
export function looksLikeQuestion(text: string): boolean {
  const trimmed = stripTrailingSemicolons(text);
  if (!trimmed) return false;
  if (trimmed.split(/\s+/).filter(Boolean).length < 3) return false;
  // Every line, not just the first. Dragging a selection across two
  // statements usually starts inside the comment above the first one, and
  // starting AFTER the dashes ("find me all the clients...") leaves a blob
  // that opens with a word no dialect knows — so it reads as prose while
  // two finished queries sit underneath it. Translating that rewrites work
  // the user had already done, which is the one direction this file is not
  // allowed to be wrong in.
  return !trimmed
    .split('\n')
    .some((line) => line.trim() !== '' && looksLikeSql(line) && !looksLikeSqlShapedProse(line));
}
