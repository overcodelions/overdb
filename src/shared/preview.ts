// "Just show me what's in this table."
//
// The first thing anyone does with an unfamiliar table, and on three of the
// four engines it is a statement so rote that typing it is pure tax. On the
// fourth it is a trap: `SELECT * FROM LOCAL.event-log-v2 LIMIT 100` is four
// separate mistakes — the dot is read as table.index, the dashes need
// quoting, and PartiQL has no LIMIT clause at all — and the person who
// makes them has no way to know that from the error.
//
// So the statement is generated here, per engine, and the caller only has to
// know which table was clicked.

import { quoteIdent } from './orderBy';
import type { Engine } from './types';

/// How many items a DynamoDB peek reads. Small on purpose: this is "what
/// does a row in here look like", and the answer is legible in five.
export const PEEK = 5;

export interface PreviewOptions {
  /// The schema the table lives in, from the catalog.
  schema: string;
  table: string;
  /// What the session resolves unqualified names to. A table in that schema
  /// is written bare — qualifying everything makes the generated statement
  /// noisier than the one you would have typed, and turns a preview you can
  /// edit into one you have to clean up first.
  activeSchema?: string | null;
  /// Rows to ask for. Defaults to 200 on the SQL engines — a cheap read
  /// there — and to PEEK on DynamoDB, where every item read is billed.
  limit?: number;
}

/// A first look at a table, in the dialect that will actually run.
export function previewStatement(engine: Engine, opts: PreviewOptions): string {
  if (engine === 'dynamodb') {
    // A peek, not a page. Clicking a table must never cost a full scan: this
    // ran `SELECT * FROM "LOCAL.event-log-v2"` against a provisioned table
    // and came back "throughput exceeded" — the row cap had bounded it at a
    // thousand items, and a thousand items is a thousand reads.
    //
    // The LIMIT is written even though PartiQL has no LIMIT clause, because
    // overdb lifts it into the request (see prepareStatement) and DynamoDB
    // stops evaluating there. Writing it beats hiding it in a row cap: it is
    // visible, editable, and the statement still means what it says when you
    // insert it in the editor and run it again.
    //
    // No region prefix — DynamoDB has no schemas, and the dotted form
    // already means table.index.
    return `SELECT * FROM ${quoteIdent(opts.table, engine)} LIMIT ${opts.limit ?? PEEK};`;
  }
  const limit = opts.limit ?? 200;
  const qualify = opts.schema && opts.schema !== opts.activeSchema;
  const name = qualify
    ? `${quoteIdent(opts.schema, engine)}.${quoteIdent(opts.table, engine)}`
    : quoteIdent(opts.table, engine);
  return `select *\nfrom ${name}\nlimit ${limit};`;
}
