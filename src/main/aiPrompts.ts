// Prompts for the four AI flows.
//
// Two rules run through all of them. First, the model is told plainly that
// it cannot execute anything — it is writing SQL for a person to read, and
// pretending otherwise produces answers phrased as if work has been done.
// Second, SQL must come back in a fenced block, because that fence is what
// the Insert button extracts; prose with an inline query has nothing exact
// to hand to the editor.

import type { Engine } from '../shared/types';

function dialectName(engine: Engine, serverVersion: string): string {
  if (engine === 'mysql') return /mariadb/i.test(serverVersion) ? 'MariaDB' : 'MySQL';
  return engine === 'postgres' ? 'PostgreSQL' : 'SQLite';
}

const GROUND_RULES = `You are assisting inside overdb, a database client.

You CANNOT run queries. You never have. Anything you write is a suggestion the
person will read and choose to run themselves, so never say you "ran", "checked"
or "found" anything in the data.

You are shown table and column names, types and constraints only — never any
row data. Do not invent columns or tables that are not listed. If the schema you
were given is missing something you need, say so plainly and name what you'd
need to see.

Put every SQL statement in a \`\`\`sql fenced block. Keep prose short.`;

export interface PromptInput {
  engine: Engine;
  serverVersion: string;
  schemaContext: string;
  question: string;
  editorText?: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  plan?: string;
}

function historyBlock(history: PromptInput['history']): string {
  if (!history?.length) return '';
  // Older turns are trimmed rather than dropped: the thread of the
  // conversation matters more than its full text, and re-sending everything
  // costs tokens on every turn.
  const recent = history.slice(-6);
  return (
    '\n\nConversation so far:\n' +
    recent
      .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text.slice(0, 1200)}`)
      .join('\n')
  );
}

export function askPrompt(input: PromptInput): string {
  return [
    GROUND_RULES,
    `\nDialect: ${dialectName(input.engine, input.serverVersion)}`,
    `\nSchema:\n${input.schemaContext}`,
    input.editorText?.trim() ? `\nThe editor currently contains:\n\`\`\`sql\n${input.editorText.trim()}\n\`\`\`` : '',
    historyBlock(input.history),
    `\n\nUser: ${input.question}`,
  ].join('');
}

export function sqlPrompt(input: PromptInput): string {
  return [
    GROUND_RULES,
    `\nDialect: ${dialectName(input.engine, input.serverVersion)}`,
    `\nSchema:\n${input.schemaContext}`,
    historyBlock(input.history),
    `\n\nWrite ONE ${dialectName(input.engine, input.serverVersion)} query for this request. `,
    'Return the query in a ```sql block, then at most two sentences saying what it does ',
    'and naming any assumption you had to make about the schema.',
    `\n\nRequest: ${input.question}`,
  ].join('');
}

export function explainPrompt(input: PromptInput): string {
  return [
    GROUND_RULES,
    `\nDialect: ${dialectName(input.engine, input.serverVersion)}`,
    `\nSchema:\n${input.schemaContext}`,
    `\n\nQuery:\n\`\`\`sql\n${input.editorText ?? ''}\n\`\`\``,
    input.plan ? `\n\nQuery plan:\n\`\`\`json\n${input.plan}\n\`\`\`` : '',
    '\n\nExplain what this query does and how the planner intends to execute it. ',
    'Lead with the single most important thing about its cost. Where the plan shows ',
    'an estimated row count far from the actual, say so and explain what usually ',
    'causes that. If an index would help, give the exact CREATE INDEX in a ```sql ',
    'block and say what it would change — but be clear it is a suggestion to review, ',
    'not something to run blindly on a large table.',
    input.question ? `\n\nThe user also asks: ${input.question}` : '',
  ].join('');
}

/// Repairing a failed statement. The failing SQL and the server's own error
/// are both included verbatim: the error text names the problem far more
/// precisely than any description of it, and the model's job is to correct
/// one statement, not to redesign the query.
export function fixPrompt(input: PromptInput & { failingSql: string; errorText: string }): string {
  return [
    GROUND_RULES,
    `\nDialect: ${dialectName(input.engine, input.serverVersion)}`,
    `\nSchema:\n${input.schemaContext}`,
    `\n\nThis statement failed:\n\`\`\`sql\n${input.failingSql}\n\`\`\``,
    `\n\nThe server said:\n${input.errorText}`,
    '\n\nReturn the corrected statement in a ```sql block, changing as little as ',
    'possible — keep the original intent, column order and formatting. Then one ',
    'sentence saying what was wrong. If the schema you were shown does not contain ',
    'what the query needs, say that instead of inventing a name.',
    input.question ? `\n\nExtra context from the user: ${input.question}` : '',
  ].join('');
}
