// The WHERE clause, as the server actually attached it to a step.
//
// `filtered` says how much a step's condition throws away. It never says
// WHICH part of the condition did it, and "0.5% survives" is a number you
// can do nothing with until you know whether the 0.5% came from
// `pending_customer_approval = 0` or from six `IN (SELECT …)` predicates.
//
// MySQL does tell us, in `attached_condition`: the exact expression it
// evaluates against every row this step reads, after any index has already
// narrowed things down. It arrives as one enormous line — the statement
// that prompted this attaches a 4,000-character condition to `partner0_` —
// so it is split into the parts it is AND-ed from, and each part is
// classified by what kind of work it represents.
//
// WHAT THIS CANNOT DO, and must not pretend to: the server reports ONE
// `filtered` for the whole condition. There is no per-predicate selectivity
// in a plan, and attributing a share of the drop to any single part here
// would be a number we made up. This says what is being evaluated. How much
// each part removes is a question only counting rows can answer.

export type ConditionKind =
  /// Contains a subquery — the expensive kind, because each one is a
  /// materialized table probed per row.
  | 'subquery'
  /// A run of alternatives OR-ed together. Worth its own kind: an OR is
  /// why an index cannot be used for the whole predicate.
  | 'alternatives'
  /// `x IS NULL` / `x IS NOT NULL`.
  | 'null'
  /// An ordinary comparison against a constant or another column.
  | 'compare'
  | 'other';

export interface Conjunct {
  /// The part, tidied for reading: schema qualifiers dropped, whitespace
  /// collapsed. Never re-ordered or re-written — it is evidence.
  text: string;
  kind: ConditionKind;
  /// For `alternatives`, how many branches are OR-ed together.
  branches?: number;
}

/// Strip the parentheses that wrap the whole expression and nothing else.
///
/// MySQL wraps generously — `((a = 1) and (b = 2))` — and a splitter that
/// does not unwrap first finds no top-level `and` at all and reports the
/// entire condition as one part.
function unwrap(text: string): string {
  let s = text.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth += 1;
      else if (s[i] === ')') {
        depth -= 1;
        // Closed before the end: these are two adjacent groups, not one
        // wrapper — `(a) and (b)` must not lose its parentheses.
        if (depth === 0 && i < s.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/// Split on a top-level keyword, ignoring anything nested or quoted.
function splitOn(text: string, keyword: 'and' | 'or'): string[] {
  const parts: string[] = [];
  const lower = text.toLowerCase();
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      // Doubled quotes are an escaped quote, not the end of the string.
      if (c === quote && text[i + 1] === quote) i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '<') depth += 1;
    else if (c === ')' || c === '>') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      lower.startsWith(keyword, i) &&
      // A word, not the tail of `brand` or the head of `android`.
      !/[\w$.`]/.test(text[i - 1] ?? ' ') &&
      !/[\w$.`]/.test(text[i + keyword.length] ?? ' ')
    ) {
      parts.push(text.slice(start, i));
      i += keyword.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => unwrap(p)).filter((p) => p.length > 0);
}

/// `` `acme`.`partner0_`.`exclude_reports` `` → `partner0_.exclude_reports`.
///
/// The schema is the same for every column in the statement and costs a
/// third of the width of every line it appears on.
function tidy(text: string): string {
  return text
    .replace(/`([^`]+)`\.`([^`]+)`\.`([^`]+)`/g, '$2.$3')
    .replace(/`([^`]+)`\.`([^`]+)`/g, '$1.$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const SUBQUERY = /<in_optimizer>|<materialize>|<exists>|\bselect\b|<primary_index_lookup>|<subquery\d*>/i;

function classify(text: string, branches: number): ConditionKind {
  if (SUBQUERY.test(text)) return 'subquery';
  if (branches > 1) return 'alternatives';
  if (/\bis\s+(not\s+)?null\b/i.test(text)) return 'null';
  if (/(<=>|<>|!=|>=|<=|=|<|>|\blike\b|\bin\b|\bbetween\b)/i.test(text)) return 'compare';
  return 'other';
}

/// The parts a step's condition is AND-ed from, in the order the server
/// wrote them. An empty list means there was nothing to split — either no
/// condition was attached, or it is a single indivisible predicate.
export function splitCondition(condition: string | undefined): Conjunct[] {
  if (!condition || !condition.trim()) return [];
  return splitOn(unwrap(condition), 'and').map((part) => {
    const branches = splitOn(part, 'or').length;
    return {
      text: tidy(part),
      kind: classify(part, branches),
      ...(branches > 1 ? { branches } : {}),
    };
  });
}

/// How to describe a part in the three words next to it.
export function kindLabel(kind: ConditionKind): string {
  switch (kind) {
    case 'subquery':
      return 'runs a subquery per row';
    case 'alternatives':
      return 'OR — no index can cover it';
    case 'null':
      return 'null check';
    case 'compare':
      return 'compared per row';
    default:
      return 'evaluated per row';
  }
}
