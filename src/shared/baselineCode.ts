// What reading the code adds to a baseline: the answers a schema cannot
// give — how a second users table reaches an account, which of two tables
// a column really means, which table logging in needs that the sort would
// leave empty. See docs/design/baselines.md.
//
// The model only suggests. Every suggestion names a link or a table the
// catalog already has, is shown with its reason, and changes the recipe
// only when a person applies it.

import { jsonBody } from './seedSql';
import type { TableAction } from './baseline';

export interface CodeFinding {
  text: string;
  /// `path/to/file.ts:42`, where the model found it.
  ref?: string;
}

export interface LinkVerdict {
  /// A linkKey from the catalog.
  link: string;
  verdict: 'keep' | 'off';
  why: string;
}

export interface TableSuggestion {
  /// A tableKey from the catalog.
  table: string;
  action: Extract<TableAction, 'scoped' | 'whole' | 'empty' | 'skip'>;
  why: string;
}

export interface CodeReading {
  findings: CodeFinding[];
  links: LinkVerdict[];
  tables: TableSuggestion[];
}

const ACTIONS = new Set(['scoped', 'whole', 'empty', 'skip']);
const MAX = 60;

function str(v: unknown, max = 400): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/// The model's answer, kept only where it names a link or a table that
/// exists: a suggestion about something the catalog does not have is a
/// guess about the wrong database, and is dropped rather than shown.
export function parseCodeReading(
  raw: string,
  known: { links: ReadonlySet<string>; tables: ReadonlySet<string> },
): CodeReading | { error: string } {
  const body = jsonBody(raw);
  if (!body) return { error: 'The model did not answer in the expected shape.' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { error: 'The model’s answer was not valid JSON.' };
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX) : []).map((x) => (x ?? {}) as Record<string, unknown>);

  const findings = arr(data.findings)
    .map((f) => ({ text: str(f.text), ref: str(f.ref, 200) || undefined }))
    .filter((f) => f.text);

  const links = arr(data.links)
    .map((l) => ({ link: str(l.link, 300), verdict: l.verdict === 'off' ? 'off' : 'keep', why: str(l.why) }) as LinkVerdict)
    .filter((l) => known.links.has(l.link));

  const lower = new Map([...known.tables].map((t) => [t.toLowerCase(), t]));
  const tables = arr(data.tables)
    .map((t) => ({ table: lower.get(str(t.table, 200).toLowerCase()) ?? '', action: str(t.action, 20), why: str(t.why) }))
    .filter((t): t is TableSuggestion => t.table !== '' && ACTIONS.has(t.action));

  return { findings, links, tables };
}
