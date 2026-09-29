// Handing a finding to overcli.
//
// overdb can say WHAT is wrong with a query; the fix lives in a repo, and
// overcli is where a coding agent works in one. The two apps share no code,
// so the format below is a copy of overcli's `src/shared/handoff.ts` — keep
// them in step, and bump `v` on both sides for any change a reader must
// understand.
//
// Transport: one JSON file written into `~/.overcli/inbox/`, tmp + rename so
// overcli never reads it half-written. overcli need not be running — the
// file waits — and it never acts on one by itself: a person opens it from
// overcli's tray and sends the seeded message.
//
// What never goes in: result ROWS, and anything credential-shaped. A handoff
// carries the statement, the plan text, the findings and the environment
// names — the same things the tuner already sends a model, and no more. See
// `overcliHandoff.test.ts`.

import type { Connection, EnvSet } from './types';
import type { StatementStat } from './slowQueries';

export const HANDOFF_VERSION = 1;
export const HANDOFF_MAX_BYTES = 64 * 1024;

export type HandoffKind = 'slow-query' | 'drift' | 'migration-needed' | 'error';

export interface HandoffEvidence {
  sql?: string;
  plan?: string;
  envs?: string[];
  error?: string;
}

export interface InboundHandoff {
  v: typeof HANDOFF_VERSION;
  id: string;
  from: 'overdb';
  kind: HandoffKind;
  title: string;
  summary: string;
  evidence?: HandoffEvidence;
  repoHints: string[];
  createdAt: number;
}

/// What the renderer asks main to send. Main stamps `v`, `id`, `from` and
/// `createdAt`, and rebuilds the rest field by field — see `buildHandoff`.
export interface HandoffDraft {
  kind: HandoffKind;
  title: string;
  summary: string;
  evidence?: HandoffEvidence;
  repoHints: string[];
}

/// Per-field caps, well inside overcli's own (16 KB) so a clipped field is
/// clipped here, where the ellipsis is ours, and not silently there.
const MAX_TITLE = 200;
const MAX_TEXT = 12 * 1024;

const KINDS: readonly HandoffKind[] = ['slow-query', 'drift', 'migration-needed', 'error'];

/// The file to write, or why not. Copies only known fields — so nothing the
/// renderer tacks on (a result set, say) can ride along — and refuses
/// anything overcli would reject rather than letting it land in `rejected/`.
export function buildHandoff(
  draft: HandoffDraft,
  stamp: { id: string; now: number },
): { ok: true; handoff: InboundHandoff; json: string } | { ok: false; error: string } {
  if (!KINDS.includes(draft.kind)) return { ok: false, error: `Unknown kind ${draft.kind}` };
  const title = clip((draft.title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE);
  if (!title) return { ok: false, error: 'A handoff needs a title.' };
  const repoHints = (draft.repoHints ?? []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 8);
  if (repoHints.length === 0) return { ok: false, error: 'Link a repo first.' };

  let evidence: HandoffEvidence | undefined;
  const e = draft.evidence;
  if (e) {
    evidence = {};
    if (e.sql) evidence.sql = clip(e.sql, MAX_TEXT);
    if (e.plan) evidence.plan = clip(e.plan, MAX_TEXT);
    if (e.error) evidence.error = clip(e.error, MAX_TEXT);
    if (e.envs?.length) evidence.envs = [...new Set(e.envs)].slice(0, 10).map((x) => clip(x, 40));
  }

  const handoff: InboundHandoff = {
    v: HANDOFF_VERSION,
    id: stamp.id,
    from: 'overdb',
    kind: draft.kind,
    title,
    summary: clip(draft.summary ?? '', MAX_TEXT),
    evidence,
    repoHints,
    createdAt: stamp.now,
  };
  const json = JSON.stringify(handoff, null, 2);
  if (new TextEncoder().encode(json).length > HANDOFF_MAX_BYTES) {
    return { ok: false, error: 'Too large to hand over — trim the statement or the plan.' };
  }
  return { ok: true, handoff, json };
}

/// `<createdAt>-<id>.json`: sorts in arrival order in a Finder window, and
/// overcli ignores anything that does not end in `.json`, which is what
/// makes the `.tmp` stage invisible to it.
export function handoffFileName(h: Pick<InboundHandoff, 'id' | 'createdAt'>): string {
  return `${h.createdAt}-${h.id}.json`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- which repo --------------------------------------------------------

/// Where a connection's repo link is kept. On the env set when the
/// connection belongs to one — local, staging and prod are one logical
/// database with one codebase, so linking it once should cover every env —
/// and on the connection itself otherwise.
export type RepoLinkOwner = { kind: 'envSet'; id: string; name: string } | { kind: 'connection'; id: string; name: string };

export function repoLinkOwner(
  connectionId: string,
  connections: readonly Connection[],
  envSets: readonly EnvSet[],
): RepoLinkOwner | null {
  const set = envSets.find((s) => !s.archived && s.memberIds.includes(connectionId));
  if (set) return { kind: 'envSet', id: set.id, name: set.name };
  const conn = connections.find((c) => c.id === connectionId);
  return conn ? { kind: 'connection', id: conn.id, name: conn.name } : null;
}

export function linkedRepos(
  owner: RepoLinkOwner,
  connections: readonly Connection[],
  envSets: readonly EnvSet[],
): string[] {
  const paths =
    owner.kind === 'envSet'
      ? envSets.find((s) => s.id === owner.id)?.repoPaths
      : connections.find((c) => c.id === owner.id)?.repoPaths;
  return paths ?? [];
}

// ---- what to say -------------------------------------------------------

/// The summary for a plan: its findings, worst first, as a list. Findings
/// are about tables and steps, never about values.
export function planSummary(
  findings: readonly { text: string; estimated?: boolean }[],
  result: { rowCount: number; durationMs: number | null } | null | undefined,
): string {
  const lines: string[] = [];
  if (result?.durationMs != null) {
    lines.push(`Ran in ${Math.round(result.durationMs)} ms and returned ${result.rowCount.toLocaleString()} rows.`);
  }
  if (findings.length === 0) {
    lines.push('overdb found nothing specific in the plan; the plan itself is attached.');
  } else {
    lines.push('What the plan shows:');
    for (const f of findings.slice(0, 8)) {
      lines.push(`- ${f.text}${f.estimated ? ' (estimated — the plan was not run with ANALYZE)' : ''}`);
    }
  }
  return lines.join('\n');
}

/// A one-line title for a statement: the first table it reads, if one can
/// be told apart, else its opening words.
export function statementTitle(sql: string, prefix: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const table = /\b(?:from|update|into)\s+([\w."`]+)/i.exec(flat)?.[1]?.replace(/["`]/g, '');
  return table ? `${prefix} on ${table}` : `${prefix}: ${flat.slice(0, 80)}`;
}

/// The summary for a slow-query row: the server's own counters. The text is
/// the normalized statement with placeholders, so no value from a real
/// request goes with it.
export function slowStatSummary(stat: StatementStat): string {
  const n = (v: number) => Math.round(v).toLocaleString();
  const lines = [
    "From the server's statement statistics (all clients, not just overdb):",
    `- ${n(stat.calls)} calls, ${n(stat.meanMs)} ms on average, ${n(stat.totalMs)} ms in total.`,
  ];
  if (stat.maxMs != null) lines.push(`- Slowest single call: ${n(stat.maxMs)} ms.`);
  if (stat.rowsExamined != null && stat.rowsReturned != null) {
    lines.push(`- ${n(stat.rowsExamined)} rows examined to return ${n(stat.rowsReturned)}.`);
  }
  if (stat.noIndexUsed) lines.push(`- ${n(stat.noIndexUsed)} calls used no index.`);
  return lines.join('\n');
}
