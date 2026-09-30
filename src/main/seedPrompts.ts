// Prompts for seeding a database for a ticket.
//
// Same ground rules as aiPrompts.ts — the model runs nothing and sees no
// rows — plus the two this flow adds. The plan comes back as words before
// any SQL exists, so a person approves "one gold customer on the $50 line"
// rather than forty INSERTs. And the script is held to a shape overdb can
// check (src/shared/seedSql.ts): INSERTs only, parents first, every new row
// findable again by a marker, so the teardown can remove exactly what the
// seed made.

import type { Engine, SeedSize } from '../shared/types';
import type { SeedInvestigation } from '../shared/seedSql';

function dialectName(engine: Engine, serverVersion: string): string {
  if (engine === 'mysql') return /mariadb/i.test(serverVersion) ? 'MariaDB' : 'MySQL';
  return engine === 'postgres' ? 'PostgreSQL' : 'SQLite';
}

const SIZES: Record<SeedSize, string> = {
  minimal: 'Just enough: one row per case the need describes, and no more. Boundaries count as cases — a $50 threshold wants $50.00 and $49.99.',
  realistic: 'Realistic: every case the need describes, plus a handful of ordinary rows around them so list screens look lived in (roughly 10–30 rows per main table).',
  volume: 'Volume: every case the need describes, plus enough ordinary rows to exercise pagination and slow paths (a few hundred rows in the main table). Use multi-row VALUES lists.',
};

export interface SeedPromptInput {
  engine: Engine;
  serverVersion: string;
  schemaContext: string;
  need: string;
  size: SeedSize;
  /// Parents first, from the foreign keys.
  insertOrder: string[];
  /// Row counts per table — counts only, never rows.
  /// `capped` means "at least this many"; `approx`, the server's estimate.
  counts: Array<{ table: string; rows: number; capped?: boolean; approx?: boolean }>;
  idStart: number;
}

const GROUND = `You are helping inside overdb, a database client, to seed a LOCAL development
database with test data for a ticket.

You CANNOT run anything and never will. A person reads what you write and chooses
whether to run it. You are shown table and column names, types, keys and row
COUNTS — never any row data. Do not invent tables or columns that are not listed.

You cannot open tickets, issue trackers or anything outside what you are given.
If the need names a ticket (SHOP-418, PROJ-12) without saying what it asks for,
do not go looking for it — searching code or git history for a ticket key finds
nothing useful. Plan from what the words do say, and state plainly in
"assumptions" that the ticket's own text was not provided.`;

function context(input: SeedPromptInput): string {
  const counts =
    input.counts.map((c) => `${c.table} ${c.approx ? '~' : ''}${c.rows}${c.capped ? '+' : ''}`).join(' · ') || '(none)';
  return `Database: ${dialectName(input.engine, input.serverVersion)} ${input.serverVersion}

Schema:
${input.schemaContext}

Row counts today: ${counts}
Insert order (parents before children): ${input.insertOrder.join(' → ') || '(no foreign keys)'}

How much data: ${SIZES[input.size]}

New rows are marked so they can be removed again: give every new row in a table
with an integer primary key an explicit id counting up from ${input.idStart}, and give text
columns that identify a row (emails, names, codes) a recognisable marker such as
an @seed.overdb.test email domain or a SEED- prefix.

What the person needs:
"""
${input.need.trim()}
"""`;
}

const PLAN_SHAPE = `Answer with ONE \`\`\`json block and nothing else, in exactly this shape:

\`\`\`json
{
  "findings": [
    { "source": "code", "text": "Tier is one of none · silver · gold", "ref": "src/customers/tier.ts:4" },
    { "source": "schema", "text": "customers.email is unique", "ref": "customers.email UNIQUE" }
  ],
  "plan": {
    "summary": "One or two sentences on what the rows are for.",
    "groups": [
      { "table": "customers", "rows": [ { "label": "Gia Gold", "detail": "gold · gia@seed.overdb.test" } ] },
      { "table": "orders", "rows": [ { "label": "Gia Gold · $50.00", "detail": "free shipping — exactly on the line" } ] }
    ],
    "assumptions": ["Anything the plan relies on that neither the schema nor the code settled."],
    "note": "Optional: existing rows reused instead of created, e.g. products."
  },
  "marker": "One sentence: how the teardown will find these rows again."
}
\`\`\`

findings: the rules that shape the data — allowed values of text columns, JSON
shapes, relationships and invariants the app relies on — each with where it came
from. Keep them to what matters for THIS need; at most twelve.

groups: one per table rows will be inserted into, in insert order. Each row gets a
short label a person recognises and, where it helps, what it should make the app
show. For 'volume', describe the bulk rows as one line ("200 ordinary orders, mixed
tiers") rather than listing them.

assumptions: be honest. If the code did not confirm something the plan depends
on, say so here — an unconfirmed guess stated plainly is worth more than a
confident wrong one. Use [] when there are none.`;

export function investigatePrompt(input: SeedPromptInput, repo: { readable: boolean }): string {
  const how = repo.readable
    ? `You are running inside the repository whose code uses this database. Use Read,
Grep and Glob to find what the schema cannot tell you: the values the code writes
to text and enum-like columns, the shape of JSON columns, relationships the
database does not enforce, and any rule the ticket's behaviour depends on (look
for the code the need is about). Cite what you rely on as path:line.

Do not open .env files, credentials, keys or anything outside the repository.
Stop reading once you know enough to plan; this is not an audit.`
    : `You cannot see the application's code, only the schema. Where the plan depends
on something only the code would know — allowed status values, JSON shapes, app
rules — say so in "assumptions" rather than guessing silently.`;

  return `${GROUND}

${context(input)}

${how}

Do NOT write any SQL yet. First the person approves a plan in words.

${PLAN_SHAPE}`;
}

export function revisePrompt(input: SeedPromptInput, previous: SeedInvestigation, instruction: string): string {
  return `${GROUND}

${context(input)}

A plan was drafted and the person wants it changed. The findings below came from
reading the schema and the code; keep them unless the change makes one irrelevant.

Current plan:
\`\`\`json
${JSON.stringify(previous, null, 2)}
\`\`\`

The change they asked for:
"""
${instruction.trim()}
"""

Do NOT write any SQL yet.

${PLAN_SHAPE}`;
}

export function scriptPrompt(input: SeedPromptInput, plan: SeedInvestigation, problems: string[] = []): string {
  const retry = problems.length
    ? `\nYour last script was refused for these reasons. Fix every one:\n${problems.map((p) => `- ${p}`).join('\n')}\n`
    : '';
  return `${GROUND}

${context(input)}

The person approved this plan. Write it as SQL, following the findings exactly:
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`
${retry}
Answer with exactly three fenced blocks and nothing else:

\`\`\`sql seed
-- INSERT statements only, one per table, in the insert order above.
-- INSERT INTO t (col, …) VALUES (…), (…);  — always name the columns.
-- No UPDATE, DELETE, DDL, upserts or INSERT … SELECT.
-- Reuse existing rows (products, lookup tables) only by ids small enough to
-- exist for certain; otherwise create them with the marker.
\`\`\`

\`\`\`sql teardown
-- DELETE … WHERE statements that remove exactly the rows the seed creates,
-- children before parents, found by the marker (the id block or the marker
-- text). Never a DELETE without a WHERE.
\`\`\`

\`\`\`sql verify
-- ONE SELECT that reads the seeded rows back the way the need cares about,
-- joined where that helps, with a final text column named should_show saying
-- what the app should do for each row. Filter it to the seeded rows only.
\`\`\`

Write values the app would accept: the exact strings the code uses, JSON in the
shape it reads, totals that agree with their parts. ${dialectName(input.engine, input.serverVersion)} syntax.`;
}
