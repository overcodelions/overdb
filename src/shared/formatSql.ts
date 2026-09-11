// A SQL formatter with five named layouts.
//
// Deliberately deterministic rather than asking the model to format nicely:
// a model asked for a layout complies most of the time, and "most of the
// time" is exactly what makes generated code annoying to read. The same SQL
// gives the same shape every time, translated or hand-written.
//
// It is a reformatter, not a parser. It never reorders or rewrites anything
// -- it only decides where the line breaks and the spaces go -- and it will
// not touch the inside of a string literal or a comment.
//
// Which layout reads best is genuinely a matter of taste, and taste is a
// setting, not a default someone else picks for you. These five are the
// layouts SQL formatters have converged on; the names are the ones people
// already use for them.

export type FormatStyle =
  | 'collapsed'
  | 'commas-before'
  | 'default'
  | 'indented'
  | 'right-aligned';

export const FORMAT_STYLES: Array<{ id: FormatStyle; label: string; blurb: string }> = [
  { id: 'collapsed', label: 'Collapsed', blurb: 'One line per clause, nothing wrapped. Fewest lines.' },
  { id: 'commas-before', label: 'Commas before', blurb: 'Leading commas, so adding or cutting a column never touches the line above.' },
  { id: 'default', label: 'Default', blurb: 'Trailing commas, list aligned under the first item.' },
  { id: 'indented', label: 'Indented', blurb: 'Every keyword alone on its line, its body indented beneath.' },
  { id: 'right-aligned', label: 'Right aligned', blurb: 'Keywords right-aligned into a gutter, so keywords and arguments each form one straight edge.' },
];

interface StyleSpec {
  /// Right-aligned puts keywords in a gutter whose width is the longest
  /// keyword in the statement; every other style starts them at column 0.
  gutter: boolean;
  /// How a comma-separated clause body is laid out.
  list: 'inline' | 'trailing' | 'leading' | 'own-line';
  /// Indent of a body that sits on its own line ('own-line' lists, and the
  /// FROM target under `indented`).
  bodyIndent: number;
  /// Indent of a JOIN keyword.
  joinIndent: number;
  /// Whether the joined table sits on the JOIN line or beneath it.
  joinTarget: 'inline' | 'own-line';
  /// Whether ON sits on the JOIN line or beneath it, and how far in.
  on: 'inline' | 'own-line';
  onIndent: number;
  /// Collapsed squeezes comparisons: `a=1`, `ON(...)`.
  tight: boolean;
  /// Right-aligned also lines up the `=` across a statement's ON clauses.
  alignOn: boolean;
}

const SPECS: Record<FormatStyle, StyleSpec> = {
  collapsed: {
    gutter: false, list: 'inline', bodyIndent: 0, joinIndent: 5,
    joinTarget: 'inline', on: 'inline', onIndent: 0, tight: true, alignOn: false,
  },
  'commas-before': {
    gutter: false, list: 'leading', bodyIndent: 4, joinIndent: 4,
    joinTarget: 'inline', on: 'own-line', onIndent: 8, tight: false, alignOn: false,
  },
  default: {
    gutter: false, list: 'trailing', bodyIndent: 4, joinIndent: 4,
    joinTarget: 'inline', on: 'own-line', onIndent: 8, tight: false, alignOn: false,
  },
  indented: {
    gutter: false, list: 'own-line', bodyIndent: 4, joinIndent: 4,
    joinTarget: 'own-line', on: 'own-line', onIndent: 12, tight: false, alignOn: false,
  },
  'right-aligned': {
    gutter: true, list: 'trailing', bodyIndent: 4, joinIndent: 0,
    joinTarget: 'inline', on: 'own-line', onIndent: 0, tight: false, alignOn: true,
  },
};

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

/// Clauses whose body is a list worth breaking up -- but only when it
/// actually is one. `SELECT *` on two lines is just noise.
const LIST_CLAUSES = new Set(['select', 'set', 'values', 'returning']);

const JOIN_CLAUSES = new Set([
  'join', 'inner join', 'left join', 'right join', 'full join', 'cross join',
  'left outer join', 'right outer join', 'full outer join', 'straight_join',
]);

/// Operators that bind their operands tight: `a::text`, `j->'k'`. Spacing
/// these like a comparison reads as three separate things.
const TIGHT_OPERATORS = new Set(['::', '->', '->>']);

/// Comparisons, which `collapsed` squeezes and every other style spaces.
const COMPARISONS = new Set(['=', '<', '>', '<=', '>=', '<>', '!=']);

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

interface Line {
  indent: number;
  text: string;
}

/// The next token that is not whitespace, for the handful of decisions that
/// depend on what comes after the one in hand.
function nextSignificant(tokens: Token[], from: number): Token | undefined {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].kind !== 'space') return tokens[i];
  }
  return undefined;
}

/// The widest clause keyword in the statement, which is what the
/// right-aligned gutter is measured against. Computed rather than fixed:
/// with GROUP BY in the statement the gutter is 8, without it 6, and a
/// fixed width would leave a ragged edge either way.
function gutterWidth(tokens: Token[]): number {
  let widest = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.text === '(') depth += 1;
      else if (t.text === ')') depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.kind !== 'word' || depth > 0) continue;
    const hit = matchClause(tokens, i);
    if (hit) widest = Math.max(widest, hit.clause.length);
  }
  return widest;
}

/// How long the group opening at `open` is, and whether it is a condition
/// group at all.
///
/// The formatter is single-pass, so deciding whether to break inside a
/// bracket needs this one look ahead: a short `(a = 1 AND b = 2)` reads
/// better on one line, and an `in (…)` list must never be broken on its
/// commas by the AND rule. Hibernate emits the shape this exists for —
/// `where(a = 0 AND b = 0 AND c <> 26) and(d is not null)` — which the old
/// pass left as one 300-character line.
function groupSpan(
  tokens: Token[],
  open: number,
): { end: number; length: number; connectors: number } {
  let depth = 0;
  let length = 0;
  let connectors = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'space') {
      length += 1;
      continue;
    }
    length += t.text.length;
    if (t.kind === 'punct') {
      if (t.text === '(') depth += 1;
      else if (t.text === ')') {
        depth -= 1;
        if (depth === 0) return { end: i, length, connectors };
      }
    } else if (t.kind === 'word' && depth === 1) {
      const w = t.text.toLowerCase();
      if (w === 'and' || w === 'or') connectors += 1;
    }
  }
  return { end: tokens.length - 1, length, connectors };
}

/// Past this, a bracketed condition group earns its own lines.
const GROUP_BREAK_AT = 66;

export function formatSql(sql: string, style: FormatStyle = 'default'): string {
  const trimmed = sql.trim();
  if (!trimmed) return trimmed;

  const spec = SPECS[style];
  const tokens = tokenize(trimmed);
  const gutter = spec.gutter ? gutterWidth(tokens) : 0;

  const lines: Line[] = [];
  let indent = 0;
  let line = '';
  let depth = 0;
  /// The clause we are inside, so a comma knows whether it breaks.
  let inList = false;
  /// Column the current clause's arguments start at, for list continuation
  /// and for right-aligning AND / OR beneath them.
  let bodyColumn = 0;
  /// One entry per open bracket: whether its conditions break onto their own
  /// lines, and the column they align to.
  const groups: Array<{ breaking: boolean; column: number }> = [];
  let lastWasTight = false;

  const flush = () => {
    const text = line.replace(/\s+$/, '');
    if (text) lines.push({ indent, text });
    line = '';
  };

  const append = (text: string) => {
    const tight = TIGHT_OPERATORS.has(text) || (spec.tight && COMPARISONS.has(text));
    if (!line) line = text;
    else if (tight || lastWasTight) line += text;
    // No space before a closing bracket, comma or semicolon -- and none
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

  /// `SELECT ` / `  FROM ` -- the keyword plus whatever puts its arguments
  /// in the right column.
  const openClause = (keyword: string): void => {
    if (spec.gutter) {
      const pad = Math.max(0, gutter - keyword.length);
      indent = 0;
      line = `${' '.repeat(pad)}${keyword} `;
      bodyColumn = gutter + 1;
      return;
    }
    indent = 0;
    line = `${keyword} `;
    bodyColumn = keyword.length + 1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'space') continue;

    // Leading comments stay on their own line, untouched.
    if (token.kind === 'comment') {
      flush();
      indent = 0;
      lines.push({ indent: 0, text: token.text.trim() });
      continue;
    }

    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1;
        const span = groupSpan(tokens, i);
        groups.push({
          // A long group with connectors in it is a condition worth
          // breaking; a function call or a short one is not.
          breaking:
            spec.list !== 'inline' &&
            span.connectors > 0 &&
            span.length > GROUP_BREAK_AT,
          // The column just after the bracket, so the conditions inside and
          // the connectors joining them share one left edge.
          column: indent + line.length + 1,
        });
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
        groups.pop();
      }

      if (token.text === ',' && depth === 0 && inList) {
        if (spec.list === 'trailing' || spec.list === 'own-line') {
          append(',');
          flush();
          indent = spec.list === 'own-line' ? spec.bodyIndent : bodyColumn;
          continue;
        }
        if (spec.list === 'leading') {
          flush();
          // The comma hangs left of the column the items sit in, so the
          // item text still lines up with the first one.
          indent = Math.max(0, bodyColumn - 2);
          line = ', ';
          continue;
        }
      }
      append(token.text);
      continue;
    }

    // A connector inside a bracketed condition group breaks wherever the
    // group does — including inside a subquery, which is where the worst
    // one-liners live.
    if (depth > 0 && token.kind === 'word') {
      const lower = token.text.toLowerCase();
      const group = groups[groups.length - 1];
      if ((lower === 'and' || lower === 'or') && group?.breaking) {
        flush();
        indent = group.column;
        line = `${token.text.toUpperCase()} `;
        continue;
      }
    }

    // Clause keywords only break at the TOP level; a SELECT inside a
    // subquery stays where it is rather than unindenting to column 0.
    if (depth === 0) {
      const hit = matchClause(tokens, i);
      if (hit) {
        const words = tokens
          .slice(i, hit.next)
          .filter((t) => t.kind === 'word')
          .map((t) => t.text.toUpperCase())
          .join(' ');

        // An inline ON belongs to the JOIN line it is part of, so it must
        // be appended BEFORE that line is flushed — flushing first is what
        // put `ON(...)` on a line of its own under Collapsed, whose whole
        // point is not doing that.
        if ((hit.clause === 'on' || hit.clause === 'using') && spec.on === 'inline') {
          append(words);
          // Collapsed writes `ON(a=b)` — but only against an actual
          // bracket. Tightening unconditionally welded ON to a bare
          // condition: `ONc.client_id = pw.client_id`.
          if (spec.tight && nextSignificant(tokens, hit.next)?.text === '(') lastWasTight = true;
          inList = false;
          i = hit.next - 1;
          continue;
        }

        flush();
        i = hit.next - 1;

        if (JOIN_CLAUSES.has(hit.clause)) {
          if (spec.gutter) {
            indent = 0;
            line = `${' '.repeat(Math.max(0, gutter - words.length))}${words} `;
            bodyColumn = gutter + 1;
          } else {
            indent = spec.joinIndent;
            line = `${words} `;
            bodyColumn = spec.joinIndent + words.length + 1;
          }
          if (spec.joinTarget === 'own-line') {
            flush();
            indent = spec.joinIndent + spec.bodyIndent;
            bodyColumn = indent;
          }
          inList = false;
          continue;
        }

        if (hit.clause === 'on' || hit.clause === 'using') {
          if (spec.gutter) {
            indent = 0;
            line = `${' '.repeat(Math.max(0, gutter - words.length))}${words} `;
            bodyColumn = gutter + 1;
          } else {
            indent = spec.onIndent;
            line = `${words} `;
            bodyColumn = spec.onIndent + words.length + 1;
          }
          inList = false;
          continue;
        }

        openClause(words);
        inList = LIST_CLAUSES.has(hit.clause) && bodyIsList(tokens, hit.next);

        // `indented` puts EVERY clause body on its own line, list or not.
        if (spec.list === 'own-line') {
          flush();
          indent = spec.bodyIndent;
          bodyColumn = spec.bodyIndent;
          inList = LIST_CLAUSES.has(hit.clause) && bodyIsList(tokens, hit.next);
        }
        continue;
      }

      const lower = token.text.toLowerCase();
      const group = groups[groups.length - 1];
      if ((lower === 'and' || lower === 'or') && group?.breaking) {
        flush();
        indent = group.column;
        line = `${token.text.toUpperCase()} `;
        continue;
      }
      if ((lower === 'and' || lower === 'or') && !inList) {
        // Collapsed keeps the whole condition on one line; that is the
        // point of it.
        if (spec.list === 'inline') {
          append(token.text.toUpperCase());
          continue;
        }
        flush();
        const word = token.text.toUpperCase();
        if (spec.list === 'own-line') {
          indent = bodyColumn;
          line = `${word} `;
        } else {
          // Right-aligned INTO the body column, so the conditions the
          // connector joins stay in one column:
          //     WHERE status = 'open'
          //       AND created_at > now()
          const pad = Math.max(0, bodyColumn - 1 - word.length);
          indent = pad;
          line = `${word} `;
        }
        continue;
      }
    }

    append(token.text);
  }
  flush();

  const rendered = lines.map((l) => `${' '.repeat(l.indent)}${l.text}`.replace(/\s+$/, ''));
  return (
    (spec.alignOn ? alignOnClauses(rendered) : rendered)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      // Blank lines off both ends, but NOT a plain trim: under the
      // right-aligned layout the first line legitimately starts with
      // spaces, and trimming ate them wherever SELECT was not the widest
      // keyword in the statement.
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\s+$/, '')
  );
}

/// Line up the `=` across a statement's ON clauses. Two joins whose
/// conditions differ in length read as one shape when the equals signs
/// share a column, and as two unrelated lines when they do not.
function alignOnClauses(lines: string[]): string[] {
  const ON = /^(\s*ON\s*\(?\s*)(\S+)(\s*)=(\s*)(.*)$/;
  const hits: Array<{ index: number; m: RegExpMatchArray }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ON.exec(lines[i]);
    if (m) hits.push({ index: i, m });
  }
  if (hits.length < 2) return lines;
  const widest = Math.max(...hits.map((h) => h.m[2].length));
  const out = [...lines];
  for (const h of hits) {
    const [, head, left, , , rest] = h.m;
    out[h.index] = `${head}${left}${' '.repeat(widest - left.length)} = ${rest}`;
  }
  return out;
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
