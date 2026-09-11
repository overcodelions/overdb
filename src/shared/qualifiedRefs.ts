// Which schemas a statement actually reaches into.
//
// The catalog we introspect is the SESSION's schema, which is the right
// default and the wrong answer the moment you write `acme.panel_widget`
// while connected to `acme_cms`. The model then gets a schema listing with
// no such table in it, correctly says so, and the translation fails for a
// reason that looks like the feature being broken.
//
// So: read the qualifiers back out of the SQL and introspect those too.

/// Only qualifiers in a position where a SCHEMA can appear — after FROM,
/// JOIN, INTO, UPDATE or TABLE. A bare `a.column` elsewhere is an alias far
/// more often than a schema, and treating every dotted name as a schema
/// would have us introspecting every table alias in the buffer.
const QUALIFIED = /\b(?:from|join|into|update|table)\s+([`"[]?)([A-Za-z_][\w$]*)\1\s*\.\s*[`"[]?[A-Za-z_]/gi;

/// Schema names referenced by qualified table references, lowercased and
/// deduplicated. Order is first-appearance, so the schema you wrote first
/// is the one that survives a budget cut downstream.
export function referencedSchemas(sql: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  QUALIFIED.lastIndex = 0;
  while ((m = QUALIFIED.exec(sql))) {
    const name = m[2];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
