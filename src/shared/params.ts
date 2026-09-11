// Placeholders in pasted SQL, and where their values come from.
//
// The SQL people paste into overdb rarely comes from overdb. It comes out
// of an ORM log, a slow-query report, a JIRA ticket — and it arrives with
// the values already taken out of it:
//
//     WHERE c.client_name = ?          -- JDBC, MyBatis, ActiveRecord
//     WHERE c.client_name = :clientName -- JPA, JDBI, SQLAlchemy
//     WHERE c.client_name = #{clientName} -- MyBatis
//
// Both spellings are the same question, so both are handled here, and the
// answer travels as a BOUND PARAMETER rather than as string substitution.
// That is the whole reason this file exists rather than a find-and-replace:
// pasting `hp'; DROP TABLE ...` into a value box must be a value, not SQL.
//
// The second half of the file is the part that makes this worth having.
// A placeholder's value is usually the SAME question asked of different
// databases — "the HP client" is `hp` locally, `HP Inc` in staging, and a
// different row entirely in prod — so a binding is not one value but a
// small layered lookup: a default, an override per ENVIRONMENT, and an
// override per CONNECTION. Running the same statement across an env set
// then binds each member its own value without anybody editing the SQL.

import type { Cell, Engine, EnvKind } from './types';
import { splitStatements } from './sqlGuard';

/// How a placeholder was written. Positional ones bind in order and never
/// share a value with each other; named ones bind by name, so the same
/// name twice in a statement is one value used twice.
export type ParamStyle = 'positional' | 'named';

/// How the text typed into a value box becomes a bound value.
///
/// 'auto' is what almost everyone wants and what nothing else can be by
/// default: `42` is a number, `true` is a boolean, `null` is NULL, and
/// `007` is the string it looks like. The explicit types exist for when
/// auto guesses wrong — an account number that is all digits but must
/// stay text, a column that really does want NULL.
export type ParamType = 'auto' | 'text' | 'number' | 'boolean' | 'null' | 'list';

export interface Placeholder {
  /// Byte offsets into the statement this was scanned from.
  from: number;
  to: number;
  /// Exactly as written: `?`, `$1`, `:clientName`, `#{clientName}`.
  raw: string;
  style: ParamStyle;
  /// The slot this placeholder draws its value from. Normalised, so
  /// `:clientName`, `#{client_name}` and a `?` sitting after
  /// `c.client_name =` all land on the same one — see slotKey().
  key: string;
  /// What to call it in the UI, in the spelling it was written in.
  label: string;
  /// True when the label was worked out from the surrounding SQL rather
  /// than written by the author. Shown differently: a guess that says it
  /// is a guess is useful, and one that doesn't is a trap.
  inferred: boolean;
  /// This hole is the ENTIRE contents of an `IN (...)`, so it stands for a
  /// list rather than a value — see listPosition().
  inList: boolean;
}

/// One value box. Placeholders that share a key share a slot.
export interface ParamSlot {
  key: string;
  label: string;
  style: ParamStyle;
  /// How many placeholders in the statement this slot fills.
  count: number;
  /// The hole is an `IN (...)` on its own, so this slot wants a list.
  inList: boolean;
}

/// A remembered value for one slot, with its overrides.
///
/// Stored app-wide rather than per buffer or per connection, because the
/// value you want for `client_name` is a fact about your work and not
/// about which tab you happen to be in. What varies by connection lives in
/// the override maps below.
export interface ParamBinding {
  /// Normalised slot key — see slotKey(). The join to a placeholder.
  key: string;
  /// The spelling to show. Whatever it was called when last saved.
  label: string;
  type: ParamType;
  /// Used when nothing more specific applies.
  value: string;
  /// Per-environment overrides. The common case: same question, different
  /// answer in staging than in prod.
  byEnv?: Partial<Record<EnvKind, string>>;
  /// Per-connection overrides, by connection id. Beats byEnv, because it
  /// is the more specific statement of the two — two prod connections can
  /// still disagree.
  byConnection?: Record<string, string>;
  updatedAt?: string;
}

/// Which layer a resolved value came from. Surfaced in the UI: a value
/// that silently came from somewhere else is how you run a staging query
/// against a prod id.
export type ParamScope = 'connection' | 'env' | 'default';

export interface ResolvedParam {
  key: string;
  label: string;
  type: ParamType;
  text: string;
  scope: ParamScope;
  /// True when no binding existed at all — the box is empty and the
  /// statement cannot run yet.
  missing: boolean;
}

/// The identity of a slot.
///
/// Case and word separators are dropped on purpose. `:clientName` from a
/// JPA query and `client_name = ?` from the JDBC log of the same code are
/// the same parameter, and making you fill both in separately because one
/// is camel-case would be a worse tool than a text editor.
export function slotKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

/// Everything in `sql` that is a hole rather than a value.
///
/// Engine-aware only where the engines genuinely disagree. `?` and `:name`
/// are accepted everywhere — the point is to run SQL that was written for
/// something else — but `@name` and `$name` are only read as placeholders
/// on SQLite, because `@x` is a real user variable in MySQL and treating
/// `SET @start := NOW()` as a prompt would be absurd.
export function scanPlaceholders(sql: string, engine: Engine = 'postgres'): Placeholder[] {
  const mysql = engine === 'mysql';
  const sqlite = engine === 'sqlite';
  const out: Placeholder[] = [];
  /// Names already used, so a second `client_name = ?` in one statement
  /// gets its own box rather than silently reusing the first one's value.
  const used = new Map<string, number>();
  let positional = 0;
  let i = 0;

  const push = (from: number, to: number, style: ParamStyle, name: string, inferred: boolean) => {
    let key = slotKey(name);
    let label = name;
    if (style === 'positional') {
      // Positional holes never share. Two `?` are two questions even when
      // they sit against the same column — `BETWEEN ? AND ?` is the case
      // that makes this non-negotiable.
      const seen = (used.get(key) ?? 0) + 1;
      used.set(key, seen);
      if (seen > 1) {
        key = `${key}#${seen}`;
        label = `${label} #${seen}`;
      }
    }
    out.push({
      from, to, raw: sql.slice(from, to), style, key, label, inferred,
      inList: listPosition(sql, from, to),
    });
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // MyBatis `#{name}`, checked before MySQL's `#` line comment — the
    // whole reason someone pastes this text is that it is not a comment.
    if (ch === '#' && next === '{') {
      const close = sql.indexOf('}', i + 2);
      if (close > 0) {
        const inner = sql.slice(i + 2, close).split(',')[0].trim();
        if (inner) {
          push(i, close + 1, 'named', inner, false);
          i = close + 1;
          continue;
        }
      }
    }

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

    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, mysql);
      continue;
    }

    if (ch === '$') {
      // Postgres dollar-quoted body. A function full of `?` and `:x` is
      // still a function body.
      if (!mysql) {
        const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
        if (tag) {
          const close = sql.indexOf(tag[0], i + tag[0].length);
          i = close < 0 ? sql.length : close + tag[0].length;
          continue;
        }
      }
      // `${name}` — Spring/JDBI templating, and unambiguous enough to read
      // as a placeholder everywhere.
      if (next === '{') {
        const close = sql.indexOf('}', i + 2);
        if (close > 0) {
          const inner = sql.slice(i + 2, close).trim();
          if (inner) {
            push(i, close + 1, 'named', inner, false);
            i = close + 1;
            continue;
          }
        }
      }
      // Postgres native `$1`.
      const numbered = /^\$([0-9]+)/.exec(sql.slice(i));
      if (numbered) {
        positional += 1;
        push(i, i + numbered[0].length, 'positional', nameFor(sql, i, positional), true);
        i += numbered[0].length;
        continue;
      }
      if (sqlite && next && IDENT_START.test(next)) {
        let j = i + 1;
        while (j < sql.length && IDENT.test(sql[j])) j += 1;
        push(i, j, 'named', sql.slice(i + 1, j), false);
        i = j;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === ':') {
      // `::` is a Postgres cast and `:=` is a MySQL assignment. Neither is
      // a hole, and reading `id::text` as a parameter named `text` would
      // break the most ordinary Postgres query there is.
      if (next === ':') {
        i += 2;
        continue;
      }
      if (next && IDENT_START.test(next)) {
        let j = i + 1;
        while (j < sql.length && IDENT.test(sql[j])) j += 1;
        push(i, j, 'named', sql.slice(i + 1, j), false);
        i = j;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '@' && sqlite && next && IDENT_START.test(next)) {
      let j = i + 1;
      while (j < sql.length && IDENT.test(sql[j])) j += 1;
      push(i, j, 'named', sql.slice(i + 1, j), false);
      i = j;
      continue;
    }

    if (ch === '?') {
      // `?`, `?|` and `?&` are jsonb operators on Postgres. The operators
      // win there; a bare `?` is still read as a hole, because pasted ORM
      // SQL is the case this whole file is for.
      if (engine === 'postgres' && (next === '|' || next === '&')) {
        i += 2;
        continue;
      }
      // SQLite's numbered `?3`.
      const numbered = /^\?([0-9]+)/.exec(sql.slice(i));
      const end = numbered ? i + numbered[0].length : i + 1;
      positional += 1;
      push(i, end, 'positional', nameFor(sql, i, positional), true);
      i = end;
      continue;
    }

    i += 1;
  }

  return out;
}

/// Is this hole the whole of an `IN (...)`?
///
/// `WHERE id IN (?)` is an ORM's way of writing "however many ids I have" —
/// one hole standing for a list, which is why bindParams expands it. But
/// `WHERE id IN (?, ?, ?)` is an ORM that already expanded it, and those
/// three holes are three values. The difference is whether the parentheses
/// contain anything but this hole, so that is what is checked: an opening
/// paren immediately before, a closing one immediately after, and IN or NOT
/// IN in front of the pair.
export function listPosition(sql: string, from: number, to: number): boolean {
  let i = from - 1;
  while (i >= 0 && /\s/.test(sql[i])) i -= 1;
  if (sql[i] !== '(') return false;

  const head = sql.slice(0, i).trimEnd().toLowerCase();
  if (!/(^|[^A-Za-z0-9_])(not\s+)?in$/.test(head)) return false;

  let j = to;
  while (j < sql.length && /\s/.test(sql[j])) j += 1;
  return sql[j] === ')';
}

/// Skip a quoted run starting at `i`, returning the index after it.
function skipQuoted(sql: string, i: number, mysql: boolean): number {
  const quote = sql[i];
  let j = i + 1;
  if (quote === '`') {
    while (j < sql.length && sql[j] !== '`') j += 1;
    return j + 1;
  }
  while (j < sql.length) {
    if (mysql && sql[j] === '\\') {
      j += 2;
      continue;
    }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return j;
}

const COMPARISONS = [
  'not like', 'not ilike', 'not in', 'is not', 'like', 'ilike', 'in', 'is',
  'between', 'and', '>=', '<=', '<>', '!=', '=', '>', '<',
];

/// What to call a positional hole.
///
/// A row of boxes labelled `?1 ?2 ?3` is a puzzle. A row labelled
/// `client_name`, `status`, `created_after` is a form. So the text before
/// the placeholder is read back to the nearest comparison and the column
/// on its left is used as the label — which is also what makes a pasted
/// `?` pick up the value you already saved under `:clientName`.
///
/// A guess, and marked as one by its caller. `ordinal` is the fallback.
export function nameFor(sql: string, at: number, ordinal: number): string {
  let head = sql.slice(0, at);
  // Step back over an opening paren, so `IN (?)` reads through to `IN`.
  head = head.replace(/\s*\(\s*$/, ' ');
  const lower = head.toLowerCase();

  for (const op of COMPARISONS) {
    if (!lower.endsWith(op) && !lower.endsWith(`${op} `)) continue;
    const cut = lower.lastIndexOf(op, lower.length - 1);
    let before = head.slice(0, cut).trimEnd();
    // `created_at BETWEEN ? AND ?` — the upper bound's nearest word is the
    // AND, and behind it is the other placeholder rather than a column. Step
    // over it and ask again, so both boxes are labelled with the column
    // they filter instead of one of them falling back to an ordinal.
    const priorHole = /(\?[0-9]*|\$[0-9]+|:[A-Za-z_][A-Za-z0-9_]*|[#$]\{[^}]*\})$/.exec(before);
    if (priorHole) {
      before = before.slice(0, priorHole.index).trimEnd();
      return nameFor(`${before} `, before.length + 1, ordinal);
    }
    // `BETWEEN x AND ?` reaches back past the AND to the column, which is
    // the only reading that produces a useful label for the upper bound.
    const ident = /(?:[`"]?([A-Za-z_][A-Za-z0-9_$]*)[`"]?\s*\.\s*)?[`"]?([A-Za-z_][A-Za-z0-9_$]*)[`"]?$/.exec(
      before,
    );
    if (ident?.[2]) {
      const name = ident[2];
      if (name.toLowerCase() === 'and' || name.toLowerCase() === 'or') break;
      return name;
    }
    break;
  }
  return `param${ordinal}`;
}

/// The value boxes a statement needs, in the order they appear.
export function paramSlots(sql: string, engine: Engine = 'postgres'): ParamSlot[] {
  const slots = new Map<string, ParamSlot>();
  for (const p of scanPlaceholders(sql, engine)) {
    const existing = slots.get(p.key);
    if (existing) {
      existing.count += 1;
      existing.inList = existing.inList || p.inList;
    } else {
      slots.set(p.key, {
        key: p.key, label: p.label, style: p.style, count: 1, inList: p.inList,
      });
    }
  }
  return [...slots.values()];
}

/// Every placeholder in a whole BUFFER, with offsets into the buffer.
///
/// Scanned one statement at a time and then shifted, because a positional
/// hole's identity is its position within the statement it belongs to: the
/// second `?` of the fourth statement is that statement's second value, not
/// the buffer's ninth. Scanning the buffer as one string would key the same
/// hole differently depending on what is above it.
export function bufferPlaceholders(sql: string, engine: Engine = 'postgres'): Placeholder[] {
  const out: Placeholder[] = [];
  for (const statement of splitStatements(sql, engine)) {
    for (const hole of scanPlaceholders(statement.sql, engine)) {
      out.push({
        ...hole,
        from: hole.from + statement.start,
        to: hole.to + statement.start,
      });
    }
  }
  return out;
}

/// Does this statement need values before it can run?
export function hasPlaceholders(sql: string, engine: Engine = 'postgres'): boolean {
  return scanPlaceholders(sql, engine).length > 0;
}

export type ParamValue = Cell | Cell[];

export interface BoundStatement {
  sql: string;
  params: Cell[];
}

/// Rewrite a statement into what this engine's driver actually accepts,
/// with the values pulled out into `params`.
///
/// Nothing is substituted into the SQL text. `:clientName` becomes `$1` on
/// Postgres and `?` on MySQL, and the value travels beside it — so a value
/// containing a quote is a value containing a quote, not a syntax error or
/// an injection.
///
/// The one thing that does change shape is a list: `IN (?)` bound to three
/// values expands to `IN (?, ?, ?)`, because that is the only way an ORM's
/// single hole can ever mean more than one value.
export function bindParams(
  sql: string,
  engine: Engine,
  values: Record<string, ParamValue>,
): BoundStatement {
  const placeholders = scanPlaceholders(sql, engine);
  if (placeholders.length === 0) return { sql, params: [] };

  const numbered = engine === 'postgres';
  const params: Cell[] = [];
  /// Postgres can point two holes at one `$n`; the others have to repeat
  /// the value, since `?` is positional and nothing binds it by name.
  const assigned = new Map<string, string>();
  let out = '';
  let cursor = 0;

  for (const p of placeholders) {
    out += sql.slice(cursor, p.from);
    cursor = p.to;

    const raw = values[p.key];
    const list = Array.isArray(raw) ? raw : null;

    if (list) {
      // An empty list has no honest expansion — `IN ()` is a syntax error
      // everywhere — so it binds one NULL, which matches nothing. That is
      // what an empty list means.
      const items: Cell[] = list.length ? list : [null];
      const marks = items.map((item) => {
        params.push(item);
        return numbered ? `$${params.length}` : '?';
      });
      out += marks.join(', ');
      continue;
    }

    const value = (raw ?? null) as Cell;
    if (numbered && p.style === 'named') {
      const already = assigned.get(p.key);
      if (already) {
        out += already;
        continue;
      }
      params.push(value);
      const mark = `$${params.length}`;
      assigned.set(p.key, mark);
      out += mark;
      continue;
    }
    params.push(value);
    out += numbered ? `$${params.length}` : '?';
  }

  out += sql.slice(cursor);
  return { sql: out, params };
}

/// The bound statement with its values written back in, FOR DISPLAY ONLY.
///
/// Never executed — the executed statement carries placeholders and the
/// values travel beside it. This exists because a session log full of
/// `WHERE client_name = ?` cannot answer the question the log is for,
/// which is "what did that actually ask".
export function previewBound(sql: string, params: readonly Cell[], engine: Engine): string {
  const holes = scanPlaceholders(sql, engine);
  if (holes.length === 0) return sql;
  let out = '';
  let cursor = 0;
  holes.forEach((hole, i) => {
    out += sql.slice(cursor, hole.from);
    // Postgres numbers its holes, so `$1` twice is one value shown twice;
    // everywhere else the nth hole is the nth value.
    const at = engine === 'postgres' && /^\$[0-9]+$/.test(hole.raw)
      ? Number(hole.raw.slice(1)) - 1
      : i;
    out += displayValue(params[at]);
    cursor = hole.to;
  });
  return out + sql.slice(cursor);
}

function displayValue(value: Cell | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && '__bin' in value) return `<${value.byteLength} bytes>`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/// Turn a typed-in string into the value that will be bound.
export function coerceParam(text: string, type: ParamType): ParamValue {
  const trimmed = text.trim();
  switch (type) {
    case 'null':
      return null;
    case 'text':
      return text;
    case 'number': {
      const n = Number(trimmed);
      if (trimmed === '' || Number.isNaN(n)) {
        throw new Error(`"${text}" is not a number.`);
      }
      return n;
    }
    case 'boolean': {
      const t = trimmed.toLowerCase();
      if (['true', 't', 'yes', 'y', '1'].includes(t)) return true;
      if (['false', 'f', 'no', 'n', '0'].includes(t)) return false;
      throw new Error(`"${text}" is not a true/false value.`);
    }
    case 'list':
      // Split on commas, honouring quotes so a name with a comma in it can
      // still be one item.
      return splitList(text);
    case 'auto':
    default: {
      if (trimmed === '') return '';
      if (/^null$/i.test(trimmed)) return null;
      if (/^true$/i.test(trimmed)) return true;
      if (/^false$/i.test(trimmed)) return false;
      // Leading zeros stay text on purpose: `007` is an account number far
      // more often than it is the number seven.
      if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) {
        return Number(trimmed);
      }
      return text;
    }
  }
}

function splitList(text: string): Cell[] {
  const out: Cell[] = [];
  let cur = '';
  /// Whether the item currently being read was quoted. A quoted item keeps
  /// its spacing and stays text; an unquoted one is trimmed and typed, so
  /// `hp, ibm, 3` is two names and a number rather than three strings with
  /// stray spaces.
  let quoted = false;
  let quote: string | null = null;

  const flush = () => {
    if (quoted) out.push(cur);
    else if (cur.trim() !== '') out.push(coerceParam(cur.trim(), 'auto') as Cell);
    cur = '';
    quoted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === ',') {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/// Which of a binding's layers applies to this connection.
export function resolveBinding(
  binding: ParamBinding,
  target: { connectionId?: string; env?: EnvKind },
): { text: string; scope: ParamScope } {
  const byConnection = target.connectionId ? binding.byConnection?.[target.connectionId] : undefined;
  if (byConnection !== undefined) return { text: byConnection, scope: 'connection' };
  const byEnv = target.env ? binding.byEnv?.[target.env] : undefined;
  if (byEnv !== undefined) return { text: byEnv, scope: 'env' };
  return { text: binding.value, scope: 'default' };
}

/// What every slot in a statement resolves to for one connection.
///
/// The list the params bar renders, and the same list a fan-out asks for
/// once per member — which is what makes "run this on every environment"
/// bind prod's value on prod and staging's on staging without anybody
/// editing the SQL between runs.
export function resolveParams(
  slots: ParamSlot[],
  bindings: ParamBinding[],
  target: { connectionId?: string; env?: EnvKind },
): ResolvedParam[] {
  const byKey = new Map(bindings.map((b) => [b.key, b]));
  return slots.map((slot) => {
    const binding = byKey.get(slot.key);
    if (!binding) {
      return {
        key: slot.key, label: slot.label, type: defaultType(slot),
        text: '', scope: 'default' as ParamScope, missing: true,
      };
    }
    const { text, scope } = resolveBinding(binding, target);
    return { key: slot.key, label: slot.label, type: binding.type, text, scope, missing: false };
  });
}

/// Slots with nothing to bind. A statement with one of these must not run:
/// binding NULL for "I didn't say" turns `= ?` into a predicate that
/// matches nothing and returns an empty grid that looks like an answer.
export function unfilledParams(resolved: ResolvedParam[]): ResolvedParam[] {
  return resolved.filter((r) => r.missing || (r.type !== 'null' && r.text.trim() === ''));
}

/// Bind a statement for one connection in one call. Throws on a value that
/// cannot be coerced, so the caller can say which box is wrong.
export function bindFor(
  sql: string,
  engine: Engine,
  bindings: ParamBinding[],
  target: { connectionId?: string; env?: EnvKind },
): BoundStatement {
  const resolved = resolveParams(paramSlots(sql, engine), bindings, target);
  const values: Record<string, ParamValue> = {};
  for (const r of resolved) values[r.key] = coerceParam(r.text, r.type);
  return bindParams(sql, engine, values);
}

/// Write a value into the layer the user picked, leaving the others alone.
export function withValue(
  binding: ParamBinding,
  text: string,
  scope: ParamScope,
  target: { connectionId?: string; env?: EnvKind },
): ParamBinding {
  const next: ParamBinding = { ...binding, updatedAt: new Date().toISOString() };
  if (scope === 'connection' && target.connectionId) {
    next.byConnection = { ...(binding.byConnection ?? {}), [target.connectionId]: text };
    return next;
  }
  if (scope === 'env' && target.env) {
    next.byEnv = { ...(binding.byEnv ?? {}), [target.env]: text };
    return next;
  }
  next.value = text;
  return next;
}

/// Drop one override, falling back to the layer beneath it.
export function clearValue(
  binding: ParamBinding,
  scope: ParamScope,
  target: { connectionId?: string; env?: EnvKind },
): ParamBinding {
  const next: ParamBinding = { ...binding, updatedAt: new Date().toISOString() };
  if (scope === 'connection' && target.connectionId && next.byConnection) {
    const { [target.connectionId]: _gone, ...rest } = next.byConnection;
    next.byConnection = rest;
    return next;
  }
  if (scope === 'env' && target.env && next.byEnv) {
    const { [target.env]: _gone, ...rest } = next.byEnv;
    next.byEnv = rest;
    return next;
  }
  next.value = '';
  return next;
}

/// Replace-or-append, keyed by slot. The list is small and ordered by
/// nothing in particular, so insertion order is kept.
export function upsertBinding(list: ParamBinding[], binding: ParamBinding): ParamBinding[] {
  const at = list.findIndex((b) => b.key === binding.key);
  if (at < 0) return [...list, binding];
  return list.map((b, i) => (i === at ? binding : b));
}

/// Drop every override keyed to a connection that no longer exists.
///
/// A per-connection value cannot outlive its connection: nothing will ever
/// resolve it again, and it would sit in the store forever being handed to
/// the window on every launch. Same rule the buffers, the ask thread and
/// the stored credential already follow when a connection is removed.
export function forgetConnection(list: ParamBinding[], connectionId: string): ParamBinding[] {
  return list.map((binding) => {
    if (!binding.byConnection || !(connectionId in binding.byConnection)) return binding;
    const { [connectionId]: _gone, ...rest } = binding.byConnection;
    return { ...binding, byConnection: rest };
  });
}

/// What a slot means before anybody has said otherwise.
export function defaultType(slot: ParamSlot): ParamType {
  return slot.inList ? 'list' : 'auto';
}

/// A fresh binding for a slot that has never been filled in.
///
/// A hole sitting alone inside an `IN (...)` starts as a LIST, because that
/// is what the SQL says it is. Left on 'auto' it would take `hp, ibm` as
/// one string containing a comma, match nothing, and return an empty grid
/// that looks like an answer — the worst failure this feature has.
export function blankBinding(slot: ParamSlot): ParamBinding {
  return { key: slot.key, label: slot.label, type: defaultType(slot), value: '' };
}

/// How a resolved value should be described in one word.
export function scopeLabel(scope: ParamScope, env?: EnvKind): string {
  if (scope === 'connection') return 'this connection';
  if (scope === 'env') return env ?? 'this environment';
  return 'default';
}
