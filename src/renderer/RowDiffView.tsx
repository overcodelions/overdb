import { useMemo, useState } from 'react';
import type { Cell, Connection } from '@shared/types';
import { compare, type MemberRun } from '@shared/fanout';
import {
  candidateKeys,
  keyProblem,
  pickKey,
  rowDiff,
  rowDiffSentence,
  type KeyedTable,
} from '@shared/rowDiff';
import { useStore } from './store';

/// Which rows differ, under the column matrix.
///
/// Shown only once the rows were compared in full and a member's rows did
/// not match — a capped result is already explained by the verdict above,
/// and a diff of two capped grids would be a list of rows that happened to
/// arrive first. One member at a time against the baseline: the matrix is
/// where N members are read side by side, and a row diff of three members
/// at once has no shape anyone can read.

/// Enough to see the pattern. A diff of 40,000 rows is a finding about the
/// table, not something to read row by row, and the count says so.
const SHOWN = 200;

const AUTO = '\u0000auto';
const WHOLE = '\u0000whole';

export function RowDiffView({
  runs,
  baseline,
  byId,
}: {
  runs: MemberRun[];
  baseline: MemberRun | null;
  byId: Map<string, Connection>;
}): JSX.Element | null {
  const differing = useMemo(
    () =>
      baseline && baseline.status === 'done' && !baseline.truncated
        ? runs.filter((r) => {
            if (r.connectionId === baseline.connectionId || r.status !== 'done' || r.truncated) return false;
            const drift = compare(r, baseline).drift;
            return drift !== null && drift.sameRows === false;
          })
        : [],
    [runs, baseline],
  );

  const [picked, setPicked] = useState<string | null>(null);
  const [keyMode, setKeyMode] = useState<string>(AUTO);

  const member = differing.find((r) => r.connectionId === picked) ?? differing[0] ?? null;

  // The baseline's catalog: the key is a claim about the table the rows
  // came from, and the baseline is the member every claim here is made in
  // terms of. A key that does not hold on the member is caught by the check
  // against its rows, not assumed.
  const snapshot = useStore((s) => (baseline ? s.schemas[baseline.connectionId] : undefined));
  const tables = useMemo(
    (): KeyedTable[] =>
      (snapshot?.schemas ?? []).flatMap((sc) =>
        sc.tables.map((t) => ({ schema: sc.name, name: t.name, primaryKey: t.primaryKey, indexes: t.indexes })),
      ),
    [snapshot],
  );
  const candidates = useMemo(
    () => (baseline ? candidateKeys(baseline.columns, tables) : []),
    [baseline, tables],
  );

  const baseName = baseline ? byId.get(baseline.connectionId)?.name ?? 'the baseline' : '';
  const memberName = member ? byId.get(member.connectionId)?.name ?? 'this member' : '';

  const resolved = useMemo((): { key: string[] | null; label: string; note: string | null } => {
    if (!baseline || !member) return { key: null, label: '', note: null };
    if (keyMode === WHOLE) return { key: null, label: 'whole rows', note: null };
    if (keyMode === AUTO) {
      const chosen = pickKey(candidates, baseline, member);
      if (chosen) return { key: chosen.columns, label: `${chosen.columns.join(', ')} (${chosen.source})`, note: null };
      return {
        key: null,
        label: 'whole rows',
        note: candidates.length
          ? 'The keys the catalog offers are not unique in these results, so whole rows were compared. Pick a column to match on if one is.'
          : 'The catalog offers no key for these rows, so whole rows were compared. Pick a column to match on if one is unique.',
      };
    }
    const key = keyMode.split('\u0000');
    const problem = keyProblem(key, baseline, baseName) ?? keyProblem(key, member, memberName);
    if (problem) return { key: null, label: 'whole rows', note: `${problem} Whole rows were compared instead.` };
    return { key, label: key.join(', '), note: null };
  }, [baseline, member, keyMode, candidates, baseName, memberName]);

  const diff = useMemo(
    () => (baseline && member ? rowDiff(baseline, member, resolved.key) : null),
    [baseline, member, resolved.key],
  );

  if (!baseline || !member || !diff) return null;

  const keyIdx = (diff.key ?? []).map((k) => diff.columns.indexOf(k));
  const selectClass =
    'bg-surface border border-card-border rounded px-1.5 py-0.5 text-[11px] text-ink focus:outline-none focus:border-accent';

  return (
    <section className="flex flex-col gap-2.5 max-w-[1100px]">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide text-ink-muted">Row differences</span>

        {differing.length > 1 ? (
          <span className="flex items-center gap-1">
            {differing.map((r) => (
              <button
                key={r.connectionId}
                onClick={() => setPicked(r.connectionId)}
                className={`px-2 py-0.5 rounded text-[11px] border ${
                  r.connectionId === member.connectionId
                    ? 'border-accent text-ink'
                    : 'border-card-border text-ink-faint hover:text-ink-muted'
                }`}
              >
                {byId.get(r.connectionId)?.name ?? r.connectionId}
              </button>
            ))}
          </span>
        ) : (
          <span className="text-[11px] text-ink-muted">
            {memberName} against {baseName}
          </span>
        )}

        <label className="flex items-center gap-1.5 text-[10px] text-ink-faint">
          matched on
          <select
            className={selectClass}
            value={keyMode}
            onChange={(e) => setKeyMode(e.target.value)}
            aria-label="Columns to match rows on"
          >
            <option value={AUTO}>{keyMode === AUTO ? resolved.label : 'the table’s key'}</option>
            {candidates.map((c) => (
              <option key={c.columns.join('\u0000')} value={c.columns.join('\u0000')}>
                {c.columns.join(', ')} — {c.source}
              </option>
            ))}
            {diff.columns
              .filter((n) => !candidates.some((c) => c.columns.length === 1 && c.columns[0] === n))
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            <option value={WHOLE}>whole rows — no key</option>
          </select>
        </label>
      </div>

      <p className="text-[11px] text-ink">{rowDiffSentence(diff, baseName, memberName)}</p>
      {resolved.note && <p className="text-[11px] text-ink-faint leading-snug max-w-[80ch]">{resolved.note}</p>}

      {diff.changed.length > 0 && (
        <Block title={`Changed in ${memberName}`} count={diff.changed.length}>
          <table className="text-[11px] font-mono border-collapse">
            <thead>
              <tr>
                {(diff.key ?? []).map((k) => (
                  <Th key={k}>{k}</Th>
                ))}
                <Th>column</Th>
                <Th>{baseName}</Th>
                <Th>{memberName}</Th>
              </tr>
            </thead>
            <tbody>
              {diff.changed.slice(0, SHOWN).flatMap((change, i) =>
                change.changed.map((c, j) => (
                  <tr key={`${i}:${c.column}`} className={j === 0 ? 'border-t border-card' : ''}>
                    {change.key.map((v, k) => (
                      <Td key={k} faint={j > 0}>
                        {j === 0 ? <Value cell={v} /> : null}
                      </Td>
                    ))}
                    <Td>{c.column}</Td>
                    <Td tone="bad">
                      <Value cell={c.baseline} />
                    </Td>
                    <Td tone="warn">
                      <Value cell={c.here} />
                    </Td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </Block>
      )}

      {diff.onlyBaseline.length > 0 && (
        <Block title={`Only in ${baseName}`} count={diff.onlyBaseline.length}>
          <Rows columns={diff.columns} rows={diff.onlyBaseline} keyIdx={keyIdx} />
        </Block>
      )}

      {diff.onlyHere.length > 0 && (
        <Block title={`Only in ${memberName}`} count={diff.onlyHere.length}>
          <Rows columns={diff.columns} rows={diff.onlyHere} keyIdx={keyIdx} />
        </Block>
      )}
    </section>
  );
}

function Block({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded border border-card-border overflow-hidden">
      <div className="px-2.5 py-1.5 bg-surface-muted border-b border-card-border flex items-baseline gap-2">
        <span className="text-[11px] text-ink">{title}</span>
        <span className="text-[10px] text-ink-faint tabular-nums">
          {count.toLocaleString()} row{count === 1 ? '' : 's'}
          {count > SHOWN ? ` — the first ${SHOWN} shown` : ''}
        </span>
      </div>
      <div className="overflow-auto max-h-[320px]">{children}</div>
    </div>
  );
}

function Rows({ columns, rows, keyIdx }: { columns: string[]; rows: Cell[][]; keyIdx: number[] }): JSX.Element {
  return (
    <table className="text-[11px] font-mono border-collapse">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <Th key={c} strong={keyIdx.includes(i)}>
              {c}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, SHOWN).map((row, i) => (
          <tr key={i} className="border-t border-card">
            {row.map((cell, j) => (
              <Td key={j}>
                <Value cell={cell} />
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, strong }: { children: React.ReactNode; strong?: boolean }): JSX.Element {
  return (
    <th
      className={`sticky top-0 bg-surface text-left font-normal px-2.5 py-1 whitespace-nowrap border-b border-card-border ${
        strong ? 'text-ink' : 'text-ink-faint'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  tone,
  faint,
}: {
  children: React.ReactNode;
  tone?: 'bad' | 'warn';
  faint?: boolean;
}): JSX.Element {
  const color =
    tone === 'bad'
      ? 'text-bad/90 bg-bad/[0.06]'
      : tone === 'warn'
        ? 'text-warn/90 bg-warn/[0.06]'
        : faint
          ? 'text-ink-faint'
          : 'text-ink-muted';
  return <td className={`px-2.5 py-1 whitespace-nowrap max-w-[360px] truncate ${color}`}>{children}</td>;
}

/// A cell as text. NULL is drawn as a word, apart from the empty string it
/// would otherwise look identical to — and in a diff, that difference is
/// sometimes the whole finding.
function Value({ cell }: { cell: Cell }): JSX.Element {
  if (cell === null) return <span className="italic text-ink-faint">NULL</span>;
  if (typeof cell === 'object') return <span className="text-ink-faint">‹{cell.byteLength.toLocaleString()} bytes›</span>;
  if (cell === '') return <span className="text-ink-faint">''</span>;
  return <span title={String(cell)}>{String(cell)}</span>;
}
