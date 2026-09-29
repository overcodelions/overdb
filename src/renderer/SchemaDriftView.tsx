import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, EnvSet, SavedCatalog, SchemaInfo, SchemaSnapshot } from '@shared/types';
import { ago } from '@shared/history';
import { buildMigration } from '@shared/migrationSql';
import {
  diffSchemas,
  consequenceOf,
  globToRegExp,
  suggestIgnores,
  type DriftConsequence,
  type DriftFinding,
  type SchemaDrift,
} from '@shared/schemaDiff';
import {
  CONSEQUENCE_ORDER,
  CONSEQUENCE_TEXT,
  gridEntries,
  tableGrid,
  tally,
  wordDiff,
  type GridEntry,
  type GridRow,
} from '@shared/driftDdl';
import { driftReport } from '@shared/driftReport';
import { useStore } from './store';
import { SchemaBar } from './SchemaBar';

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
///
/// The same goes for tables only one side has. When the baseline is your
/// laptop, most of those are either work not deployed yet or scratch copies
/// that will never be, and forty `TMP_…` lines at breaking weight bury the
/// three column changes that matter. So they are split out, and scratch
/// names can be ignored by pattern — per set, and always shown as ignored
/// rather than silently gone.

type BaselineOnly = NonNullable<EnvSet['baselineOnly']>;

interface MemberDrift {
  connection: Connection;
  snapshot: SchemaSnapshot | undefined;
  drift: SchemaDrift | null;
  error: string | undefined;
  loading: boolean;
  /// The one schema on each side this member was compared in, and how many
  /// tables the two have in common — so "no findings" can be told apart
  /// from "compared nothing".
  scope: { baseline: string; here: string; shared: number } | null;
  /// Both sides narrowed to that schema, as the diff and the migration
  /// need them.
  baseline: SchemaSnapshot | undefined;
  here: SchemaSnapshot | undefined;
  /// When this member was compared through its kept catalog, when that was
  /// read. Null for a live comparison.
  kept: string | null;
  reaching: boolean;
}

interface Side {
  snapshot: SchemaSnapshot;
  info: SchemaInfo;
  source: 'live' | 'kept';
  savedAt?: string;
}

/// A schema whose columns were actually read, as opposed to one the schema
/// tree holds by table name only. An empty schema counts as read.
const isRead = (s: SchemaInfo): boolean =>
  s.tables.length === 0 || s.tables.some((t) => t.columns.length > 0);

/// One schema of a snapshot, renamed. Both sides of a comparison go in
/// under the member's name for it, so `acme` locally and `acmeprod` on prod
/// line up as the same thing — and the migration comes out qualified with
/// the name it will run against.
const scoped = (snap: SchemaSnapshot, info: SchemaInfo, as: string): SchemaSnapshot => ({
  ...snap,
  schemas: [{ ...info, name: as }],
});

const tableKey = (f: { schema: string; table: string }): string => `${f.schema}.${f.table}`;

export function SchemaDriftView({ envSet: given }: { envSet: EnvSet }): JSX.Element {
  // The prop can be a copy taken before the drift prefs were last saved.
  const envSet = useStore((s) => s.envSets.find((e) => e.id === given.id)) ?? given;
  const connections = useStore((s) => s.connections);
  const schemas = useStore((s) => s.schemas);
  const schemaError = useStore((s) => s.schemaError);
  const schemaLoading = useStore((s) => s.schemaLoading);
  const loadSchema = useStore((s) => s.loadSchema);
  const setDriftPrefs = useStore((s) => s.setDriftPrefs);
  const activeSchema = useStore((s) => s.activeSchema);
  const connectError = useStore((s) => s.connectError);
  const toast = useStore((s) => s.toast);

  const [showQuiet, setShowQuiet] = useState(false);
  // Members whose column is turned off. Every member shows by default —
  // up to three beside the baseline; past that, a grid nobody reads.
  const [hidden, setHidden] = useState<string[]>([]);
  const [migrationFor, setMigrationFor] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Baseline-only tables ticked for the proposed SQL, by member.
  const [included, setIncluded] = useState<Record<string, string[]>>({});

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

  // The last catalog overdb read from each member, per schema, kept on
  // disk. A member that cannot be reached right now — on a VPN you are not
  // on — is compared through it instead of not at all.
  const [kept, setKept] = useState<Record<string, SavedCatalog[]>>({});
  useEffect(() => {
    for (const m of members) {
      window.overdb
        .invoke('catalog:list', { connectionId: m.id })
        .then((list) => setKept((k) => ({ ...k, [m.id]: list })))
        .catch(() => undefined);
    }
  }, [members]);
  const keptFor = (id: string, name: string | undefined): SavedCatalog | undefined => {
    const list = kept[id] ?? [];
    if (name) return list.find((c) => c.schema === name);
    return [...list].sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  };

  // Which schema each member is compared in: the set's own choice (the bar
  // above, shared with the fan-out), else what the session is on, else the
  // one schema the catalog read in full, else the one last kept.
  const schemaOf = (id: string): string | undefined =>
    envSet.memberSchemas?.[id] ||
    activeSchema[id] ||
    schemas[id]?.schemas.find((sc) => sc.tables.some((t) => t.columns.length > 0))?.name ||
    keptFor(id, undefined)?.schema;

  // The schema tree reads one schema in full and holds the rest by name.
  // A schema picked here that it has not read is read for this view alone,
  // keyed `id:schema`; null when the read failed.
  const [fetched, setFetched] = useState<Record<string, SchemaInfo | null>>({});
  const [fetchError, setFetchError] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());

  const liveOf = (id: string, name: string | undefined): SchemaInfo | null | undefined => {
    if (!name || !schemas[id]) return undefined;
    const held = schemas[id].schemas.find((sc) => sc.name === name);
    if (held && isRead(held)) return held;
    return fetched[`${id}:${name}`];
  };

  /// One member's side of a comparison: live when it can be read, the kept
  /// catalog when it cannot, undefined while neither is in yet.
  const sideOf = (id: string): Side | undefined => {
    const name = schemaOf(id);
    const live = liveOf(id, name);
    const snap = schemas[id];
    if (live && snap) return { snapshot: snap, info: live, source: 'live' };
    const k = keptFor(id, name);
    if (!k) return undefined;
    return {
      snapshot: { engine: k.engine, serverVersion: k.serverVersion, capturedAt: k.savedAt, schemas: [] },
      info: k.info,
      source: 'kept',
      savedAt: k.savedAt,
    };
  };

  useEffect(() => {
    for (const m of members) {
      const name = schemaOf(m.id);
      const key = `${m.id}:${name}`;
      // Wait for the store's own read: it is what opens the connection.
      if (!name || !schemas[m.id] || liveOf(m.id, name) !== undefined) continue;
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      window.overdb
        .invoke('conn:introspect', { connectionId: m.id, schemas: [name] })
        .then((snap) => {
          const info = snap.schemas.find((sc) => sc.name === name) ?? { name, tables: [] };
          setFetched((f) => ({ ...f, [key]: info }));
        })
        .catch((err: unknown) => {
          setFetched((f) => ({ ...f, [key]: null }));
          setFetchError((e) => ({ ...e, [m.id]: err instanceof Error ? err.message : String(err) }));
        })
        .finally(() => inFlight.current.delete(key));
    }
  });

  // Keep every catalog read live, so the next time this member is out of
  // reach there is something to compare against. Once per read.
  const keptOnce = useRef(new WeakSet<SchemaInfo>());
  useEffect(() => {
    for (const m of members) {
      const name = schemaOf(m.id);
      const live = liveOf(m.id, name);
      const snap = schemas[m.id];
      if (!name || !live || !snap || keptOnce.current.has(live)) continue;
      keptOnce.current.add(live);
      const catalog: SavedCatalog = {
        connectionId: m.id,
        schema: name,
        savedAt: new Date().toISOString(),
        engine: snap.engine,
        serverVersion: snap.serverVersion,
        info: live,
      };
      void window.overdb.invoke('catalog:save', catalog).then(() =>
        setKept((k) => ({
          ...k,
          [m.id]: [...(k[m.id] ?? []).filter((c) => c.schema !== name), catalog],
        })),
      );
    }
  });

  // What each unreachable member is being compared in, for the Schema bar.
  const keptSchemas = Object.fromEntries(
    members.flatMap((m) => {
      const side = sideOf(m.id);
      return side?.source === 'kept' ? [[m.id, side.info.name]] : [];
    }),
  );

  const baselineId = envSet.baselineId ?? null;
  const baselineName = members.find((m) => m.id === baselineId)?.name ?? 'the baseline';
  const ignoreTables = envSet.ignoreTables;
  const baselineOnly: BaselineOnly = envSet.baselineOnly ?? 'pending';

  // Memoised because diffing two full catalogs is not free, and without
  // this it ran again on every keystroke, checkbox and expand — a
  // thousand-table comparison per render.
  const baselineVariant = connections.find((c) => c.id === baselineId)?.variant;
  const baseSide = baselineId ? sideOf(baselineId) : undefined;
  const scopeKey = members.map((m) => `${m.id}=${schemaOf(m.id) ?? ''}`).join(',');
  const rows: MemberDrift[] = useMemo(
    () =>
      members.map((connection) => {
        const id = connection.id;
        const snapshot = schemas[id];
        const here = sideOf(id);
        const isBase = id === baselineId;
        const hereName = here?.info.name;
        const ready = baseSide && here && hereName && !isBase;
        const baseline = ready ? scoped(baseSide.snapshot, baseSide.info, hereName) : undefined;
        const hereScoped = ready ? scoped(here.snapshot, here.info, hereName) : undefined;
        const drift =
          ready && baseline && hereScoped
            ? diffSchemas(baseline, hereScoped, {
                baselineVariant,
                hereVariant: connection.variant,
                ignoreTables,
                baselineOnly: baselineOnly === 'drift' ? 'drift' : 'pending',
              })
            : null;
        const shared = ready
          ? here.info.tables.filter((t) => baseSide.info.tables.some((b) => b.name === t.name)).length
          : 0;
        const liveFailed = liveOf(id, schemaOf(id)) === null;
        const error = here
          ? undefined
          : (schemaError[id] ??
            connectError[id] ??
            (liveFailed ? `could not read ${schemaOf(id)}: ${fetchError[id] ?? 'no reply'}` : undefined));
        return {
          connection,
          snapshot,
          drift,
          error,
          loading: !here && !error,
          scope: ready ? { baseline: baseSide.info.name, here: hereName, shared } : null,
          baseline,
          here: hereScoped,
          kept: here?.source === 'kept' ? (here.savedAt ?? null) : null,
          // Still trying the live one while the kept one stands in.
          reaching: here?.source === 'kept' && Boolean(schemaLoading[id]),
        };
      }),
    // sideOf, schemaOf and liveOf read the values listed here; scopeKey
    // stands in for the per-member schema choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      members,
      schemas,
      baselineId,
      baselineVariant,
      baseSide?.info,
      baseSide?.snapshot,
      kept,
      fetched,
      fetchError,
      scopeKey,
      ignoreTables,
      baselineOnly,
      schemaError,
      connectError,
      schemaLoading,
    ],
  );

  // Every table only one side has, on any member, ignored or not: what the
  // patterns in the rail are counted and suggested against.
  const oneSided = useMemo(() => {
    const seen = new Map<string, { schema: string; table: string }>();
    for (const { drift } of rows) {
      if (!drift) continue;
      const all = [
        ...drift.ignored,
        ...drift.pending,
        ...drift.findings.filter((f) => f.kind === 'table-missing' || f.kind === 'table-extra'),
      ];
      for (const t of all) seen.set(tableKey(t), { schema: t.schema, table: t.table });
    }
    return [...seen.values()];
  }, [rows]);

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

  const others = rows.filter((r) => r.connection.id !== baselineId);
  // Each member's colour follows it, whichever others are showing.
  const toneOf = (id: string): Tone => TONES[Math.max(0, others.findIndex((r) => r.connection.id === id)) % TONES.length];
  const cols = others.filter((r) => r.drift && !hidden.includes(r.connection.id)).slice(0, MAX_COLUMNS);
  // One member to compare, and its comparison in hand: the member list would
  // be one row saying what the detail below already says.
  const single = others.length === 1 && cols.length === 1;
  const toggle = (id: string) => {
    if (hidden.includes(id)) setHidden(hidden.filter((h) => h !== id));
    else if (cols.length > 1 || !cols.some((c) => c.connection.id === id)) setHidden([...hidden, id]);
  };
  const migrationRow = rows.find((r) => r.connection.id === migrationFor) ?? null;
  const patterns = ignoreTables ?? [];

  const addPattern = (pattern: string) => {
    const p = pattern.trim();
    if (!p || patterns.some((x) => x.toLowerCase() === p.toLowerCase())) return;
    void setDriftPrefs(envSet.id, { ignoreTables: [...patterns, p] });
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <SchemaBar
        envSet={envSet}
        members={members}
        sides={Object.fromEntries(
          members.map((m) => [m.id, m.id === baselineId ? 'base' : toneOf(m.id)] as const),
        )}
        kept={keptSchemas}
      >
        {baseSide?.savedAt && (
          <span className="text-[10px] text-warn/90">
            {baselineName}: catalog as kept {ago(Date.parse(baseSide.savedAt))}
          </span>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <input
            type="checkbox"
            checked={showQuiet}
            onChange={(e) => setShowQuiet(e.target.checked)}
          />
          show differences that change nothing
        </label>
        <button
          onClick={() => {
            setFetched({});
            setFetchError({});
            for (const m of members) void loadSchema(m.id, { force: true });
          }}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          Re-read
        </button>
      </SchemaBar>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {!single && (
          <div className="shrink-0 max-h-[40%] overflow-y-auto border-b border-card">
            {rows.map((row) => {
              const id = row.connection.id;
              return (
                <MemberRow
                  key={id}
                  row={row}
                  baselineName={baselineName}
                  isBaseline={id === baselineId}
                  selected={cols.includes(row)}
                  tone={id === baselineId ? null : toneOf(id)}
                  baselineOnly={baselineOnly}
                  showQuiet={showQuiet}
                  onSelect={() => toggle(id)}
                />
              );
            })}

            {!baseSide && (
              <p className="px-3.5 py-3 text-[11px] text-ink-faint">
                {baselineId && connectError[baselineId]
                  ? `Could not reach ${baselineName}, and overdb has not kept a catalog from it yet. Connect once — on its VPN, if it needs one — and its catalog is kept from then on.`
                  : "Reading the baseline's catalog…"}
              </p>
            )}
          </div>
          )}

          {cols.length > 0 ? (
            <DriftDetail
              cols={cols}
              tones={cols.map((c) => toneOf(c.connection.id))}
              baselineName={baselineName}
              baselineKept={Boolean(baseSide?.savedAt)}
              showQuiet={showQuiet}
              baselineOnly={baselineOnly}
              included={included}
              onInclude={(memberId, key, on) =>
                setIncluded((all) => {
                  const ticked = all[memberId] ?? [];
                  return {
                    ...all,
                    [memberId]: on ? [...new Set([...ticked, key])] : ticked.filter((k) => k !== key),
                  };
                })
              }
              onIgnore={addPattern}
              onRules={() => setRulesOpen(true)}
              onMigration={(id) => setMigrationFor(id)}
              onCopied={() => toast('Copied. Nothing has run.')}
              setName={envSet.name}
              ignorePatterns={patterns}
              onToast={toast}
            />
          ) : (
            <div className="flex-1" />
          )}
        </div>

        {rulesOpen && (
          <IgnoreRail
            patterns={patterns}
            oneSided={oneSided}
            baselineName={baselineName}
            baselineOnly={baselineOnly}
            onAdd={addPattern}
            onRemove={(p) =>
              void setDriftPrefs(envSet.id, { ignoreTables: patterns.filter((x) => x !== p) })
            }
            onBaselineOnly={(m) => void setDriftPrefs(envSet.id, { baselineOnly: m })}
            onClose={() => setRulesOpen(false)}
          />
        )}
      </div>

      {migrationRow?.drift && migrationRow.baseline && (
        <MigrationPanel
          row={{
            ...migrationRow,
            // Ticked baseline-only tables ride along as the findings they
            // would have been, so the CREATE TABLEs come out in order.
            drift: withIncluded(migrationRow.drift, included[migrationRow.connection.id] ?? []),
          }}
          baseline={migrationRow.baseline}
          baselineName={baselineName}
          onClose={() => setMigrationFor(null)}
          onCopied={() => toast('Migration copied. Nothing has run.')}
        />
      )}

      {cols.length === 0 && (
        <p className="shrink-0 border-t border-card px-3.5 py-1.5 text-[10px] text-ink-faint">
          Nothing on this screen runs anything. overdb read each server's catalog and compared the
          two — it did not look at a single row.
        </p>
      )}
    </div>
  );
}

function withIncluded(drift: SchemaDrift, keys: string[]): SchemaDrift {
  if (keys.length === 0) return drift;
  const extra = drift.pending.filter((f) => keys.includes(tableKey(f)));
  return { ...drift, findings: [...extra, ...drift.findings] };
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-10">
      <p className="text-xs text-ink-muted leading-relaxed max-w-[62ch] text-center">{children}</p>
    </div>
  );
}

/// One member, one line: its verdict, what it was compared in, and whether
/// that was live. Selecting it opens its detail below.
function MemberRow({
  row,
  baselineName,
  isBaseline,
  selected,
  tone,
  baselineOnly,
  showQuiet,
  onSelect,
}: {
  row: MemberDrift;
  baselineName: string;
  isBaseline: boolean;
  selected: boolean;
  /// Its colour in the columns below; null for the baseline.
  tone: Tone | null;
  baselineOnly: BaselineOnly;
  showQuiet: boolean;
  onSelect(): void;
}): JSX.Element {
  const { connection, drift, error, loading } = row;
  const pending = baselineOnly === 'hide' ? [] : (drift?.pending ?? []);

  // In the same words as the cards below it: two vocabularies for one set
  // of findings ("11 notable" over "1 integrity, 3 behaviour…") make the
  // reader reconcile them.
  const counted = tally((drift?.findings ?? []).filter((f) => showQuiet || f.severity !== 'quiet'));
  const worst = counted[0]?.[0] ?? null;
  const parts = counted.map(([c, n]) => `${n} ${CONSEQUENCE[c].title.toLowerCase()}`);
  if (drift && worst !== 'breaks') parts.unshift('nothing breaks');
  if (pending.length > 0) parts.push(`${pending.length} not deployed yet`);
  const verdict = isBaseline
    ? 'the baseline'
    : error
      ? 'could not read its catalog'
      : loading || !drift
        ? 'reading…'
        : counted.length === 0 && pending.length === 0
          ? drift.counts.quiet > 0
            ? 'matches — differences in spelling only'
            : 'matches the baseline'
          : parts.join(' · ');
  const total =
    (drift?.findings ?? []).filter((f) => showQuiet || f.severity !== 'quiet').length + pending.length;

  return (
    <button
      onClick={onSelect}
      disabled={isBaseline || !drift}
      aria-pressed={selected}
      title={
        isBaseline
          ? undefined
          : selected
            ? `Hide ${connection.name}'s column`
            : `Show ${connection.name}'s column`
      }
      className={`w-full text-left px-3.5 py-2 flex items-center gap-2.5 border-b border-card last:border-b-0 border-l-[3px] disabled:hover:bg-transparent ${
        isBaseline ? SIDE.baseline.edge : selected && tone ? SIDE[tone].edge : 'border-l-transparent'
      } ${selected ? 'bg-card' : 'opacity-60 hover:opacity-100 hover:bg-card'}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isBaseline
            ? 'bg-accent'
            : error
              ? 'bg-bad/80'
              : worst
                ? CONSEQUENCE[worst].swatch
                : 'bg-ink-faint/40'
        }`}
      />
      <span className="text-xs text-ink">{connection.name}</span>
      {connection.env && (
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">{connection.env}</span>
      )}
      <span className={`text-[11px] ${error ? 'text-bad/90' : worst ? CONSEQUENCE[worst].text : 'text-ink-faint'}`}>
        {error ?? verdict}
      </span>
      {row.kept && (
        <span
          className="text-[10px] px-1.5 py-px rounded border border-warn/40 text-warn/90"
          title={`${connection.name} could not be reached, so this is its catalog as overdb last read it. Nothing about it is live.`}
        >
          kept catalog · {ago(Date.parse(row.kept))}
          {row.reaching && ' · trying live…'}
        </span>
      )}
      <div className="flex-1" />
      {row.scope && (
        <span
          className="text-[10px] text-ink-faint"
          title={`${connection.name}'s ${row.scope.here} against ${baselineName}'s ${row.scope.baseline}. Change either in the Schema bar above.`}
        >
          <span className="font-mono">
            {row.scope.here === row.scope.baseline
              ? row.scope.here
              : `${row.scope.here} ↔ ${row.scope.baseline}`}
          </span>{' '}
          · {row.scope.shared} table{row.scope.shared === 1 ? '' : 's'} in both
        </span>
      )}
      {drift && total > 0 && (
        <span className="text-[10px] text-ink-faint tabular-nums">
          {selected ? 'shown' : 'hidden'} · {total}
        </span>
      )}
    </button>
  );
}

/// Each consequence's colour, joined to its words from driftDdl.ts.
const STYLE: Record<DriftConsequence | 'pending', { text: string; swatch: string; bar: string }> = {
  breaks: { text: 'text-bad', swatch: 'bg-bad', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-bad))]' },
  integrity: { text: 'text-hot', swatch: 'bg-hot', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-hot))]' },
  behaviour: { text: 'text-warn', swatch: 'bg-warn', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-warn))]' },
  performance: { text: 'text-tag-blue', swatch: 'bg-tag-blue', bar: 'shadow-[inset_0_3px_0_var(--c-tag-blue)]' },
  extra: { text: 'text-accent', swatch: 'bg-accent', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-accent))]' },
  cosmetic: { text: 'text-ink-muted', swatch: 'bg-ink-faint', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-ink-faint))]' },
  pending: { text: 'text-good', swatch: 'bg-good', bar: 'shadow-[inset_0_3px_0_rgb(var(--c-good))]' },
};

const CONSEQUENCE = Object.fromEntries(
  CONSEQUENCE_ORDER.map((c) => [c, { ...CONSEQUENCE_TEXT[c], ...STYLE[c] }]),
) as Record<DriftConsequence | 'pending', (typeof CONSEQUENCE_TEXT)[DriftConsequence] & (typeof STYLE)[DriftConsequence]>;

const CARD_ORDER = CONSEQUENCE_ORDER;

type Tone = 'here' | 'here2' | 'here3';
const TONES: Tone[] = ['here', 'here2', 'here3'];
/// Members shown beside the baseline at once. Past three, a column each is
/// a grid nobody reads; the rest are turned on from the member list.
const MAX_COLUMNS = 3;

/// Each server's column, in its own colour, named on every screen of the
/// scroll: which column is which server is the one thing this view cannot
/// leave to a legend. Literal class names, so Tailwind can see them.
const SIDE: Record<
  'baseline' | Tone,
  { cell: string; mark: string; absent: string; text: string; edge: string; dot: string }
> = {
  baseline: {
    cell: 'border-l-[3px] border-side-base/60 bg-side-base/5',
    mark: 'bg-side-base/20 rounded-sm',
    absent: 'bg-[repeating-linear-gradient(135deg,rgb(var(--c-side-base)/0.09)_0_6px,transparent_6px_12px)] text-side-base',
    text: 'text-side-base',
    edge: 'border-l-side-base',
    dot: 'bg-side-base',
  },
  here: {
    cell: 'border-l-[3px] border-side-here/60 bg-side-here/5',
    mark: 'bg-side-here/25 rounded-sm',
    absent: 'bg-[repeating-linear-gradient(135deg,rgb(var(--c-side-here)/0.09)_0_6px,transparent_6px_12px)] text-side-here',
    text: 'text-side-here',
    edge: 'border-l-side-here',
    dot: 'bg-side-here',
  },
  here2: {
    cell: 'border-l-[3px] border-side-here2/60 bg-side-here2/5',
    mark: 'bg-side-here2/25 rounded-sm',
    absent: 'bg-[repeating-linear-gradient(135deg,rgb(var(--c-side-2)/0.09)_0_6px,transparent_6px_12px)] text-side-here2',
    text: 'text-side-here2',
    edge: 'border-l-side-here2',
    dot: 'bg-side-here2',
  },
  here3: {
    cell: 'border-l-[3px] border-side-here3/60 bg-side-here3/5',
    mark: 'bg-side-here3/25 rounded-sm',
    absent: 'bg-[repeating-linear-gradient(135deg,rgb(var(--c-side-3)/0.09)_0_6px,transparent_6px_12px)] text-side-here3',
    text: 'text-side-here3',
    edge: 'border-l-side-here3',
    dot: 'bg-side-here3',
  },
};

/// Column, baseline, each member, what differs — one template for the
/// sticky header and every row under it, so the two never drift apart.
const gridColumns = (members: number) =>
  `minmax(0,13rem) repeat(${members + 1}, minmax(0,1fr)) 10rem`;

/// Names, as they read in a sentence: "prod-west", "prod-west or sandbox".
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const tableIn = (snap: SchemaSnapshot | undefined, table: string) =>
  snap?.schemas[0]?.tables.find((t) => t.name === table);

/// The members shown, table by table: what kind of trouble it is across
/// the top, every table any of them differs on stacked below — a column per
/// member beside the baseline's — and a list down the side to jump between
/// them.
///
/// Stacked rather than one table at a time: a drift is usually a handful of
/// tables, and scrolling past all of them is faster than clicking each —
/// the same reason a code review shows every changed file on one page.
/// Side by side rather than one member at a time: with three servers, the
/// question is which of them drifted, and whether the same way.
function DriftDetail({
  cols,
  tones,
  baselineName,
  baselineKept,
  showQuiet,
  baselineOnly,
  included,
  onInclude,
  onIgnore,
  onRules,
  onMigration,
  onCopied,
  setName,
  ignorePatterns,
  onToast,
}: {
  cols: MemberDrift[];
  tones: Tone[];
  baselineName: string;
  baselineKept: boolean;
  showQuiet: boolean;
  baselineOnly: BaselineOnly;
  included: Record<string, string[]>;
  onInclude(memberId: string, key: string, on: boolean): void;
  onIgnore(table: string): void;
  onRules(): void;
  onMigration(memberId: string): void;
  onCopied(): void;
  setName: string;
  ignorePatterns: string[];
  onToast(message: string): void;
}): JSX.Element {
  const names = cols.map((c) => c.connection.name);
  const hereLabel = nameList(names);
  const [filter, setFilter] = useState<DriftConsequence | 'pending' | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = (d: SchemaDrift) => d.findings.filter((f) => showQuiet || f.severity !== 'quiet');
  const entries = useMemo(
    () =>
      gridEntries(
        cols.map((c) => ({
          findings: visible(c.drift!),
          pending: baselineOnly === 'hide' ? [] : c.drift!.pending,
        })),
      ),
    // `visible` reads showQuiet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cols, showQuiet, baselineOnly],
  );

  const counts = new Map<DriftConsequence | 'pending', number>(
    tally(entries.tables.flatMap((e) => e.byMember.flat())),
  );
  if (entries.pending.length > 0) counts.set('pending', entries.pending.length);
  // Breaks is always shown, even at zero: "nothing breaks" is the first
  // thing anyone wants to know. The rest appear when they have something.
  const cards = CARD_ORDER.filter((c) => c === 'breaks' || (counts.get(c) ?? 0) > 0);

  const shown = [
    ...(filter === 'pending'
      ? []
      : entries.tables.filter((e) => filter === null || e.consequences.includes(filter as DriftConsequence))),
    ...(filter === null || filter === 'pending' ? entries.pending : []),
  ];
  const shownKey = shown.map((e) => e.table).join('\n');
  const at = shown.find((e) => e.table === current)?.table ?? shown[0]?.table ?? null;

  // The list follows the scroll: whichever section is nearest the top is
  // the one marked, so the side list always says where you are.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (items) => {
        for (const it of items) seen.set((it.target as HTMLElement).dataset.key ?? '', it.isIntersecting);
        const top = shown.find((e) => seen.get(e.table));
        if (top) setCurrent(top.table);
      },
      { root, rootMargin: '0px 0px -70% 0px' },
    );
    root.querySelectorAll('[data-key]').forEach((el) => io.observe(el));
    return () => io.disconnect();
    // shownKey is `shown`, by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  const jump = (table: string) => {
    setCurrent(table);
    document.getElementById(`drift-section-${table}`)?.scrollIntoView({ block: 'start' });
  };
  const move = (by: number) => {
    const i = shown.findIndex((e) => e.table === at);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + by))];
    if (!next) return;
    jump(next.table);
    document.getElementById(`drift-table-${next.table}`)?.focus();
  };

  // The report is what this screen shows — the same rows, the same words,
  // the same columns — made when asked for rather than on every render.
  const makeReport = async () => {
    const first = cols[0];
    if (!first?.baseline) return null;
    const version = await window.overdb
      .invoke('app:version')
      .then((v) => v.app)
      .catch(() => 'unknown');
    return driftReport({
      setName,
      baseline: {
        name: baselineName,
        schema: first.scope?.baseline ?? '',
        readAt: first.baseline.capturedAt,
        kept: baselineKept,
      },
      baselineSnapshot: first.baseline,
      members: cols.flatMap((c) => {
        if (!c.drift || !c.baseline || !c.here) return [];
        const ticked = included[c.connection.id] ?? [];
        const withTicked = withIncluded(c.drift, ticked);
        const sql =
          withTicked.verdict === 'drift' || ticked.length > 0
            ? buildMigration(withTicked, c.baseline, c.here.engine, {
                names: { here: c.connection.name, baseline: baselineName },
              }).sql
            : '';
        return [
          {
            side: {
              name: c.connection.name,
              schema: c.scope?.here ?? '',
              readAt: c.here.capturedAt,
              kept: Boolean(c.kept),
            },
            drift: c.drift,
            snapshot: c.here,
            sql,
          },
        ];
      }),
      showQuiet,
      baselineOnly,
      ignorePatterns,
      version,
      generatedAt: new Date(),
    });
  };
  const exportReport = async () => {
    const report = await makeReport();
    if (!report) return;
    const res = await window.overdb.invoke('app:saveFile', {
      suggestedName: `${report.fileName}.html`,
      data: report.html,
      extensions: ['html'],
      message: 'The report names every schema, table and column compared. No hosts, users or rows.',
    });
    if (res.saved) onToast(`Report saved to ${res.path}.`);
    else if (res.error) onToast(`Could not save the report: ${res.error}`);
  };
  const copyMarkdown = async () => {
    const report = await makeReport();
    if (!report) return;
    await window.overdb.invoke('app:copyText', report.markdown);
    onToast('Report copied as Markdown.');
  };

  const notes: string[] = [];
  for (const c of cols) {
    const d = c.drift!;
    const who = cols.length > 1 ? `${c.connection.name}: ` : '';
    if (c.kept) {
      notes.push(
        `${c.connection.name} could not be reached — this is its catalog as kept ${ago(Date.parse(c.kept))}${
          c.reaching ? ', still trying live.' : '. Nothing about it is live.'
        }`,
      );
    }
    if (d.crossEngine) {
      notes.push(
        `${who}it runs a different engine from ${baselineName}. The two catalogs do not mean the same thing closely enough for a verdict, so its findings are advice, not drift.`,
      );
    }
    if (d.unread.length > 0) {
      notes.push(
        `${who}${d.unread.length} table${d.unread.length === 1 ? ' was' : 's were'} held by name only on one side and not compared.`,
      );
    }
    if (d.unreadable.length > 0) {
      notes.push(
        `${who}${d.unreadable.length} index${d.unreadable.length === 1 ? '' : 'es'} or constraint${d.unreadable.length === 1 ? '' : 's'} could not be compared — the catalog gave no column list for ${d.unreadable.slice(0, 2).join(', ')}${d.unreadable.length > 2 ? ' and others' : ''}.`,
      );
    }
  }
  const ignoredCount = new Set(cols.flatMap((c) => c.drift!.ignored.map((t) => t.table))).size;
  const withSql = cols.filter(
    (c) => c.drift!.verdict === 'drift' || (included[c.connection.id] ?? []).length > 0,
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3.5 pt-3 pb-3 border-b border-card flex flex-col gap-2.5">
        {notes.map((n) => (
          <p key={n} className="text-[11px] text-warn/90 leading-relaxed">
            {n}
          </p>
        ))}
        <div className="flex items-stretch gap-2" role="group" aria-label="Filter by consequence">
          {cards.map((c) => {
            const on = filter === c;
            const meta = CONSEQUENCE[c];
            const n = counts.get(c) ?? 0;
            return (
              <button
                key={c}
                aria-pressed={on}
                onClick={() => setFilter(on ? null : c)}
                className={`flex-1 min-w-0 text-left px-3 py-2 rounded-md border ${meta.bar} ${
                  on ? 'border-accent/60 bg-accent/15' : 'border-card bg-card hover:border-card-border'
                }`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className={`text-base font-semibold tabular-nums ${n > 0 ? meta.text : 'text-ink-faint'}`}>
                    {n}
                  </span>
                  <span className="text-[11px] font-semibold text-ink">
                    {meta.label?.(baselineName, hereLabel) ?? meta.title}
                  </span>
                </span>
                <span className="block mt-0.5 text-[10px] leading-snug text-ink-muted">
                  {meta.sub(baselineName, hereLabel)}
                </span>
              </button>
            );
          })}
          <div className="shrink-0 flex flex-col justify-center gap-1.5 pl-1">
            {withSql.length > 0 && (
              <div className="flex gap-1.5">
                {withSql.map((c) => (
                  <button
                    key={c.connection.id}
                    onClick={() => onMigration(c.connection.id)}
                    className="flex-1 text-[11px] px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong whitespace-nowrap"
                  >
                    {withSql.length === 1 ? 'Proposed SQL for all' : `SQL for ${c.connection.name}`}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={() => void exportReport()}
                title="Save this comparison as one HTML file anyone can open"
                className="flex-1 text-[11px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink"
              >
                Export report…
              </button>
              <button
                onClick={() => void copyMarkdown()}
                title="Copy this comparison as Markdown, for a PR, a ticket or a chat"
                className="text-[11px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink"
              >
                Copy as Markdown
              </button>
            </div>
            <button
              onClick={onRules}
              className="text-[11px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink"
            >
              {ignoredCount > 0 ? `${ignoredCount} table${ignoredCount === 1 ? '' : 's'} ignored` : 'Ignore rules'}
            </button>
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-3.5 py-4 text-[11px] text-ink-faint">
          {filter !== null
            ? 'Nothing in this filter.'
            : cols.some((c) => c.drift!.counts.quiet > 0) && !showQuiet
              ? 'Nothing that changes behaviour — only differences in spelling. Tick the box above to see them.'
              : 'Identical to the baseline.'}
        </p>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <nav
            aria-label="Tables that differ"
            className="w-64 shrink-0 border-r border-card overflow-y-auto py-1.5"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(e.key === 'ArrowDown' ? 1 : -1);
              }
            }}
          >
            {shown.map((e, i) => {
              const which = e.byMember.map((fs, k) => (fs.length ? names[k] : null)).filter(Boolean);
              return (
                <div key={`${e.pending}:${e.table}`}>
                  {e.pending && !shown[i - 1]?.pending && (
                    <p className="px-3.5 pt-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                      Not deployed yet
                    </p>
                  )}
                  <button
                    id={`drift-table-${e.table}`}
                    onClick={() => jump(e.table)}
                    aria-current={at === e.table}
                    title={cols.length > 1 ? `Differs on ${which.join(', ')}` : undefined}
                    className={`w-full flex items-center gap-2 px-3.5 py-1.5 text-left ${
                      at === e.table ? 'bg-accent/15 text-ink' : 'text-ink-muted hover:bg-card hover:text-ink'
                    }`}
                  >
                    <span className="flex gap-0.5 shrink-0 w-6">
                      {e.pending ? (
                        <span className={`w-1.5 h-1.5 rounded-sm ${CONSEQUENCE.pending.swatch}`} />
                      ) : (
                        e.consequences.map((c) => (
                          <span key={c} className={`w-1.5 h-1.5 rounded-sm ${CONSEQUENCE[c].swatch}`} />
                        ))
                      )}
                    </span>
                    <span className="flex-1 min-w-0 font-mono text-[11px] truncate">{e.table}</span>
                    {cols.length > 1 && (
                      <span className="flex gap-0.5 shrink-0" aria-hidden="true">
                        {e.byMember.map((fs, k) => (
                          <span
                            key={k}
                            className={`w-1 h-2.5 rounded-sm ${fs.length ? SIDE[tones[k]].dot : 'bg-card'}`}
                          />
                        ))}
                      </span>
                    )}
                    {!e.pending && (
                      <span className="text-[10px] text-ink-faint tabular-nums">{e.byMember.flat().length}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </nav>

          <div ref={scroller} className="flex-1 min-w-0 overflow-y-auto pb-[40vh]">
            <SidesHeader
              cols={cols}
              tones={tones}
              baselineName={baselineName}
              swapped={swapped && cols.length === 1}
              onSwap={cols.length === 1 ? () => setSwapped(!swapped) : undefined}
            />
            {shown.map((e) => (
              <TableSection
                key={`${e.pending}:${e.table}`}
                entry={e}
                cols={cols}
                tones={tones}
                baselineName={baselineName}
                swapped={swapped && cols.length === 1}
                included={included}
                onInclude={onInclude}
                onIgnore={() => onIgnore(e.table)}
                onCopied={onCopied}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SidesHeader({
  cols,
  tones,
  baselineName,
  swapped,
  onSwap,
}: {
  cols: MemberDrift[];
  tones: Tone[];
  baselineName: string;
  swapped: boolean;
  onSwap?: () => void;
}): JSX.Element {
  const base = (
    <span key="b" className={`px-3 py-2 flex items-center gap-1.5 min-w-0 ${SIDE.baseline.cell}`}>
      <span className="text-[9px] tracking-wider text-side-base shrink-0">★ BASELINE</span>
      <span className="text-[11px] font-semibold text-ink truncate">{baselineName}</span>
      {cols.length === 1 && <span className="text-[10px] text-ink-faint truncate">should look like this</span>}
    </span>
  );
  const members = cols.map((c, i) => (
    <span key={c.connection.id} className={`px-3 py-2 flex items-center gap-1.5 min-w-0 ${SIDE[tones[i]].cell}`}>
      <span className="text-[11px] font-semibold text-ink truncate">{c.connection.name}</span>
      <span className="text-[10px] text-ink-faint truncate">
        {c.kept ? `kept ${ago(Date.parse(c.kept))}, not live` : cols.length === 1 ? 'what it has' : ''}
      </span>
    </span>
  ));
  return (
    <div
      className="sticky top-0 z-20 grid bg-surface border-b border-card-border"
      style={{ gridTemplateColumns: gridColumns(cols.length) }}
    >
      <span className="px-3 py-2 text-[10px] uppercase tracking-wide text-ink-faint">Column / key</span>
      {swapped ? [...members, base] : [base, ...members]}
      <span className="px-3 py-2 flex items-center justify-end">
        {onSwap && (
          <button
            onClick={onSwap}
            aria-pressed={swapped}
            className="text-[10px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink"
          >
            Swap sides
          </button>
        )}
      </span>
    </div>
  );
}

function TableSection({
  entry,
  cols,
  tones,
  baselineName,
  swapped,
  included,
  onInclude,
  onIgnore,
  onCopied,
}: {
  entry: GridEntry;
  cols: MemberDrift[];
  tones: Tone[];
  baselineName: string;
  swapped: boolean;
  included: Record<string, string[]>;
  onInclude(memberId: string, key: string, on: boolean): void;
  onIgnore(): void;
  onCopied(): void;
}): JSX.Element {
  const [expand, setExpand] = useState(false);
  const [openSql, setOpenSql] = useState<string | null>(null);
  const rows = tableGrid(
    tableIn(cols[0]?.baseline, entry.table),
    cols.map((c, i) => ({ findings: entry.byMember[i], table: tableIn(c.here, entry.table) })),
    { expand },
  );

  // Each member's statements for this table: the preamble belongs to the
  // whole migration. Named, because a comment pasted into an editor has no
  // columns to say which server "here" was.
  const migrations = useMemo(
    () =>
      cols.map((c, i) => {
        const fs = entry.byMember[i];
        if (!fs.length || !c.drift || !c.baseline || !c.here) return null;
        return buildMigration({ ...c.drift, findings: fs }, c.baseline, c.here.engine, {
          header: false,
          names: { here: c.connection.name, baseline: baselineName },
        });
      }),
    [cols, entry, baselineName],
  );

  const summary = entry.pending
    ? `only on ${baselineName}, not counted as drift`
    : tally(entry.byMember.flat())
        .map(([c, n]) => `${n} ${CONSEQUENCE[c].title.toLowerCase()}`)
        .join(' · ');
  const canExpand = rows.some((r) => r.fold) || expand;
  // For a table not deployed yet: the members that lack it, and whether it
  // is ticked for each of their proposed SQL.
  const lacking = cols
    .map((c, i) => ({ c, f: entry.byMember[i][0] }))
    .filter((x): x is { c: MemberDrift; f: DriftFinding } => Boolean(x.f));
  const allTicked =
    lacking.length > 0 && lacking.every(({ c, f }) => (included[c.connection.id] ?? []).includes(tableKey(f)));

  const cellFor = (r: GridRow, i: number, context: boolean) => {
    const cell = r.cells[i];
    const style = SIDE[tones[i]];
    const who = cols[i].connection.name;
    if (cell.same && !context) {
      return (
        <span key={i} className={`px-3 py-1.5 font-sans text-[11px] italic text-ink-faint ${style.cell}`}>
          same
        </span>
      );
    }
    const value = cell.same ? r.baseline : cell.value;
    if (value === null) {
      return (
        <span key={i} className={`px-3 py-1.5 italic font-sans text-[11px] ${style.cell} ${style.absent}`}>
          not on {who}
        </span>
      );
    }
    const words = !context && r.baseline !== null ? wordDiff(value, r.baseline).a : [{ text: value, changed: false }];
    return (
      <span
        key={i}
        className={`px-3 py-1.5 whitespace-pre-wrap break-words ${style.cell} ${context ? 'text-ink-muted' : 'text-ink'}`}
      >
        {words.map((w, k) =>
          w.changed ? (
            <span key={k} className={`${style.mark} px-0.5`}>
              {w.text}
            </span>
          ) : (
            <span key={k}>{w.text}</span>
          ),
        )}
      </span>
    );
  };
  const baseCell = (r: GridRow, context: boolean) => {
    if (r.baseline === null) {
      return (
        <span key="b" className={`px-3 py-1.5 italic font-sans text-[11px] ${SIDE.baseline.cell} ${SIDE.baseline.absent}`}>
          not on {baselineName}
        </span>
      );
    }
    // Lit against the first member that differs.
    const against = r.cells.find((c) => !c.same && c.value !== null)?.value ?? null;
    const words =
      !context && against !== null ? wordDiff(r.baseline, against).a : [{ text: r.baseline, changed: false }];
    return (
      <span
        key="b"
        className={`px-3 py-1.5 whitespace-pre-wrap break-words ${SIDE.baseline.cell} ${
          context ? 'text-ink-muted' : 'text-ink'
        }`}
      >
        {words.map((w, k) =>
          w.changed ? (
            <span key={k} className={`${SIDE.baseline.mark} px-0.5`}>
              {w.text}
            </span>
          ) : (
            <span key={k}>{w.text}</span>
          ),
        )}
      </span>
    );
  };

  return (
    <section id={`drift-section-${entry.table}`} data-key={entry.table} className="pt-4 pb-2 scroll-mt-9">
      <div className="px-3 pb-1.5 flex items-baseline gap-3 flex-wrap">
        <h3 className="font-mono text-[13px] text-ink">{entry.table}</h3>
        <span className="text-[11px] text-ink-faint">{summary}</span>
        <div className="flex-1" />
        {entry.pending && (
          <>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={allTicked}
                onChange={(e) => {
                  for (const { c, f } of lacking) onInclude(c.connection.id, tableKey(f), e.target.checked);
                }}
              />
              include in the proposed SQL{cols.length > 1 ? ` for ${nameList(lacking.map(({ c }) => c.connection.name))}` : ''}
            </label>
            <button
              onClick={onIgnore}
              className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink"
            >
              Ignore table
            </button>
          </>
        )}
        {canExpand && (
          <button
            onClick={() => setExpand(!expand)}
            aria-pressed={expand}
            className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink"
          >
            {expand ? 'Fold matching rows' : 'Whole table'}
          </button>
        )}
      </div>

      <div className="border-y border-card">
        {rows.map((r, i) => {
          if (r.fold) {
            return (
              <button
                key={r.key}
                onClick={() => setExpand(true)}
                className="w-full text-left px-3 py-1 bg-card border-t border-card first:border-t-0 font-mono text-[11px] italic text-ink-faint hover:text-ink-muted"
              >
                {r.fold}
              </button>
            );
          }
          const context = !r.note && r.cells.every((c) => c.same);
          const members = r.cells.map((_, k) => cellFor(r, k, context));
          return (
            <div
              key={`${r.key}:${i}`}
              className="grid items-stretch border-t border-card first:border-t-0 font-mono text-[11.5px]"
              style={{ gridTemplateColumns: gridColumns(cols.length) }}
            >
              <span className={`px-3 py-1.5 truncate ${context ? 'text-ink-muted' : 'text-ink'}`} title={r.name ?? ''}>
                {r.name ?? '(table)'}
              </span>
              {swapped ? [...members, baseCell(r, context)] : [baseCell(r, context), ...members]}
              <span className="px-3 py-1.5 font-sans text-[10px] text-ink-faint flex items-center gap-1.5">
                {r.consequence && (
                  <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${CONSEQUENCE[r.consequence].swatch}`} />
                )}
                {r.note}
              </span>
            </div>
          );
        })}
      </div>

      {migrations.some(Boolean) && (
        <div className="px-3 pt-2 flex flex-col gap-1">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {cols.map((c, i) => {
              const m = migrations[i];
              if (!m) return null;
              const n = m.statementCount;
              const id = c.connection.id;
              return (
                <button
                  key={id}
                  onClick={() => setOpenSql(openSql === id ? null : id)}
                  aria-expanded={openSql === id}
                  className="text-[11px] text-ink-muted hover:text-ink"
                >
                  {openSql === id ? '▾' : '▸'}{' '}
                  {n > 0
                    ? `SQL that brings ${c.connection.name} in line — ${n} statement${n === 1 ? '' : 's'}, text only`
                    : `Notes for ${c.connection.name} — nothing here can be written as SQL`}
                </button>
              );
            })}
          </div>
          {openSql &&
            (() => {
              const i = cols.findIndex((c) => c.connection.id === openSql);
              const sql = migrations[i]?.sql.trim();
              if (!sql) return null;
              return (
                <div className="mt-1 flex items-start gap-2 rounded-md bg-card px-3 py-2">
                  <pre className="flex-1 min-w-0 font-mono text-[11px] text-ink-muted whitespace-pre-wrap">{sql}</pre>
                  <button
                    onClick={() => {
                      void window.overdb.invoke('app:copyText', sql);
                      onCopied();
                    }}
                    className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-card-border text-ink-muted hover:text-ink"
                  >
                    Copy
                  </button>
                </div>
              );
            })()}
        </div>
      )}
    </section>
  );
}

/// The set's ignore patterns, and what a baseline-only table means. Saved
/// with the set as they change: they describe the environments, not this
/// look at them.
function IgnoreRail({
  patterns,
  oneSided,
  baselineName,
  baselineOnly,
  onAdd,
  onRemove,
  onBaselineOnly,
  onClose,
}: {
  patterns: string[];
  oneSided: Array<{ schema: string; table: string }>;
  baselineName: string;
  baselineOnly: BaselineOnly;
  onAdd(pattern: string): void;
  onRemove(pattern: string): void;
  onBaselineOnly(mode: BaselineOnly): void;
  onClose(): void;
}): JSX.Element {
  const [draft, setDraft] = useState('');

  const count = (pattern: string) => {
    const re = globToRegExp(pattern);
    return oneSided.filter((t) => re.test(pattern.includes('.') ? tableKey(t) : t.table)).length;
  };
  const suggested = suggestIgnores(
    oneSided.map((t) => t.table),
    patterns,
  );

  const add = () => {
    onAdd(draft);
    setDraft('');
  };

  const modes: Array<{ key: BaselineOnly; label: string; sub: string }> = [
    { key: 'pending', label: 'Not deployed yet', sub: 'Listed apart, not counted as drift.' },
    { key: 'drift', label: 'Breaking drift', sub: 'For when this member should already have everything.' },
    { key: 'hide', label: 'Hidden', sub: 'Compare only tables both sides have.' },
  ];

  return (
    <aside className="w-72 shrink-0 border-l border-card overflow-y-auto px-3.5 py-3 flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div>
          <div className="flex items-center">
            <h2 className="flex-1 text-[11px] font-semibold text-ink">Ignore tables</h2>
            <button
              onClick={onClose}
              aria-label="Close ignore rules"
              className="text-[11px] px-1.5 text-ink-faint hover:text-ink"
            >
              ✕
            </button>
          </div>
          <p className="mt-0.5 text-[10px] text-ink-faint leading-relaxed">
            Saved with this set. <span className="font-mono">*</span> and{' '}
            <span className="font-mono">?</span>, any case. Only hides tables one side is missing —
            a table both sides have is always compared.
          </p>
        </div>

        {(patterns.length > 0 || suggested.length > 0) && (
          <div className="flex flex-col gap-0.5">
            {patterns.map((p) => (
              <label key={p} className="flex items-center gap-2 px-2 py-1 rounded bg-card">
                <input type="checkbox" checked onChange={() => onRemove(p)} />
                <span className="flex-1 min-w-0 font-mono text-[11px] text-ink truncate">{p}</span>
                <span className="text-[10px] text-ink-faint tabular-nums">{count(p)}</span>
              </label>
            ))}
            {suggested.map((s) => (
              <label key={s.pattern} className="flex items-center gap-2 px-2 py-1 rounded">
                <input type="checkbox" checked={false} onChange={() => onAdd(s.pattern)} />
                <span className="flex-1 min-w-0 font-mono text-[11px] text-ink-muted truncate">
                  {s.pattern}
                </span>
                <span className="text-[9px] uppercase tracking-wide text-accent">suggested</span>
                <span className="text-[10px] text-ink-faint tabular-nums">{s.count}</span>
              </label>
            ))}
          </div>
        )}

        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            aria-label="New ignore pattern"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. *_old"
            spellCheck={false}
            className="flex-1 min-w-0 px-2 py-1 rounded border border-card bg-transparent font-mono text-[11px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent/60"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="text-[11px] px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[11px] font-semibold text-ink">Tables only {baselineName} has</h2>
        <div role="radiogroup" className="flex flex-col gap-0.5">
          {modes.map((m) => (
            <label key={m.key} className="flex items-start gap-2 px-1 py-1 cursor-pointer">
              <input
                type="radio"
                name="baseline-only"
                className="mt-0.5"
                checked={baselineOnly === m.key}
                onChange={() => onBaselineOnly(m.key)}
              />
              <span>
                <span className="block text-[11px] text-ink">{m.label}</span>
                <span className="block text-[10px] text-ink-faint">{m.sub}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
    </aside>
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
  baselineName,
  onClose,
  onCopied,
}: {
  row: MemberDrift;
  baseline: SchemaSnapshot;
  baselineName: string;
  onClose(): void;
  onCopied(): void;
}): JSX.Element {
  const [includeQuiet, setIncludeQuiet] = useState(false);
  const migration = useMemo(
    () =>
      row.drift && row.here
        ? buildMigration(row.drift, baseline, row.here.engine, {
            includeQuiet,
            names: { here: row.connection.name, baseline: baselineName },
          })
        : null,
    [row.drift, row.here, baseline, includeQuiet, row.connection.name, baselineName],
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
