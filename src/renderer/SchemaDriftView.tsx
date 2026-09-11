import { useEffect, useMemo, useState } from 'react';
import type { Connection, EnvSet, SchemaSnapshot } from '@shared/types';
import { buildMigration } from '@shared/migrationSql';
import {
  diffSchemas,
  driftSummary,
  type DriftFinding,
  type DriftSeverity,
  type SchemaDrift,
} from '@shared/schemaDiff';
import { useStore } from './store';

/// Has this environment drifted from the baseline?
///
/// The question the whole app is built around, asked without running
/// anything: two catalogs, one baseline, and a verdict per member. Nothing
/// here touches a row — every statement it issues is the same catalog read
/// the schema tree already does, and it stays read-only on prod regardless
/// of arm state.
///
/// The panel is ordered by what will bite you. Breaking findings first,
/// quiet ones folded away and counted, because a list that mixes "this
/// column does not exist here" with "this server spells varchar differently"
/// gets skimmed, and then ignored, and then the panel may as well not exist.

const TONE: Record<DriftSeverity, string> = {
  breaking: 'text-bad/90',
  notable: 'text-warn/90',
  quiet: 'text-ink-faint',
};

const DOT: Record<DriftSeverity, string> = {
  breaking: 'bg-bad/80',
  notable: 'bg-warn/85',
  quiet: 'bg-ink-faint/60',
};

interface MemberDrift {
  connection: Connection;
  snapshot: SchemaSnapshot | undefined;
  drift: SchemaDrift | null;
  error: string | undefined;
  loading: boolean;
}

export function SchemaDriftView({ envSet }: { envSet: EnvSet }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const schemas = useStore((s) => s.schemas);
  const schemaError = useStore((s) => s.schemaError);
  const schemaLoading = useStore((s) => s.schemaLoading);
  const loadSchema = useStore((s) => s.loadSchema);
  const toast = useStore((s) => s.toast);

  const [showQuiet, setShowQuiet] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [migrationFor, setMigrationFor] = useState<string | null>(null);

  const members = useMemo(
    () =>
      envSet.memberIds
        .map((id) => connections.find((c) => c.id === id))
        .filter((c): c is Connection => Boolean(c)),
    [envSet.memberIds, connections],
  );

  // Read every member's catalog on open. Introspection is cached per
  // connection (src/main/schemaCache.ts), so this is a round trip once and
  // free after — and a comparison you have to press a button to start is a
  // comparison people forget to run.
  useEffect(() => {
    for (const m of members) void loadSchema(m.id);
  }, [members, loadSchema]);

  const baselineId = envSet.baselineId ?? null;
  const baselineSnapshot = baselineId ? schemas[baselineId] : undefined;

  // Memoised because diffing two full catalogs is not free, and without
  // this it ran again on every keystroke, checkbox and expand — a
  // thousand-table comparison per render.
  const baselineVariant = connections.find((c) => c.id === baselineId)?.variant;
  const rows: MemberDrift[] = useMemo(
    () =>
      members.map((connection) => {
        const snapshot = schemas[connection.id];
        const drift =
          snapshot && baselineSnapshot && connection.id !== baselineId
            ? diffSchemas(baselineSnapshot, snapshot, {
                baselineVariant,
                hereVariant: connection.variant,
              })
            : null;
        return {
          connection,
          snapshot,
          drift,
          error: schemaError[connection.id],
          loading: Boolean(schemaLoading[connection.id]),
        };
      }),
    [members, schemas, baselineSnapshot, baselineId, baselineVariant, schemaError, schemaLoading],
  );

  if (baselineId === null) {
    return (
      <Note>
        This set has no baseline. Drift is always measured against one — “prod is the truth,
        staging drifted” is a sentence; five environments compared with each other is a matrix
        nobody reads. Edit the set to pick one.
      </Note>
    );
  }
  if (members.length < 2) {
    return <Note>A set needs at least two connections before there is anything to compare.</Note>;
  }

  const active = rows.find((r) => r.connection.id === selected) ?? null;
  const migrationRow = rows.find((r) => r.connection.id === migrationFor) ?? null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b border-card px-3.5 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-ink-muted">
          Catalogs compared against{' '}
          <span className="text-ink">{members.find((m) => m.id === baselineId)?.name}</span>
        </span>
        <button
          onClick={() => {
            for (const m of members) void loadSchema(m.id, { force: true });
          }}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          Re-read
        </button>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <input
            type="checkbox"
            checked={showQuiet}
            onChange={(e) => setShowQuiet(e.target.checked)}
          />
          show differences that change nothing
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.map((row) => (
          <MemberSection
            key={row.connection.id}
            row={row}
            isBaseline={row.connection.id === baselineId}
            expanded={selected === row.connection.id}
            showQuiet={showQuiet}
            onToggle={() =>
              setSelected(selected === row.connection.id ? null : row.connection.id)
            }
            onMigration={() => setMigrationFor(row.connection.id)}
          />
        ))}

        {!baselineSnapshot && (
          <p className="px-3.5 py-3 text-[11px] text-ink-faint">
            Reading the baseline's catalog…
          </p>
        )}
      </div>

      {migrationRow?.drift && baselineSnapshot && (
        <MigrationPanel
          row={migrationRow}
          baseline={baselineSnapshot}
          onClose={() => setMigrationFor(null)}
          onCopied={() => toast('Migration copied. Nothing has run.')}
        />
      )}

      {active === null && (
        <p className="shrink-0 border-t border-card px-3.5 py-1.5 text-[10px] text-ink-faint">
          Nothing on this screen runs anything. overdb read each server's catalog and compared the
          two — it did not look at a single row.
        </p>
      )}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-10">
      <p className="text-xs text-ink-muted leading-relaxed max-w-[62ch] text-center">{children}</p>
    </div>
  );
}

function MemberSection({
  row,
  isBaseline,
  expanded,
  showQuiet,
  onToggle,
  onMigration,
}: {
  row: MemberDrift;
  isBaseline: boolean;
  expanded: boolean;
  showQuiet: boolean;
  onToggle(): void;
  onMigration(): void;
}): JSX.Element {
  const { connection, drift, error, loading } = row;

  const verdict = isBaseline
    ? 'the baseline'
    : error
      ? 'could not read its catalog'
      : loading || !drift
        ? 'reading…'
        : driftSummary(drift, connection.name).replace(`${connection.name}: `, '').replace(`${connection.name} `, '');

  const severity: DriftSeverity | null =
    !drift || isBaseline
      ? null
      : drift.counts.breaking > 0
        ? 'breaking'
        : drift.counts.notable > 0
          ? 'notable'
          : 'quiet';

  const shown = (drift?.findings ?? []).filter((f) => showQuiet || f.severity !== 'quiet');

  return (
    <div className="border-b border-card">
      <button
        onClick={onToggle}
        disabled={isBaseline || !drift}
        className="w-full text-left px-3.5 py-2 flex items-center gap-2.5 hover:bg-card disabled:hover:bg-transparent"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isBaseline
              ? 'bg-accent'
              : error
                ? 'bg-bad/80'
                : severity
                  ? DOT[severity]
                  : 'bg-ink-faint/40'
          }`}
        />
        <span className="text-xs text-ink">{connection.name}</span>
        {connection.env && (
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">{connection.env}</span>
        )}
        <span className={`text-[11px] ${severity ? TONE[severity] : 'text-ink-faint'}`}>
          {error ?? verdict}
        </span>
        <div className="flex-1" />
        {drift && drift.verdict === 'drift' && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onMigration();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onMigration();
              }
            }}
            className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink"
          >
            Proposed SQL
          </span>
        )}
        {drift && shown.length > 0 && (
          <span className="text-[10px] text-ink-faint tabular-nums">
            {expanded ? '▾' : '▸'} {shown.length}
          </span>
        )}
      </button>

      {expanded && drift && (
        <div className="pb-2">
          {drift.crossEngine && (
            <p className="mx-3.5 mb-2 px-2.5 py-1.5 rounded border border-card text-[11px] text-warn/90 leading-relaxed">
              These two run different engines. Their catalogs do not mean the same thing closely
              enough for a verdict, so everything below is advice, not drift.
            </p>
          )}

          {drift.onlyInBaseline.length > 0 && (
            <p className="px-3.5 pb-1.5 text-[11px] text-ink-muted">
              The baseline has schemas this one does not:{' '}
              <span className="font-mono text-ink">{drift.onlyInBaseline.join(', ')}</span>. Usually
              that means this connection points at a different database, not that four hundred
              tables were dropped — so they are not listed as findings.
            </p>
          )}

          {drift.unread.length > 0 && (
            <p className="px-3.5 pb-1.5 text-[10px] text-ink-faint">
              {drift.unread.length} table{drift.unread.length === 1 ? '' : 's'} were held by name
              only on one side and not compared.
            </p>
          )}

          {drift.unreadable.length > 0 && (
            <p className="px-3.5 pb-1.5 text-[10px] text-ink-faint">
              {drift.unreadable.length} index
              {drift.unreadable.length === 1 ? '' : 'es'} or constraint
              {drift.unreadable.length === 1 ? '' : 's'} could not be compared — the catalog gave
              no column list for {drift.unreadable.slice(0, 2).join(', ')}
              {drift.unreadable.length > 2 && ' and others'}.
            </p>
          )}

          {shown.length === 0 ? (
            <p className="px-3.5 py-1 text-[11px] text-ink-faint">
              {drift.counts.quiet > 0
                ? `Nothing that changes behaviour. ${drift.counts.quiet} difference${drift.counts.quiet === 1 ? '' : 's'} in spelling — tick the box above to see them.`
                : 'Identical to the baseline.'}
            </p>
          ) : (
            <FindingList findings={shown} />
          )}
        </div>
      )}
    </div>
  );
}

/// Findings, grouped by table. A flat list of two hundred lines is a wall;
/// the unit people act on is a table.
function FindingList({ findings }: { findings: DriftFinding[] }): JSX.Element {
  const groups = new Map<string, DriftFinding[]>();
  for (const f of findings) {
    const key = `${f.schema}.${f.table}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  return (
    <div className="px-3.5">
      {[...groups].map(([table, list]) => (
        <div key={table} className="mb-2">
          <p className="text-[10px] font-mono text-ink-muted mb-0.5">{table}</p>
          {list.map((f, i) => (
            <p key={i} className="flex items-baseline gap-2 py-0.5 text-[11px] leading-relaxed">
              <span className={`w-1 h-1 rounded-full mt-1.5 shrink-0 ${DOT[f.severity]}`} />
              <span className={f.severity === 'quiet' ? 'text-ink-faint' : 'text-ink-muted'}>
                {f.sentence}
              </span>
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/// The DDL that would close the gap — text, and nothing else.
///
/// There is no Run here on purpose, and not for lack of a code path: this
/// is generated from a catalog comparison, and a catalog comparison cannot
/// know whether the column it wants to add has to be backfilled first.
function MigrationPanel({
  row,
  baseline,
  onClose,
  onCopied,
}: {
  row: MemberDrift;
  baseline: SchemaSnapshot;
  onClose(): void;
  onCopied(): void;
}): JSX.Element {
  const [includeQuiet, setIncludeQuiet] = useState(false);
  const migration = useMemo(
    () =>
      row.drift && row.snapshot
        ? buildMigration(row.drift, baseline, row.snapshot.engine, { includeQuiet })
        : null,
    [row.drift, row.snapshot, baseline, includeQuiet],
  );

  if (!migration) return <></>;

  return (
    <div className="shrink-0 border-t border-card max-h-[45%] flex flex-col">
      <div className="shrink-0 px-3.5 py-1.5 flex items-center gap-3 border-b border-card">
        <span className="text-[11px] text-ink">
          Proposed for {row.connection.name} — {migration.statementCount} statement
          {migration.statementCount === 1 ? '' : 's'}
        </span>
        <label className="flex items-center gap-1.5 text-[10px] text-ink-faint">
          <input
            type="checkbox"
            checked={includeQuiet}
            onChange={(e) => setIncludeQuiet(e.target.checked)}
          />
          include spelling differences
        </label>
        <div className="flex-1" />
        <button
          onClick={() => {
            void window.overdb.invoke('app:copyText', migration.sql);
            onCopied();
          }}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink"
        >
          Copy
        </button>
        <button
          onClick={onClose}
          className="text-[11px] px-2 py-0.5 text-ink-faint hover:text-ink"
        >
          Close
        </button>
      </div>

      <pre className="flex-1 overflow-auto px-3.5 py-2 text-[11px] font-mono text-ink-muted whitespace-pre-wrap">
        {migration.sql}
      </pre>

      {migration.unhandled.length > 0 && (
        <div className="shrink-0 border-t border-card px-3.5 py-1.5 max-h-24 overflow-y-auto">
          <p className="text-[10px] text-ink-faint mb-0.5">
            Not expressible as DDL — {migration.unhandled.length} finding
            {migration.unhandled.length === 1 ? '' : 's'}:
          </p>
          {migration.unhandled.slice(0, 8).map((u, i) => (
            <p key={i} className="text-[10px] text-ink-faint">
              · {u.finding.table}
              {u.finding.object ? `.${u.finding.object}` : ''} — {u.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
