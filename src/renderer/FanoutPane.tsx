import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ColumnMeta, Connection, EnvSet } from '@shared/types';
import type { MatrixCell } from '@shared/fanout';
import {
  columnMatrix,
  compare,
  fanoutSummary,
  rowsVerdict,
  slowdown,
  touchedTables,
  type CellTone,
  type MemberRun,
} from '@shared/fanout';
import { variantLabel } from '@shared/engines';
import { cellLabel, planDiff, type MemberPlan, type PlanCell, type PlanTone } from '@shared/planDiff';
import { useFanout } from './fanoutStore';
import { useStore } from './store';
import { SqlEditor } from './SqlEditor';
import { ParamPopover } from './ParamPopover';
import { paramSlots, type ParamSlot } from '@shared/params';
import { splitStatements } from '@shared/sqlGuard';
import { ResultGrid } from './ResultGrid';
import { Resizer } from './Resizer';
import { MemberHealth } from './EnvSetPane';
import { SchemaDriftView } from './SchemaDriftView';
import { sampleEnvOf } from '@shared/sample';
import { indexConsequence, indexMatrix } from '@shared/indexMatrix';

/// Querying a whole environment set.
///
/// The editor is the same one a connection gets, because the statement is
/// the same statement — what differs is that pressing Run sends it to five
/// servers instead of one, and the answer is a comparison rather than a
/// grid. So the comparison is what the pane opens on: five grids stacked in
/// tabs is five grids, and the question that made you group these
/// connections in the first place was never "what does prod say", it was
/// "do these still agree".

/// The plans view, in the same slot a member id occupies.
///
/// A sentinel rather than a second piece of state: "which tab is open" is
/// one question, and two booleans answering it can disagree.
const PLANS = '\u0000plans';

export function FanoutPane({ envSet }: { envSet: EnvSet }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const paramBindings = useStore((s) => s.params);
  const setSheet = useStore((s) => s.setSheet);
  const runs = useFanout((s) => s.runs);
  const running = useFanout((s) => s.running);
  const refusal = useFanout((s) => s.refusal);
  const focused = useFanout((s) => s.focused);
  const envSetId = useFanout((s) => s.envSetId);
  const fanRun = useFanout((s) => s.run);
  const cancel = useFanout((s) => s.cancel);
  const focus = useFanout((s) => s.focus);
  const reset = useFanout((s) => s.reset);

  const schemas = useStore((s) => s.activeSchema);
  const loadSchema = useStore((s) => s.loadSchema);
  const ranSql = useFanout((s) => s.sql);

  // Completion comes from the BASELINE's catalog. A set has no single
  // schema to complete against, and the baseline is the one member the
  // whole pane is already defined in terms of — completing against it is
  // the same claim the comparison makes, that this is the shape the others
  // are supposed to have. A table only some members carry still completes;
  // the comparison is what tells you which of them actually has it.
  const catalog = useStore((s) =>
    envSet.baselineId ? s.schemas[envSet.baselineId] : undefined,
  );
  useEffect(() => {
    if (envSet.baselineId) void loadSchema(envSet.baselineId);
  }, [envSet.baselineId, loadSchema]);
  // Held in the store, not here — see `editorSql` in fanoutStore.ts. A
  // remount (StrictMode does one on every mount in development) would
  // otherwise discard a statement handed over from a connection's editor
  // and leave the fan-out running with an empty editor above it.
  const sql = useFanout((s) => s.editorSql);
  const setSql = useFanout((s) => s.setEditorSql);
  const [split, setSplit] = useState(280);

  // Results belong to the set they were run against. Switching sets and
  // finding the previous one's answers still on screen, under the new set's
  // name, is the kind of wrong that gets acted on.
  useEffect(() => {
    if (envSetId && envSetId !== envSet.id) reset();
  }, [envSet.id, envSetId, reset]);

  const members = useMemo(
    () =>
      envSet.memberIds
        .map((id) => connections.find((c) => c.id === id))
        .filter((c): c is Connection => Boolean(c)),
    [envSet.memberIds, connections],
  );
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const baseline = runs.find((r) => r.connectionId === envSet.baselineId) ?? null;
  const plans = useFanout((s) => s.plans);
  const explaining = useFanout((s) => s.explaining);
  const explain = useFanout((s) => s.explain);
  const shown = focused && focused !== PLANS ? runs.find((r) => r.connectionId === focused) : null;

  // Asking for the plans IS clicking the tab: an EXPLAIN runs nothing, and
  // making you click the tab and then a button to see what the tab is named
  // after would be ceremony.
  useEffect(() => {
    if (focused === PLANS && !plans.length && !explaining && sql.trim()) {
      void explain(envSet, sql);
    }
  }, [focused, plans.length, explaining, sql, envSet, explain]);

  /// Which question the pane is answering. Local rather than persisted:
  /// it is a mode you are in for a minute, not a preference.
  const [mode, setMode] = useState<'query' | 'drift'>('query');

  /// The member every value is shown against.
  ///
  /// A fan-out binds per member, so no single value is THE value — but the
  /// baseline is what every answer here is compared to, so it is the honest
  /// one to draw in the holes. The panel behind a chip shows every
  /// environment's value at once, which is where the spread belongs.
  const baselineMember = members.find((m) => m.id === envSet.baselineId) ?? members[0];

  const [starter, setStarter] = useState<{ text: string; nonce: number; mode: 'replace' }>({
    text: '',
    nonce: 0,
    mode: 'replace',
  });

  const [openParam, setOpenParam] = useState<{ slot: ParamSlot; at: DOMRect } | null>(null);

  const go = () => {
    if (running) void cancel();
    else void fanRun(envSet, sql);
  };

  // A statement handed over from a connection's editor by "Run on <set>".
  //
  // It runs on arrival rather than waiting to be pressed: the button that
  // sent it here said Run, and landing on a pane with the statement typed
  // in and nothing happening would read as a failure. Guarded on the set's
  // own id, so a handoff aimed at a different set is left alone for that
  // pane to pick up.
  const handoff = useFanout((s) => s.handoff);
  const clearHandoff = useFanout((s) => s.clearHandoff);
  useEffect(() => {
    if (!handoff || handoff.envSetId !== envSet.id) return;
    // Cleared FIRST so a remount cannot run it twice, which is safe only
    // because the statement lands in the store rather than in local state.
    clearHandoff();
    setMode('query');
    setSql(handoff.sql);
    void fanRun(envSet, handoff.sql);
  }, [handoff, envSet, clearHandoff, fanRun, setSql]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2.5 px-3.5 h-10 border-b border-card shrink-0">
        <span className="text-xs font-medium text-ink">{envSet.name}</span>
        <span className="text-[10px] text-ink-faint">
          {members.length} member{members.length === 1 ? '' : 's'}
        </span>
        {envSet.baselineId && byId.get(envSet.baselineId) && (
          <span className="text-[10px] text-ink-faint">
            against <span className="text-ink-muted">{byId.get(envSet.baselineId)?.name}</span>
          </span>
        )}
        <div className="flex-1" />
        {/* Two different questions about the same set: what do these
            servers ANSWER, and do they still have the same shape. They
            share a header and nothing else — a drift comparison runs no
            statement, so putting it behind the editor as a result tab
            would imply it was something you ran. */}
        <div className="flex items-center gap-px mr-1">
          {(['query', 'drift'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={
                m === 'query'
                  ? 'Run one statement against every member and compare the answers'
                  : "Compare the members' catalogs — tables, columns, indexes and keys. Nothing runs."
              }
              className={`px-2 py-0.5 text-[11px] rounded ${
                mode === m ? 'bg-accent/20 text-ink' : 'text-ink-faint hover:text-ink-muted hover:bg-card'
              }`}
            >
              {m === 'query' ? 'Query' : 'Schema drift'}
            </button>
          ))}
        </div>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-card text-ink-faint">
          read-only
        </span>
        <button
          onClick={() => setSheet({ kind: 'editEnvSet', id: envSet.id })}
          className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          Edit set
        </button>
        {mode === 'query' && (
          <button
            onClick={go}
            disabled={!sql.trim() && !running}
            className={`text-[11px] px-2.5 py-1 rounded disabled:opacity-40 ${
              running
                ? 'border border-card text-ink-muted hover:text-ink hover:bg-card'
                : 'bg-accent text-white hover:bg-accent-strong'
            }`}
          >
            {running ? 'Cancel' : `Run on ${members.length}`}
          </button>
        )}
      </div>

      {mode === 'drift' ? (
        <div className="flex-1 min-h-0">
          <SchemaDriftView envSet={envSet} />
        </div>
      ) : (
        <>
        <SchemaBar envSet={envSet} members={members} />

        <div style={{ height: split }} className="shrink-0 min-h-0 border-b border-card">
          <SqlEditor
            value={sql}
            inject={starter.nonce ? starter : undefined}
            schema={catalog}
            activeSchema={
              envSet.baselineId
                ? (envSet.memberSchemas?.[envSet.baselineId] ?? schemas[envSet.baselineId])
                : undefined
            }
            onChange={setSql}
            onRun={go}
            params={
              baselineMember && {
                engine: baselineMember.engine,
                bindings: paramBindings,
                target: { connectionId: baselineMember.id, env: baselineMember.env },
              }
            }
            onParamOpen={(hole, at) => {
              if (!baselineMember) return;
              const statement = splitStatements(sql, baselineMember.engine)[0];
              const inStatement = statement
                ? paramSlots(statement.sql, baselineMember.engine).find((s) => s.key === hole.key)
                : undefined;
              setOpenParam({
                slot: inStatement ?? {
                  key: hole.key, label: hole.label, style: hole.style, count: 1, inList: false,
                },
                at,
              });
            }}
          />
        </div>

        {openParam && baselineMember && (
          <ParamPopover
            slot={openParam.slot}
            at={openParam.at}
            target={{ connectionId: baselineMember.id, env: baselineMember.env }}
            onClose={() => setOpenParam(null)}
          />
        )}
        <Resizer
          axis="y"
          value={split}
          min={120}
          max={() => window.innerHeight - 260}
          fallback={280}
          onChange={setSplit}
          label="Editor height"
        />

        <div className="flex-1 min-h-0 flex flex-col">
          {refusal ? (
            <div className="p-4">
              <p className="text-xs text-warn/90 leading-relaxed max-w-[70ch]">{refusal}</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col items-start gap-3">
              <p className="text-xs text-ink-muted leading-relaxed max-w-[62ch]">
                Write a statement and run it. It goes to every member at once, and what comes back is
                lined up against{' '}
                <span className="text-ink">
                  {byId.get(envSet.baselineId ?? '')?.name ?? 'the baseline'}
                </span>
                .
              </p>
              {members.length > 0 && members.every((m) => sampleEnvOf(m.file)) && (
                <SampleStarters
                  onPick={(text) => {
                    // Into the editor as well as onto the members, so what
                    // ran is on screen to read and change.
                    setStarter((p) => ({ text, nonce: p.nonce + 1, mode: 'replace' }));
                    setSql(text);
                    void fanRun(envSet, text);
                  }}
                  onDrift={() => setMode('drift')}
                />
              )}
              <MemberHealth envSet={envSet} />
            </div>
          ) : (
            <>
              <MemberTabs
                runs={runs}
                byId={byId}
                baseline={baseline}
                baselineId={envSet.baselineId ?? null}
                focused={focused}
                onFocus={focus}
              />
              <div className="flex-1 min-h-0 overflow-auto bg-surface">
                {focused === PLANS ? (
                  <PlanTable
                    plans={plans}
                    byId={byId}
                    baselineId={envSet.baselineId ?? null}
                    explaining={explaining}
                  />
                ) : shown ? (
                  <MemberResult run={shown} name={byId.get(shown.connectionId)?.name ?? 'member'} />
                ) : (
                  <DriftTable
                    runs={runs}
                    byId={byId}
                    baseline={baseline}
                    sql={ranSql}
                    schemaOf={(id) => envSet.memberSchemas?.[id] ?? schemas[id] ?? null}
                    onOpen={focus}
                  />
                )}
              </div>
            </>
          )}
        </div>
        </>
      )}
    </div>
  );
}

/// Which schema each member's statement runs against.
///
/// This is the part of a set that is easy to get silently wrong. "The same
/// logical database in several places" almost never means the same NAME in
/// several places — `acme` locally, `acmedmsandbox` in sandbox — so an
/// unqualified statement resolves against whatever each session happens to
/// be pointed at, and the fan-out cheerfully compares an answer from the
/// wrong database against one from the right one. Stating it per member,
/// where you can see all of them at once, is the only way that mismatch is
/// visible before it is a result.
function SchemaBar({ envSet, members }: { envSet: EnvSet; members: Connection[] }): JSX.Element | null {
  const schemaList = useStore((s) => s.schemaList);
  const activeSchema = useStore((s) => s.activeSchema);
  const loadSchemaList = useStore((s) => s.loadSchemaList);
  const saveEnvSet = useStore((s) => s.saveEnvSet);

  useEffect(() => {
    for (const m of members) void loadSchemaList(m.id);
  }, [members, loadSchemaList]);

  if (!members.length) return null;

  const chosen = (id: string) => envSet.memberSchemas?.[id] ?? activeSchema[id] ?? '';
  const pick = (id: string, name: string) =>
    void saveEnvSet({
      id: envSet.id,
      name: envSet.name,
      memberIds: envSet.memberIds,
      baselineId: envSet.baselineId,
      memberSchemas: { ...envSet.memberSchemas, [id]: name },
    });

  // Worth pointing at only when they actually disagree. On a set where every
  // member is on the same name this is a row of identical dropdowns saying
  // nothing.
  const distinct = new Set(members.map((m) => chosen(m.id)).filter(Boolean));

  return (
    <div className="shrink-0 border-b border-card px-3.5 py-2 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">Schema</span>
      {members.map((m) => {
        const names = schemaList[m.id] ?? [];
        const value = chosen(m.id);
        return (
          <label
            key={m.id}
            className="flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded border border-card bg-wash"
            title={`${m.name} — which schema its statement runs against`}
          >
            <span className="text-[10px] text-ink-faint max-w-[130px] truncate">{m.name}</span>
            <select
              value={value}
              onChange={(e) => pick(m.id, e.target.value)}
              className="bg-transparent text-[11px] text-ink outline-none max-w-[150px]"
            >
              {value === '' && <option value="">whatever it is on</option>}
              {!names.includes(value) && value !== '' && <option value={value}>{value}</option>}
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {distinct.size > 1 && (
        <span className="text-[10px] text-ink-faint">
          {distinct.size} different names — the statement is run against each member's own.
        </span>
      )}
    </div>
  );
}

/// The results, tabbed — the same bar a connection's results get.
///
/// Deliberately the app's existing tab chrome rather than a strip of its
/// own: without a framed bar, the lower half of the pane is an unframed
/// expanse with a table floating in it and nothing saying which of several
/// answers you are looking at. That is the same reason the connection pane
/// has one.
///
/// Comparison sits first and is where the pane opens. It is not one answer
/// among N — it is the reason the set exists, and the per-member grids are
/// what you open when it has told you where to look.
function MemberTabs({
  runs,
  byId,
  baseline,
  baselineId,
  focused,
  onFocus,
}: {
  runs: MemberRun[];
  byId: Map<string, Connection>;
  baseline: MemberRun | null;
  baselineId: string | null;
  focused: string | null;
  onFocus(id: string | null): void;
}): JSX.Element {
  const verdicts = runs.map((r) => compare(r, baseline));
  const differing = verdicts.filter((v) => v.kind === 'differs').length;
  const failed = runs.filter((r) => r.status === 'error').length;

  return (
    <div className="flex items-stretch gap-px shrink-0 border-y border-card bg-surface-muted overflow-x-auto">
      <button
        onClick={() => onFocus(null)}
        title="Every member against the baseline"
        className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 flex items-center gap-1.5 ${
          focused === null
            ? 'border-accent text-ink'
            : 'border-transparent text-ink-faint hover:text-ink-muted'
        }`}
      >
        <Scales />
        Comparison
        {differing > 0 && <span className="text-warn/90 tabular-nums">{differing}</span>}
        {failed > 0 && <span className="text-bad/90 tabular-nums">{failed}</span>}
      </button>

      <button
        onClick={() => onFocus(PLANS)}
        title="How each member would run this statement"
        className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 flex items-center gap-1.5 ${
          focused === PLANS
            ? 'border-accent text-ink'
            : 'border-transparent text-ink-faint hover:text-ink-muted'
        }`}
      >
        <Route />
        Plans
      </button>

      {/* A rule, not a gap: the member tabs are a different KIND of thing
          from the two above — those are about the set, these are one
          member's own answer — and a gap alone reads as spacing. */}
      <span aria-hidden="true" className="self-center w-px h-4 bg-card-border mx-1" />

      {runs.map((run, i) => {
        const conn = byId.get(run.connectionId);
        const on = focused === run.connectionId;
        return (
          <button
            key={run.connectionId}
            onClick={() => onFocus(run.connectionId)}
            title={verdicts[i].summary}
            className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 flex items-center gap-1.5 ${
              on ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-muted'
            }`}
          >
            <StatusDot run={run} verdict={verdicts[i].kind} />
            <span className="max-w-[180px] truncate">{conn?.name ?? run.connectionId}</span>
            {run.connectionId === baselineId && (
              <span className="text-[9px] uppercase tracking-wider text-accent">base</span>
            )}
            {run.status === 'done' ? (
              <span className="tabular-nums opacity-60">{run.rowCount.toLocaleString()}</span>
            ) : run.rows.length > 0 ? (
              <span className="tabular-nums opacity-40">{run.rows.length.toLocaleString()}…</span>
            ) : null}
          </button>
        );
      })}

      <div className="flex-1 min-w-4" />
      {/* Right-hand side, out of the way of the tabs: the overall verdict in
          a few words, for when you are not going to read the table. */}
      <span className="self-center pr-3 pl-2 text-[10px] text-ink-faint whitespace-nowrap">
        {fanoutSummary(runs, baselineId)}
      </span>
    </div>
  );
}

/// Where the rows come from — the plan, in one glyph.
function Route(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="3.4" cy="3.4" r="1.8" />
      <circle cx="12.6" cy="12.6" r="1.8" />
      <path d="M3.4 5.2v3.4a2 2 0 002 2h5.2" />
    </svg>
  );
}

/// Weighing one thing against another — the pane in one glyph, and the only
/// tab here that is not a place a query ran.
function Scales(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.4v11.2M4.2 13.6h7.6M2 5.4h12M2 5.4 4 9.6h-4zM14 5.4l2 4.2h-4z" />
    </svg>
  );
}

/// A member's state, as one mark.
///
/// FILLED means there is an answer; HOLLOW means there is not yet. That
/// distinction carries the weight, and it is why a running member is not
/// amber: amber previously meant both "still running" and "its answer
/// differs", separated only by a pulse — and on a set that finishes
/// quickly you never see the pulse, so they were the same dot.
///
/// Shape doing the work also means the state survives being read by
/// someone who cannot tell amber from green, which colour alone never
/// would.
function StatusDot({ run, verdict }: { run: MemberRun; verdict: string }): JSX.Element {
  const label =
    run.status === 'error' ? 'failed'
    : run.status === 'cancelled' || run.status === 'blocked' ? 'did not run'
    : run.status !== 'done' ? 'still running'
    : verdict === 'differs' ? 'differs from the baseline'
    : 'matches the baseline';

  // No answer yet, or never coming: a ring. Pulsing only while it is still
  // working, so the animation says "in flight" and nothing else.
  if (run.status !== 'done' && run.status !== 'error') {
    const working = run.status !== 'cancelled' && run.status !== 'blocked';
    return (
      <span
        title={label}
        className={`shrink-0 w-1.5 h-1.5 rounded-full border ${
          working ? 'border-ink-muted animate-pulse' : 'border-ink-faint'
        }`}
      />
    );
  }

  const colour =
    run.status === 'error' ? 'bg-bad' : verdict === 'differs' ? 'bg-warn' : 'bg-good';
  return <span title={label} className={`shrink-0 w-1.5 h-1.5 rounded-full ${colour}`} />;
}

/// The comparison, as a table.
///
/// One row per column of the result, one column per member, the type in the
/// cell. This shape rather than a sentence each because the question is
/// "where do these stop agreeing", and that is a two-dimensional question:
/// a list of per-member summaries makes you hold four sentences in your head
/// and diff them yourself, which is the work the tool was supposed to do.
///
/// Above it, what the comparison could NOT establish. That goes first and
/// unconditionally — a schema finding is not a reason to stop saying that
/// 10,000 rows went unchecked.
function DriftTable({
  runs,
  byId,
  baseline,
  sql,
  schemaOf,
  onOpen,
}: {
  runs: MemberRun[];
  byId: Map<string, Connection>;
  baseline: MemberRun | null;
  /// The statement that ran, so a verdict can suggest one that would
  /// compare where this one could not.
  sql: string;
  /// Which schema this member answered from. Shown in the header because a
  /// diff between two environments is only meaningful once you can see it
  /// was the right database on both sides.
  schemaOf(connectionId: string): string | null;
  onOpen(id: string): void;
}): JSX.Element {
  const verdict = rowsVerdict(runs, sql);
  const matrix = columnMatrix(runs, baseline?.connectionId ?? null);
  const failed = runs.filter((r) => r.status === 'error');
  const grid = {
    gridTemplateColumns: `minmax(150px, 190px) repeat(${matrix.members.length}, minmax(120px, 1fr))`,
  };

  return (
    <div className="p-3.5 flex flex-col gap-3.5 min-w-fit">
      <Verdict verdict={verdict} />

      {!baseline && (
        <p className="text-[11px] text-ink-faint leading-snug">
          This set has no baseline, so there is nothing to compare against. Edit the set to pick
          one.
        </p>
      )}

      <div className="rounded border border-card-border overflow-hidden w-fit">
        <div className="grid" style={grid}>
          <Head sticky>Column</Head>
          {matrix.members.map((m) => {
            const conn = byId.get(m.connectionId);
            const fast = slowdown(m, baseline);
            return (
              <Head key={m.connectionId}>
                <button
                  onClick={() => onOpen(m.connectionId)}
                  className="text-left block w-full min-w-0 hover:text-ink"
                >
                  <span className="block text-[11px] text-ink truncate">
                    {conn?.name ?? m.connectionId}
                    {m.connectionId === baseline?.connectionId && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent">
                        base
                      </span>
                    )}
                  </span>
                  <span className="block text-[9px] text-ink-faint truncate">
                    {conn ? variantLabel(conn.variant, conn.engine) : ''}
                    {schemaOf(m.connectionId) ? ` · ${schemaOf(m.connectionId)}` : ''}
                  </span>
                  {m.status === 'error' ? (
                    <span className="block text-[9px] text-bad/90 truncate">did not run</span>
                  ) : fast !== null ? (
                    <span className="block text-[9px] text-warn/90 tabular-nums">
                      {fast >= 1 ? `${fast.toFixed(1)}× slower` : `${(1 / fast).toFixed(1)}× faster`}
                    </span>
                  ) : null}
                </button>
              </Head>
            );
          })}

          {matrix.rows.map((row) => (
            <ColumnRow key={row.column} column={row.column} cells={row.cells} />
          ))}

          {matrix.matching > 0 && (
            <>
              <RowHead muted>
                {matrix.matching} column{matrix.matching === 1 ? '' : 's'} match
              </RowHead>
              {matrix.members.map((m) => (
                <Cell key={m.connectionId} tone="same" text="·" />
              ))}
            </>
          )}

          <RowHead label>Rows</RowHead>
          {matrix.members.map((m) => (
            <div
              key={m.connectionId}
              className={`px-2.5 py-1.5 border-t border-card-border font-mono text-[11px] tabular-nums truncate ${
                m.truncated ? 'text-warn/90' : 'text-ink-muted'
              }`}
            >
              {m.status === 'done'
                ? `${m.rowCount.toLocaleString()}${m.truncated ? ' capped' : ''}`
                : m.status === 'running' || m.status === 'connecting' || m.status === 'pending'
                  ? // What has arrived, so a stalled stream is visible as a
                    // number that stops climbing rather than as an em dash
                    // that looked the same the whole way through.
                    `${m.rows.length.toLocaleString()} so far`
                  : '—'}
            </div>
          ))}

          <IndexRows
            members={matrix.members}
            baselineId={baseline?.connectionId ?? null}
            columns={baseline?.columns ?? []}
            byId={byId}
          />

          <RowHead label>Time</RowHead>
          {matrix.members.map((m) => (
            <div
              key={m.connectionId}
              className="px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-ink-muted truncate"
            >
              {m.durationMs !== null
                ? `${m.durationMs.toLocaleString()} ms`
                : m.status === 'running'
                  ? 'running…'
                  : m.status === 'connecting'
                    ? 'connecting…'
                    : m.status === 'pending'
                      ? 'queued'
                      : '—'}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3.5 text-[10px] text-ink-faint">
        <Swatch className="bg-warn/35" label="differs" />
        <Swatch className="bg-bad/35" label="absent" />
        <Swatch className="bg-wash-strong" label="same type, different engines" />
      </div>

      {failed.map((run) => (
        <div key={run.connectionId} className="flex items-baseline gap-2.5">
          <span className="shrink-0 text-[11px] text-bad/90">
            {byId.get(run.connectionId)?.name ?? run.connectionId}
          </span>
          <span className="font-mono text-[10px] text-ink-muted leading-snug">{run.error}</span>
        </div>
      ))}
    </div>
  );
}

/// What the comparison established about the rows, said before anything
/// else and regardless of what else it found.
function Verdict({ verdict }: { verdict: ReturnType<typeof rowsVerdict> }): JSX.Element | null {
  // Still working is not a finding. An amber warning card saying "the rows
  // were not compared" while a member is mid-flight reads as a verdict, and
  // the verdict it reads as is wrong.
  if (verdict.pending) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-ink-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-good animate-pulse shrink-0" />
        {verdict.headline}
        {verdict.detail && <span className="text-ink-faint">{verdict.detail}</span>}
      </p>
    );
  }
  if (verdict.compared) {
    return (
      <p className="text-[11px] text-good/90">
        {verdict.headline} Every column and every row was checked against the baseline.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-warn/30 bg-warn/[0.06] px-3.5 py-3 flex gap-2.5 max-w-[860px]">
      <svg
        width="15"
        height="15"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
        className="shrink-0 mt-px"
      >
        <circle cx="10" cy="10" r="7.5" stroke="rgb(251 191 36)" strokeWidth="1.4" />
        <path d="M10 6.2v4.4" stroke="rgb(251 191 36)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="10" cy="13.6" r="0.9" fill="rgb(251 191 36)" />
      </svg>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="text-xs text-warn/90">{verdict.headline}</span>
        {verdict.detail && (
          <span className="text-[11px] leading-relaxed text-ink-muted">{verdict.detail}</span>
        )}
        {verdict.suggestion && (
          <span className="flex items-baseline gap-2 flex-wrap pt-0.5">
            <code className="font-mono text-[10px] text-ink px-2 py-1 rounded border border-card-border bg-wash">
              {verdict.suggestion}
            </code>
            <span className="text-[10px] text-ink-faint">compares cleanly</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ColumnRow({ column, cells }: { column: string; cells: MatrixCell[] }): JSX.Element {
  return (
    <>
      <RowHead>{column}</RowHead>
      {cells.map((cell) => (
        <Cell key={cell.memberId} tone={cell.tone} text={cell.text} />
      ))}
    </>
  );
}

const TONES: Record<CellTone, string> = {
  baseline: 'text-ink',
  same: 'text-ink-muted',
  // Quiet on purpose. Two engines spelling one type two ways is not a
  // finding, and shown as one it is what teaches you to stop reading them.
  equivalent: 'text-ink-faint bg-wash',
  drift: 'text-warn/90 bg-warn/[0.08]',
  absent: 'text-bad/90 bg-bad/[0.08]',
  unknown: 'text-ink-faint',
};

function Cell({ tone, text }: { tone: CellTone; text: string }): JSX.Element {
  return (
    <div
      title={tone === 'equivalent' ? 'The same type, spelled differently by these engines' : text}
      className={`px-2.5 py-1.5 border-b border-card font-mono text-[11px] truncate ${TONES[tone]}`}
    >
      {text}
    </div>
  );
}

function Head({ children, sticky }: { children: React.ReactNode; sticky?: boolean }): JSX.Element {
  return (
    <div
      className={`px-2.5 py-1.5 bg-surface-muted border-b border-card-border min-w-0 ${
        sticky ? 'sticky left-0 z-10 text-[10px] uppercase tracking-wider text-ink-faint' : ''
      }`}
    >
      {children}
    </div>
  );
}

function RowHead({
  children,
  muted,
  label,
}: {
  children: React.ReactNode;
  muted?: boolean;
  label?: boolean;
}): JSX.Element {
  return (
    <div
      className={`px-2.5 py-1.5 sticky left-0 bg-surface truncate ${
        label
          ? 'border-t border-card-border text-[10px] text-ink-muted'
          : `border-b border-card font-mono text-[11px] ${muted ? 'text-ink-faint' : 'text-ink'}`
      }`}
    >
      {children}
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`w-2 h-2 rounded-[2px] ${className}`} />
      {label}
    </span>
  );
}

/// How each member would run the statement, drawn.
///
/// The table said which access path each server chose, which is the fact —
/// but `ALL` beside `ref` is two words, and the difference they stand for is
/// four orders of magnitude. So every cell carries a bar, all on ONE scale,
/// and the answer to "why is aurora seventeen times slower" is a shape
/// rather than a sentence you have to already understand.
///
/// The bars are the plan views' own idiom (src/renderer/PlanLedger.tsx):
/// square-root scale, a 2px floor, one scale across everything drawn. A
/// third visual language for the same quantity would make two pictures of
/// the same plan disagree.
function PlanTable({
  plans,
  byId,
  baselineId,
  explaining,
}: {
  plans: MemberPlan[];
  byId: Map<string, Connection>;
  baselineId: string | null;
  explaining: boolean;
}): JSX.Element {
  if (!plans.length) {
    return (
      <p className="p-3.5 text-xs text-ink-muted">
        {explaining ? 'Asking each member how it would run this…' : 'Nothing to plan yet.'}
      </p>
    );
  }

  const diff = planDiff(plans, baselineId, (id) => byId.get(id)?.name ?? id);
  const failed = diff.members.filter((m) => m.error);
  const maxTotal = Math.max(1, ...Object.values(diff.totals));
  const grid = {
    gridTemplateColumns: `minmax(140px, 190px) repeat(${diff.members.length}, minmax(170px, 1fr))`,
  };

  return (
    <div className="p-3.5 flex flex-col gap-4 min-w-fit">
      {/* The headline, as a picture: how much work each server signed up
          for. One bar each, one scale, and the gap between them is the
          finding before a single table name has been read. */}
      <div className="flex flex-col gap-2 max-w-[640px]">
        <span className="text-[11px] text-ink-muted">Rows the whole plan reads</span>
        {diff.members.map((m) => {
          const total = diff.totals[m.connectionId] ?? 0;
          const worst = total === maxTotal && diff.members.length > 1;
          return (
            <div key={m.connectionId} className="flex items-center gap-2.5">
              <span className="w-[150px] shrink-0 text-[11px] text-ink truncate">
                {byId.get(m.connectionId)?.name ?? m.connectionId}
                {m.connectionId === baselineId && (
                  <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent">base</span>
                )}
              </span>
              <WorkBar value={total / maxTotal} tone={worst ? 'hot' : 'cool'} />
              <span className="w-[92px] shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                {m.error ? '—' : total.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      {diff.headline ? (
        <p className="text-[11px] text-warn/90 leading-snug max-w-[860px]">{diff.headline}</p>
      ) : explaining ? (
        <p className="text-[11px] text-ink-muted">Asking each member how it would run this…</p>
      ) : (
        <p className="text-[11px] text-good/90">
          Every member reaches every table the same way.
        </p>
      )}

      <div className="rounded border border-card-border overflow-hidden w-fit">
        <div className="grid" style={grid}>
          <Head sticky>Table</Head>
          {diff.members.map((m) => {
            const conn = byId.get(m.connectionId);
            return (
              <Head key={m.connectionId}>
                <span className="block text-[11px] text-ink truncate">
                  {conn?.name ?? m.connectionId}
                  {m.connectionId === baselineId && (
                    <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent">base</span>
                  )}
                </span>
                <span className="block text-[9px] text-ink-faint truncate">
                  {conn ? variantLabel(conn.variant, conn.engine) : ''}
                </span>
              </Head>
            );
          })}

          {diff.rows.map((row) => (
            <PlanRowCells key={row.table} table={row.table} cells={row.cells} max={diff.maxWork} />
          ))}

          {diff.matching > 0 && (
            <>
              <RowHead muted>
                {diff.matching} table{diff.matching === 1 ? '' : 's'} reached the same way
              </RowHead>
              {diff.members.map((m) => (
                <div
                  key={m.connectionId}
                  className="px-2.5 py-2 border-b border-card font-mono text-[11px] text-ink-muted"
                >
                  ·
                </div>
              ))}
            </>
          )}

          <RowHead label>Steps</RowHead>
          {diff.members.map((m) => (
            <div
              key={m.connectionId}
              className="px-2.5 py-1.5 border-t border-card-border font-mono text-[11px] tabular-nums text-ink-muted"
            >
              {m.error ? '—' : m.rows.length}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3.5 text-[10px] text-ink-faint">
        <Swatch className="bg-hot" label="reads the whole table" />
        <Swatch className="bg-warn" label="reads more than the baseline" />
        <Swatch className="bg-good" label="narrowed by an index" />
      </div>

      {failed.map((m) => (
        <div key={m.connectionId} className="flex items-baseline gap-2.5">
          <span className="shrink-0 text-[11px] text-bad/90">
            {byId.get(m.connectionId)?.name ?? m.connectionId}
          </span>
          <span className="font-mono text-[10px] text-ink-muted leading-snug">{m.error}</span>
        </div>
      ))}
    </div>
  );
}

/// The ledger's bar, at the ledger's proportions.
///
/// Square root rather than linear: forty rows beside nine hundred thousand
/// is a quarter of a pixel linearly, and an invisible bar reads as no bar
/// rather than as a very small one. The number beside it is exact; the bar
/// is for the comparison.
function WorkBar({ value, tone }: { value: number; tone: 'hot' | 'warn' | 'cool' }): JSX.Element {
  const colour =
    tone === 'hot' ? 'bg-hot' : tone === 'warn' ? 'bg-warn' : 'bg-good';
  const width = Math.sqrt(Math.max(0, Math.min(1, value)));
  return (
    <span className="flex-1 h-[7px] rounded-[3.5px] bg-card block relative overflow-hidden">
      <span
        className={`absolute inset-y-0 left-0 rounded-[3.5px] bar-grow ${colour}`}
        style={{ width: `max(2px, ${(width * 100).toFixed(3)}%)` }}
      />
    </span>
  );
}

const PLAN_TONES: Record<PlanTone, string> = {
  baseline: 'text-ink',
  same: 'text-ink-muted',
  differs: 'text-ink-faint',
  worse: 'text-warn/90 bg-warn/[0.08]',
  // Said as plainly as the bad news. A comparison that only ever blames the
  // far end is one you stop believing.
  better: 'text-good/90 bg-good/[0.07]',
  absent: 'text-ink-faint',
  unknown: 'text-ink-faint',
};

function PlanRowCells({
  table,
  cells,
  max,
}: {
  table: string;
  cells: PlanCell[];
  max: number;
}): JSX.Element {
  return (
    <>
      <RowHead>{table}</RowHead>
      {cells.map((cell) => (
        <div
          key={cell.memberId}
          title={cell.work === null ? undefined : `${cell.work.toLocaleString()} rows read here`}
          className={`px-2.5 py-2 border-b border-card flex flex-col gap-1.5 min-w-0 ${PLAN_TONES[cell.tone]}`}
        >
          {cell.work === null ? (
            <span className="h-[7px]" />
          ) : (
            <WorkBar
              value={cell.work / max}
              // A full scan is drawn hot whatever the baseline does, because
              // it is the finding — not only when someone else did better.
              tone={cell.kind === 'full' ? 'hot' : cell.tone === 'worse' ? 'warn' : 'cool'}
            />
          )}
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-mono text-[11px] truncate">{cellLabel(cell)}</span>
            <div className="flex-1" />
            {cell.work !== null && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-70">
                {compactRows(cell.work)}
              </span>
            )}
          </span>
        </div>
      ))}
    </>
  );
}

/// Row counts in a cell that is already carrying a bar and an access path.
function compactRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/// One member's own answer, when the comparison is not the thing you want.
function MemberResult({ run, name }: { run: MemberRun; name: string }): JSX.Element {
  if (run.status === 'error') {
    return (
      <div className="p-4">
        <p className="text-xs text-bad/90 leading-relaxed max-w-[70ch]">{run.error}</p>
      </div>
    );
  }
  if (!run.columns.length) {
    return (
      <div className="p-4 text-xs text-ink-muted">
        {run.status === 'done' ? `${name} returned no columns.` : `${name} is still running…`}
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      {run.truncated && (
        <p className="shrink-0 px-3.5 py-2.5 text-[11px] leading-relaxed text-warn/90 border-b border-card">
          Capped at {run.rows.length.toLocaleString()} rows — this member's answer is incomplete,
          and a comparison against it is about what came back, not what is in the table.
        </p>
      )}
      <div className="flex-1 min-h-0">
        <ResultGrid columns={run.columns} rows={run.rows} />
      </div>
    </div>
  );
}

/// Do the tables this statement just read have the same indexes?
///
/// Asked here, in the comparison, because here is where the question comes
/// up: one member came back in 11 ms and another in 512, and the first
/// thing anyone wants to know is whether the slow one is missing an index
/// or simply holds more rows. The Schema drift tab answers a bigger
/// question about the whole catalog; this one is scoped to the tables the
/// server itself said these columns came from.
///
/// Drawn as rows in the same matrix the columns above use — a row per
/// index, a cell per member — rather than as a verdict cell plus a
/// paragraph. The pane already teaches that way of reading, and prose
/// cannot say which member it is about once there are three of them.
///
/// Nothing here runs a statement. It reads the catalogs the schema tree has
/// already loaded, and a member whose catalog has not been read says so
/// rather than reporting a match.
function IndexRows({
  members,
  baselineId,
  columns,
  byId,
}: {
  members: MemberRun[];
  baselineId: string | null;
  /// The baseline's result columns, which carry the source table the
  /// engine attributed each one to.
  columns: ColumnMeta[];
  byId: Map<string, Connection>;
}): JSX.Element | null {
  const schemas = useStore((s) => s.schemas);
  const loadSchema = useStore((s) => s.loadSchema);

  const tables = useMemo(() => touchedTables(columns), [columns]);

  useEffect(() => {
    if (tables.length === 0) return;
    for (const m of members) void loadSchema(m.connectionId);
  }, [tables.length, members, loadSchema]);

  const matrix = useMemo(
    () =>
      indexMatrix(
        members.map((m) => ({ connectionId: m.connectionId, snapshot: schemas[m.connectionId] })),
        baselineId,
        tables,
      ),
    [members, baselineId, schemas, tables],
  );

  const consequence = useMemo(() => indexConsequence(matrix), [matrix]);

  // Nothing the server could attribute to a table — `select count(*)`, an
  // expression, a statement with no result columns. Saying nothing is the
  // honest answer, and a row of em dashes would not be.
  if (tables.length === 0) return null;

  return (
    <>
      <div className="col-span-full px-2.5 pt-2 pb-1 border-t border-card-border flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wide text-ink-muted">Indexes</span>
        <span className="text-[10px] text-ink-faint font-mono">
          {matrix.tables.join(', ')}
        </span>
        <span className="flex-1" />
        {matrix.matching > 0 && (
          <span className="text-[10px] text-ink-faint">
            {matrix.matching} match{matrix.matching === 1 ? 'es' : ''} on every member
          </span>
        )}
      </div>

      {matrix.rows.length === 0 ? (
        <div className="col-span-full px-2.5 pb-1.5 text-[11px] text-ink-faint">
          {matrix.matching === 0
            ? 'No indexes on these tables, on any member.'
            : 'Every index is the same on every member.'}
        </div>
      ) : (
        matrix.rows.map((row) => (
          <Fragment key={`${row.table}:${row.label}`}>
            <RowHead muted>
              <span className="font-mono" title={row.table}>
                {row.label}
              </span>
            </RowHead>
            {row.cells.map((c) => (
              <div
                key={c.memberId}
                className={`px-2.5 py-1.5 border-b border-card font-mono text-[11px] truncate ${TONES[c.tone]}`}
                title={`${byId.get(c.memberId)?.name ?? c.memberId} — ${row.table} ${row.label}`}
              >
                {c.text}
              </div>
            ))}
          </Fragment>
        ))
      )}

      {/* What the cells COST, which a cell cannot say. */}
      {consequence && (
        <p className="col-span-full px-2.5 py-1.5 border-t border-card-border text-[11px] text-ink-muted leading-relaxed">
          {consequence}
        </p>
      )}
    </>
  );
}

/// Statements that show the sample doing what it was built to show. Each one
/// finds a difference the sample planted — see src/main/sample.ts — so the
/// first run of the app is a comparison with something in it.
const SAMPLE_STARTERS: { label: string; sql: string }[] = [
  {
    label: 'Orders by status',
    sql: 'select status, count(*) as orders, sum(total_cents) / 100.0 as revenue\nfrom orders\ngroup by status\norder by status;',
  },
  {
    label: 'Product prices',
    sql: 'select sku, name, price_cents\nfrom products\norder by sku;',
  },
  {
    label: 'Top customers',
    sql: 'select c.name, c.region, count(o.id) as orders\nfrom customers c\njoin orders o on o.customer_id = c.id\ngroup by c.id\norder by orders desc\nlimit 10;',
  },
];

function SampleStarters({ onPick, onDrift }: { onPick(sql: string): void; onDrift(): void }): JSX.Element {
  return (
    <div className="rounded-lg border border-accent/35 bg-accent/[0.05] p-3 max-w-[62ch]">
      <p className="text-xs text-ink">This is the sample: one shop in three environments.</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        Run one of these — each environment answers, and whatever differs from prod is marked.
        Staging has an old price; local has a column and a table still in review.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {SAMPLE_STARTERS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.sql)}
            className="rounded border border-card bg-surface px-2 py-1 text-[11px] text-ink hover:border-accent/60"
          >
            {s.label}
          </button>
        ))}
        <span className="mx-1 text-[11px] text-ink-faint">or</span>
        <button onClick={onDrift} className="text-[11px] text-accent hover:underline">
          compare their schemas
        </button>
      </div>
    </div>
  );
}
