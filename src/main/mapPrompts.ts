// The prompt for mapping a database from the code that uses it.
//
// One pass per linked repo, run read-only like every other code reading
// (Read, Grep and Glob; no shell; secrets denied). What comes back is
// checked against the catalog before it is kept — see src/shared/dbMap.ts.

export interface MapPromptInput {
  repo: string;
  /// The schemas this repo's code uses, and every table in them.
  schemas: string[];
  catalog: string;
  /// On a refresh: the files changed since the last map. Null maps all.
  changed: string[] | null;
  /// A big catalog is mapped in parts: the tables this pass describes.
  /// Links may still point at any table in the catalog.
  focus?: { tables: string[]; part: number; of: number; files?: string[]; moreFiles?: number };
}

/// The files a scan found naming the part's tables: where to read, so the
/// pass does not search the whole repository for them.
function files(focus: NonNullable<MapPromptInput['focus']>): string {
  if (!focus.files?.length) return '';
  return `

These files name those tables. Read them first, and open other files only to
follow what they use (a base class, an enum, a constant). Do not search the
whole repository:
${focus.files.map((f) => `- ${f}`).join('\n')}${focus.moreFiles ? `\n- …and ${focus.moreFiles} more that name them, if these are not enough` : ''}`;
}

export function mapPrompt(input: MapPromptInput): string {
  const scope = input.changed
    ? `This is a REFRESH. The map already exists; only these files changed since it
was made, so read them (and what they touch) and describe only the tables they
affect:
${input.changed.slice(0, 300).map((f) => `- ${f}`).join('\n')}${input.changed.length > 300 ? `\n- …and ${input.changed.length - 300} more` : ''}`
    : `Map the whole of it: work through the code's data layer — entities and models,
repositories and DAOs, migrations, SQL files, the services that write rows — and
describe every table the code uses. Tables the code never touches can be left
out.`;

  const focus = input.focus
    ? `\n\nThis is part ${input.focus.part} of ${input.focus.of}. Describe ONLY these tables (links from them
may point at any table above):
${input.focus.tables.join(', ')}${files(input.focus)}`
    : '';

  return `You are helping inside overdb, a database client, to write down how an
application uses its database, once, so later work does not have to read the code
again. You CANNOT run anything. Use Read, Grep and Glob only, inside this
repository. Do not open .env files, credentials or keys.

The repository is ${input.repo}. Its code uses the schema${input.schemas.length === 1 ? '' : 's'} ${input.schemas.join(', ')}.

The tables, as \`schema.table(column type, …)\`:
${input.catalog}

${scope}${focus}

For each table, record what only the code knows:
- purpose: one sentence on what a row is, in the application's terms.
- module: where in the repo its code lives (a package, a folder or a class).
- values: for text and enum-like columns the code writes a fixed set of values
  to (status, type, kind, state, role…), the values, from the code.
- json: for JSON or text columns holding structured data, the shape the code
  reads and writes, written compactly like {"step":number,"done":boolean}.
- rules: rules the application enforces that the schema does not — a row that
  must exist first, a value that must match another table, a flag that hides
  rows. Short sentences.
- links: relationships the code makes between columns, especially ones the
  database has no foreign key for, including across schemas. Give both ends as
  schema.table.column.

Cite each fact as path:line, relative to the repository, in "ref". Use only
table and column names from the list above, exactly as written. Leave out what
you are not sure of rather than guessing.

Answer with ONE \`\`\`json block and nothing else:

\`\`\`json
{
  "tables": [
    {
      "table": "schema.table",
      "purpose": "…",
      "module": "…",
      "values": [{ "column": "status", "values": ["DRAFT", "LIVE"], "ref": "path:line" }],
      "json": [{ "column": "settings", "shape": "{…}", "ref": "path:line" }],
      "rules": [{ "text": "…", "ref": "path:line" }]
    }
  ],
  "links": [{ "from": "schema.table.column", "to": "schema.table.column", "why": "…", "ref": "path:line" }]
}
\`\`\``;
}
