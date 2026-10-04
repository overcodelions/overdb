// The prompt for reading the code during baseline discovery. Same ground
// rules as the seed investigation (seedPrompts.ts): the model runs nothing,
// sees no rows, and can only Read, Grep and Glob in the linked repo.

export interface BaselineCodeInput {
  /// `app.client(client_id)`, or null for a single-tenant system.
  tenant: string | null;
  /// "Acme", "you@example.com in app.app_user".
  startingPoints: string[];
  /// Login tables with no link to the tenant the schema shows.
  unlinkedLogins: string[];
  /// linkKey → the other tables the same column could mean.
  ambiguous: Array<{ link: string; alternatives: string[] }>;
  /// Tables the sort leaves without rows, which the app might need.
  emptied: Array<{ table: string; reason: string }>;
  /// The schemas the base holds, to pick which linked repos to read.
  schemas?: string[];
}

export function baselineCodePrompt(input: BaselineCodeInput): string {
  const lines = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(none)');
  return `You are helping inside overdb, a database client, to make a SMALL copy of a local
development database that is still enough to log in to the app and use it. overdb
chose which tables keep rows by reading the schema; the code in this repository
knows things the schema does not. Read it — Read, Grep and Glob are all you have —
and answer the questions below.

You run nothing and see no rows. Do not invent tables, columns or links: answer
only about the names listed here, spelled exactly as they are.

The tenant: ${input.tenant ?? '(none — a single-tenant system)'}
What the copy is built around:
${lines(input.startingPoints)}

1. How does each of these login tables reach the tenant? The schema shows no link.
   Look at the login and session code, and any table that joins them.
${lines(input.unlinkedLogins)}

2. Each of these columns was linked to a table by its name, but could mean another.
   Which is right? Answer "keep" if the link as written is right, "off" if not.
${lines(input.ambiguous.map((a) => `${a.link}   (could also be: ${a.alternatives.join(', ')})`))}

3. These tables will be created EMPTY. Does logging in, or the first screens after it,
   read any of them — a settings, permission, feature-flag or session table the app
   cannot start without? Name only the ones the code shows it needs.
${lines(input.emptied.slice(0, 120).map((e) => `${e.table} — ${e.reason}`))}

Answer with ONE \`\`\`json block and nothing else, in exactly this shape:

\`\`\`json
{
  "findings": [
    { "text": "z123_user reaches a client through rel_z123_user_to_client, read at login", "ref": "src/auth/LoginService.java:88" }
  ],
  "links": [
    { "link": "<exactly as listed in question 2>", "verdict": "keep" | "off", "why": "one sentence" }
  ],
  "tables": [
    { "table": "schema.table", "action": "scoped" | "whole", "why": "one sentence, naming the code that reads it" }
  ]
}
\`\`\`

"scoped" keeps only the rows tied to what the copy is built around; "whole" copies
every row (only for small tables). Leave a list empty rather than guess.`;
}
