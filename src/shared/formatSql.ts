// A light SQL formatter.
//
// Deliberately deterministic rather than asking the model to format nicely:
// a model asked for a layout complies most of the time, and "most of the
// time" is exactly what makes generated code annoying to read. This gives
// the same shape every time, for translated SQL and hand-written alike.
//
// It is a reformatter, not a parser. It never reorders or rewrites anything
// — it only decides where the line breaks go — and it will not touch the
// inside of a string literal or a comment.

/// Clauses that start a new line at the top level.
const CLAUSES = [
  'select', 'from', 'where', 'group by', 'having', 'order by', 'limit', 'offset',
  'union all', 'union', 'intersect', 'except', 'values', 'set', 'returning',
  'inner join', 'left outer join', 'right outer join', 'full outer join',
  'left join', 'right join', 'full join', 'cross join', 'straight_join', 'join',
  'on', 'using', 'insert into', 'update', 'delete from',
];

/// Sorted longest-first so `left outer join` wins over `left join` and
/// `join`, and `union all` over `union`.
const ORDERED = [...CLAUSES].sort((a, b) => b.length - a.length);

/// Clauses whose body is indented under them rather than sitting inline —
/// but only when the body is actually a list. `SELECT *` on two lines is
/// just noise.
const INDENT_BODY = new Set(['select', 'set', 'values', 'returning']);

interface Token {
  text: string;
  kind: 'word' | 'string' | 'comment' | 'punct' | 'space';
}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (text: string, kind: Token['kind']) => text && out.push({ text, kind });

  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      const start = i;
      while (i < sql.length && /\s/.test(sql[i])) i += 1;
      push(sql.slice(start, i), 'space');
      continue;
    }
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      const start = i;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      push(sql.slice(start, i), 'comment');
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      push(sql.slice(start, Math.min(i, sql.length)), 'comment');
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      push(sql.slice(start, i), 'string');
      continue;
    }
    // Numbers before the identifier rule: without this each digit falls
    // through to the punctuation branch and `10` is emitted as `1 0`.
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/.exec(sql.slice(i))!;
      push(m[0], 'word');
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_][A-Za-z0-9_$.]*/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$.]*/.exec(sql.slice(i))!;
      push(m[0], 'word');
      i += m[0].length;
      continue;
    }
    // Multi-character operators MUST be emitted whole. Falling through to
    // the single-char branch turns `!=` into `! =`, which is not ugly
    // formatting, it is a syntax error the user then has to debug.
    const op = /^(?:!=|<>|<=|>=|\|\||::|->>|->|<<|>>|:=|=>)/.exec(sql.slice(i));
    if (op) {
      push(op[0], 'punct');
      i += op[0].length;
      continue;
    }
    push(ch, 'punct');
    i += 1;
  }
  return out;
}

/// Match a multi-word clause starting at token index `i`, ignoring spaces.
/// True when the clause body starting at `from` contains a top-level comma
/// before the next top-level clause — i.e. it is a list worth breaking up.
/// `SELECT *` and `SELECT count(*)` are not.
function bodyIsList(tokens: Token[], from: number): boolean {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'space' || t.kind === 'comment') continue;
    if (t.kind === 'punct') {
      if (t.text === '(') depth += 1;
      else if (t.text === ')') depth = Math.max(0, depth - 1);
      else if (t.text === ',' && depth === 0) return true;
      else if (t.text === ';' && depth === 0) return false;
      continue;
    }
    if (depth === 0 && matchClause(tokens, i)) return false;
  }
  return false;
}

function matchClause(tokens: Token[], i: number): { clause: string; next: number } | null {
  if (tokens[i].kind !== 'word') return null;
  for (const clause of ORDERED) {
    const parts = clause.split(' ');
    let k = i;
    let ok = true;
    for (const part of parts) {
      while (k < tokens.length && tokens[k].kind === 'space') k += 1;
      if (k >= tokens.length || tokens[k].kind !== 'word' || tokens[k].text.toLowerCase() !== part) {
        ok = false;
        break;
      }
      k += 1;
    }
    if (ok) return { clause, next: k };
  }
  return null;
}

/// Operators that bind their operands tight: `a::text`, `j->'k'`. Spacing
/// these like a comparison reads as three separate things.
const TIGHT_OPERATORS = new Set(['::', '->', '->>']);

export function formatSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return trimmed;

  const tokens = tokenize(trimmed);
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  let indentBody = false;

  const flush = () => {
    const text = line.replace(/\s+$/, '');
    if (text) lines.push(text);
    line = '';
  };
  let lastWasTight = false;
  const append = (text: string) => {
    const tight = TIGHT_OPERATORS.has(text);
    if (!line) line = text;
    else if (tight || lastWasTight) line += text;
    // No space before a closing bracket, comma or semicolon — and none
    // before an opening bracket that follows an identifier, or every
    // function call comes out as `coalesce (a, b)`.
    else if (/[\s(]$/.test(line) || /^[),;]/.test(text)) line += text;
    else if (text === '(' && /[A-Za-z0-9_$]$/.test(line)) line += text;
    // A qualifier ends with a dot and binds tight to whatever follows:
    // `pw.` + `*` is `pw.*`, never `pw. *`.
    else if (/\.$/.test(line)) line += text;
    else line += ` ${text}`;
    lastWasTight = tight;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'space') continue;

    // Leading comments stay on their own line, untouched.
    if (token.kind === 'comment') {
      flush();
      lines.push(token.text.trim());
      continue;
    }

    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1;
      else if (token.text === ')') depth = Math.max(0, depth - 1);
      // A comma inside the indented body of SELECT / SET breaks the line —
      // one column per line is the whole point of the layout.
      if (token.text === ',' && depth === 0 && indentBody) {
        append(',');
        flush();
        // Carry the indent onto the next column, rather than dropping it
        // back to column 0 after the first one.
        line = '  ';
        continue;
      }
      append(token.text);
      continue;
    }

    // Clause keywords only break at the TOP level; a SELECT inside a
    // subquery stays where it is rather than unindenting to column 0.
    if (depth === 0) {
      const hit = matchClause(tokens, i);
      if (hit) {
        flush();
        const words = tokens
          .slice(i, hit.next)
          .filter((t) => t.kind === 'word')
          .map((t) => t.text.toUpperCase())
          .join(' ');
        // AND / OR under WHERE and ON read better indented; clause keywords
        // themselves sit at column 0.
        line = words;
        indentBody = INDENT_BODY.has(hit.clause) && bodyIsList(tokens, hit.next);
        if (indentBody) {
          flush();
          line = '  ';
        }
        i = hit.next - 1;
        continue;
      }
      const lower = token.text.toLowerCase();
      if ((lower === 'and' || lower === 'or') && !indentBody) {
        flush();
        line = `  ${token.text.toUpperCase()}`;
        continue;
      }
    }

    append(token.text);
  }
  flush();

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/// Statements need their terminator. Without one, the next thing typed
/// below joins the SAME statement — which is how a question typed under
/// generated SQL ends up inside it and reaches the server as a syntax
/// error, blaming a line the user did not write.
export function ensureTerminated(sql: string): string {
  const trimmed = sql.trimEnd();
  if (!trimmed) return trimmed;
  return /;$/.test(trimmed) ? trimmed : `${trimmed};`;
}
