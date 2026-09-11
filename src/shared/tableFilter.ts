// Narrowing which tables a connection shows you.
//
// Relational engines give you a namespace per environment: `acme` and
// `acme_cms` are different schemas, and a connection to one does not show
// you the other. DynamoDB has no such thing. One AWS account and region
// holds every table there is, and the only thing separating a sandbox table
// from a production one is a naming convention — so a connection called
// "sandbox-dynamo" happily lists 228 tables, most of them prod.
//
// This is NOT a security boundary, and must never be described as one. A
// filtered-out table is still queryable by naming it, and the credentials
// still reach every table the IAM policy allows. It narrows what you browse
// and what the AI is shown; the durable limit is the IAM policy, exactly as
// the read-only note on DynamoDB connections already says.
//
// The same voice as src/shared/sqlGuard.ts, and for the same reason.

export interface TablePattern {
  /// A `!`-prefixed pattern removes matches instead of adding them.
  exclude: boolean;
  /// Lower-cased, `*` and `?` intact.
  glob: string;
}

/// Parse a comma- or newline-separated list of patterns.
///
/// A pattern with no wildcard is a PREFIX, because that is what people mean
/// when they type `LOCAL.` — requiring `LOCAL.*` for the overwhelmingly
/// common case would be a rule to remember for no benefit. `*` matches any
/// run of characters and `?` any single one, anywhere in the pattern.
export function parseTableFilter(text: string | undefined): TablePattern[] {
  if (!text?.trim()) return [];
  return text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const exclude = p.startsWith('!');
      const body = exclude ? p.slice(1).trim() : p;
      // Case-insensitive on purpose. A filter that silently matches nothing
      // because of a capital letter reads as the feature being broken.
      const lower = body.toLowerCase();
      return { exclude, glob: /[*?]/.test(lower) ? lower : `${lower}*` };
    })
    .filter((p) => p.glob !== '*' && p.glob !== '');
}

function globMatches(glob: string, name: string): boolean {
  // Escape everything regex-significant, then reinstate the two wildcards.
  const rx = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${rx}$`).test(name);
}

/// Include patterns are OR'd; any exclude pattern vetoes. With excludes only,
/// everything not excluded is kept — "show me everything except prod" is the
/// request that started this, and making it require a matching include as
/// well would be a trap.
export function matchesTableFilter(name: string, patterns: TablePattern[]): boolean {
  if (patterns.length === 0) return true;
  const lower = name.toLowerCase();
  const includes = patterns.filter((p) => !p.exclude);
  const excludes = patterns.filter((p) => p.exclude);
  if (excludes.some((p) => globMatches(p.glob, lower))) return false;
  if (includes.length === 0) return true;
  return includes.some((p) => globMatches(p.glob, lower));
}

/// Convenience for the common "filter a list by the raw setting" call.
export function filterTableNames(names: string[], text: string | undefined): string[] {
  const patterns = parseTableFilter(text);
  if (patterns.length === 0) return names;
  return names.filter((n) => matchesTableFilter(n, patterns));
}
