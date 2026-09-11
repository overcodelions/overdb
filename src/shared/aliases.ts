// Which table an alias in a plan actually refers to.
//
// A plan names its steps the way the statement did: `v`, `g`, `p`, `c`. That
// is fine while you are holding the query in your head and useless five
// minutes later — "p is ref on IDX_CLIENT_DEFAULT" says nothing about which
// table is being read. The server does not tell us either; the mapping only
// exists in the SQL that was explained, so it is recovered from there.
//
// Deliberately a scanner and not a parser. It reads `FROM x y` and `JOIN x AS
// y` at any depth and ignores everything else, which is exactly right for
// what it feeds: a label. A miss shows the alias, which is what we had
// before — never a wrong table name.

/// Words that can follow a table name and are NOT an alias. Without this,
/// `from panel_widget where ...` reports an alias called `where`.
const NOT_ALIAS = new Set([
  'on', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'join',
  'inner', 'left', 'right', 'full', 'cross', 'outer', 'straight_join', 'natural',
  'using', 'set', 'values', 'select', 'from', 'and', 'or', 'as', 'for', 'lock',
  'window', 'partition', 'into', 'force', 'use', 'ignore', 'index', 'key',
]);

const unquote = (s: string): string => s.replace(/^[`"[]|[`"\]]$/g, '');

const REF =
  /\b(?:from|join)\s+([`"[]?[\w$]+[`"\]]?(?:\s*\.\s*[`"[]?[\w$]+[`"\]]?)?)(?:\s+(?:as\s+)?([`"[]?[a-zA-Z_][\w$]*[`"\]]?))?/gi;

/// Alias → the table it names, as written in the statement (qualified when
/// the statement qualified it). Tables with no alias map to themselves, so a
/// caller can look up any step name and get something back.
export function tableAliases(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  let m: RegExpExecArray | null;
  REF.lastIndex = 0;
  while ((m = REF.exec(text))) {
    const table = m[1]
      .split('.')
      .map((part) => unquote(part.trim()))
      .join('.');
    if (!table) continue;
    const bare = table.split('.').pop() as string;
    out[bare] = table;

    const alias = m[2] ? unquote(m[2]) : null;
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) out[alias] = table;
  }
  return out;
}

/// The label for a plan step: the table it reads, and the alias it was
/// called, when those differ. Returns null when the step is not a table at
/// all — a sort, a temporary table, a node type.
export function resolveStep(
  step: string,
  aliases: Record<string, string>,
): { table: string; alias: string | null } | null {
  const table = aliases[step];
  if (!table) return null;
  const bare = table.split('.').pop();
  return { table, alias: step === bare ? null : step };
}
