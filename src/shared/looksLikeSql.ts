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

/// A question worth translating: not SQL, and long enough to be a request
/// rather than a stray word or a half-typed identifier.
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (looksLikeSql(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= 3;
}
