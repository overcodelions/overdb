import { useEffect, useMemo, useRef, useState } from 'react';
import { AskPane } from './AskPane';
import { FanoutPane } from './FanoutPane';
import { Markdown } from './Markdown';
import { LogView } from './LogView';
import { SlowQueryPane } from './SlowQueryPane';
import { TableBrowser } from './TableBrowser';
import { Resizer } from './Resizer';

/// Green reads, amber changes, red loses. Whole class strings so Tailwind
/// emits them.
const RUNNING_BAR: Record<Severity, string> = {
  read: 'bg-good/80',
  mutating: 'bg-warn/85',
  destructive: 'bg-bad/85',
};
/// Shown in place of a translation when there is no CLI to do one.
///
/// overdb translates questions by shelling out to a coding CLI you already
/// have; it ships no model of its own. On a machine with none of them the
/// honest answer is that this one feature is off — said once, in the panel,
/// with the three names you would install. Everything else in overdb works
/// without it.
const NO_AI_NOTE = [
  '**No AI CLI found, so questions cannot be translated.**',
  '',
  'overdb has no model of its own — it asks a coding CLI you already have.',
  'Install and sign into any one of `claude`, `codex` or `gemini`, then press',
  'Run again. Pick which one in Settings.',
  '',
  'Everything else — running SQL, plans, the catalog, history — works without it.',
].join('\n');

import { WriteControls } from './WriteControls';
import { QueryError } from './QueryError';
import { PlanView } from './PlanView';
import { parsePlan, type PlanRow } from '@shared/plan';
import {
  affectedVerb,
  replaceEnd,
  severity,
  splitStatements,
  statementAt,
  type Severity,
} from '@shared/sqlGuard';
import { looksLikeQuestion, stripTrailingSemicolons } from '@shared/looksLikeSql';
import { queryLanguage } from '@shared/engines';
import {
  accessSummary,
  analyzePartiql,
  buildItemUpdate,
  dynamoEditTarget,
  orderByProblem,
  parseTarget,
  prepareStatement,
  shapeFromTableInfo,
} from '@shared/dynamo';
import { ensureTerminated, formatSql } from '@shared/formatSql';
import { bufferLabel, buffersFor } from '@shared/buffers';
import { suggestionBlock } from '@shared/suggestion';
import { ResultGrid } from './ResultGrid';
import { ChartView } from './ChartView';
import { RailSlot } from './BottomRail';
import { ErdView } from './ErdView';
import { HealthPane } from './HealthPane';
import { HistoryPane } from './HistoryPane';
import { buildUpdate, editTarget, previewUpdate, type KeyedTable } from '@shared/rowEdit';
import { SqlEditor } from './SqlEditor';
import { ParamPopover } from './ParamPopover';
import { bindFor, paramSlots, resolveParams, unfilledParams, type ParamSlot } from '@shared/params';
import {
  ERD_TAB,
  HEALTH_TAB,
  HISTORY_TAB,
  LOG_TAB,
  SLOW_TAB,
  useQuery,
  type ResultTab,
} from './queryStore';
import { useStore } from './store';
import { useFanout } from './fanoutStore';
import type { AiTool, Connection, EnvSet } from '@shared/types';

export function QueryPane(): JSX.Element {
  const selection = useStore((s) => s.selection);
  const connections = useStore((s) => s.connections);

  const [askOpen, setAskOpen] = useState(false);

  /// The table list, folded away by default. It is a browser, not a

  /// navigator: nothing here changes what the editor is pointed at.

  const [tablesOpen, setTablesOpen] = useState(false);
  const [inject, setInject] = useState<{
    text: string;
    nonce: number;
    mode?: 'insert' | 'append' | 'replace';
    range?: { from: number; to: number };
  }>({ text: '', nonce: 0 });
  const [askRequest, setAskRequest] = useState<{ mode: 'ask' | 'explain' | 'faster'; question: string; nonce: number; sql?: string }>();
  /// True while the panel has a tuning request in flight, so the plan tab's
  /// button can say so. Reported UP from the panel rather than guessed here:
  /// the panel is what knows when the model has finished.
  const [askBusy, setAskBusy] = useState(false);
  /// Tagged with the buffer it was produced for. A plan is about one
  /// statement on one connection, so an untagged one outlives its subject:
  /// explain on MariaDB, switch to the DynamoDB connection, and its Plan tab
  /// was still sitting there offering someone else's query plan.
  const [plan, setPlan] = useState<{
    key: string;
    rows: PlanRow[];
    raw: string;
    /// The statement that was explained. Kept because the plan names its
    /// steps by alias, and only the SQL says which table each one is.
    sql?: string;
    /// A second plan, for a statement you have NOT run — the model's
    /// suggested rewrite, usually. Kept beside the first rather than
    /// replacing it: the whole value is the comparison.
    compare?: { rows: PlanRow[]; raw: string; sql: string };
  } | null>(null);
  const [askWidth, setAskWidth] = useState(400);
  /// Bumped when something asks for the Plan tab to come to the front.
  ///
  /// Switching to it directly raced: `setActive` lives in the query store
  /// and `setPlan` in React state, so the tab strip rendered with the Plan
  /// tab selected but not yet existing, and the guard below bounced it back
  /// to the results — hence "I have to click it twice". This waits for the
  /// plan to actually be there.
  const [focusPlan, setFocusPlan] = useState(0);
  const [cursor, setCursor] = useState({ from: 0, to: 0 });
  const [translating, setTranslating] = useState(false);
  /// What the model said when it could NOT produce SQL. Almost always the
  /// most useful sentence in the exchange — "there is no panel_widget in
  /// acme_cms" tells you exactly what to fix — and it used to be thrown
  /// away behind a generic "Could not turn that into SQL."
  const [translateNote, setTranslateNote] = useState<string | null>(null);
  // A ref as well as state: `setTranslating` doesn't take effect until the
  // next render, so two quick ⌘↵ presses both passed the state check and
  // translated twice — the second one replacing a range the first had
  // already moved. The ref closes that window synchronously.
  const translatingRef = useRef(false);
  /// A rewrite of one statement in flight. Separate from `translating`
  /// because they replace different things — a question becomes SQL, a
  /// statement becomes a different statement — and the editor's box has to
  /// know which one it is waiting for.
  const [refining, setRefining] = useState(false);
  /// Which CLIs are actually on this machine, or null while we are still
  /// asking. Translation is the one feature here that depends on a program
  /// overdb does not ship, so "is there any" is state the UI reads rather
  /// than a surprise it delivers after you press Run.
  const [aiTools, setAiTools] = useState<Record<AiTool, boolean> | null>(null);
  /// Only ever true once detection has actually answered. An unknown answer
  /// must not read as "no" — the toolbar would offer Run for a question and
  /// then translate it anyway.
  const noAi = aiTools !== null && !Object.values(aiTools).some(Boolean);
  useEffect(() => {
    void window.overdb
      .invoke('ai:detect')
      .then(setAiTools)
      .catch(() => setAiTools(null));
  }, []);

  /// Explain and the slow-query nudge both do the same thing: open the panel
  /// and ask it about the statement in front of you. The panel is where the
  /// answer lands, not where the question has to begin.
  /// Explain does two things at once, deliberately: it shows you the plan
  /// your server actually produced, and it asks for an interpretation. The
  /// prose is worth more when you can see what it is talking about.
  /// The plan, and nothing else — no model, no panel. This is what the
  /// results bar's Plan button runs: seeing the plan is a cheap, local act,
  /// and making it cost an AI round trip made it something you thought twice
  /// about.
  /// `only` names a statement that is not the one in the editor — the log
  /// replays a statement you have since typed over, and planning the buffer
  /// instead would silently answer a different question.
  const showPlan = async (only?: string) => {
    const statement = (only ?? tabs[active]?.sql ?? targetSql()).trim();
    if (!statement || !conn || !bufferKey) return;
    // No connected check: EXPLAIN needs the host, and main reopens a dead
    // or never-opened session rather than refusing — asking for a plan is
    // as much a request for the connection as running is.
    const key = bufferKey;
    const filled = bound(statement);
    if (!filled) return;
    try {
      const result = await window.overdb.invoke('query:explain', {
        connectionId: conn.id, sql: filled.sql, params: filled.params, analyze: false,
      });
      setPlan({
        key,
        rows: parsePlan(conn.engine, result.format, result.plan),
        raw: result.plan,
        sql: statement,
      });
    } catch (err) {
      setPlan({ key, rows: [], raw: err instanceof Error ? err.message : String(err) });
    }
    setFocusPlan((n) => n + 1);
  };

  const explain = async (question = '', only?: string) => {
    // The statement you are looking at, not the whole buffer: EXPLAIN takes
    // exactly one, and a two-statement editor would just error.
    const statement = (only ?? tabs[active]?.sql ?? targetSql()).trim();
    if (!statement || !conn || !bufferKey) return;
    const key = bufferKey;
    setAskOpen(true);
    setAskRequest((p) => ({ mode: 'explain', question, nonce: (p?.nonce ?? 0) + 1, sql: statement }));
    const filled = bound(statement);
    if (!filled) return;
    try {
      const result = await window.overdb.invoke('query:explain', {
        connectionId: conn.id, sql: filled.sql, params: filled.params, analyze: false,
      });
      setPlan({
        key,
        rows: parsePlan(conn.engine, result.format, result.plan),
        raw: result.plan,
        sql: statement,
      });
    } catch (err) {
      setPlan({ key, rows: [], raw: err instanceof Error ? err.message : String(err) });
    }
  };

  /// Plan a statement WITHOUT running it — the answer to "would that rewrite
  /// actually be faster?". EXPLAIN executes nothing, so this is safe to
  /// offer on a statement the model wrote and nobody has read yet, and what
  /// comes back is the server's own estimate rather than a simulation of
  /// ours.
  const planAlternative = async (sql: string) => {
    if (!conn || !bufferKey) return;
    const statement = sql.trim().replace(/;\s*$/, '');
    if (!statement) return;
    const filled = bound(statement);
    if (!filled) return;
    try {
      const result = await window.overdb.invoke('query:explain', {
        connectionId: conn.id, sql: filled.sql, params: filled.params, analyze: false,
      });
      setPlan((p) =>
        p && p.key === bufferKey
          ? {
              ...p,
              compare: {
                rows: parsePlan(conn.engine, result.format, result.plan),
                raw: result.plan,
                sql: statement,
              },
            }
          : p,
      );
      setFocusPlan((n) => n + 1);
      toast('Planned — comparison is in the Plan tab.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /// Ask what to try instead. The plan tab's button.
  ///
  /// It asks about the statement THIS PLAN is for, not the editor buffer:
  /// the plan may have come from the log, and tuning a query you have since
  /// typed over is advice about the wrong thing. Nothing is run and nothing
  /// is changed — the answer arrives as blocks in the panel, each with its
  /// own Plan button, and the server's plan of the suggestion is what
  /// actually decides whether it is better.
  const tune = () => {
    const statement = (plan?.sql ?? tabs[active]?.sql ?? targetSql()).trim();
    if (!statement || !conn) return;
    setAskOpen(true);
    setAskRequest((p) => ({ mode: 'faster', question: '', nonce: (p?.nonce ?? 0) + 1, sql: statement }));
  };

  /// A suggestion goes to the END of the tab, under a line saying where it
  /// came from — never at the cursor, which put a hundred-line rewrite
  /// inside whatever statement you happened to be reading.
  const suggestion = (text: string, note: string) =>
    suggestionBlock(ensureTerminated(formatSql(text, formatStyle)), note);

  const appendSuggestion = (text: string, note: string) =>
    setInject((p) => ({ text: suggestion(text, note), nonce: p.nonce + 1, mode: 'append' }));

  /// The same statement, in a tab of its own — which is what you want for a
  /// rewrite, because the whole point is to keep the original to compare
  /// against.
  const openSuggestion = (text: string, note: string) => {
    if (!conn) return;
    const key = newBuffer(conn.id);
    setBuffer(key, suggestion(text, note));
  };

  const envSets = useStore((s) => s.envSets);
  const envSet =
    selection?.kind === 'envSet' ? envSets.find((e) => e.id === selection.id) : undefined;

  const conn =
    selection?.kind === 'connection'
      ? connections.find((c) => c.id === selection.id) ?? null
      : null;

  // Buffers never cross connections: carrying a query written for one schema
  // over to another is at best noise and at worst a query that means
  // something different against the tables it now lands on. Within a
  // connection you get as many as you open, because one scratchpad per
  // database means scrolling past a day's work to write the next query.
  const buffers = useStore((s) => s.buffers);
  const setBuffer = useStore((s) => s.setBuffer);
  const newBuffer = useStore((s) => s.newBuffer);
  const closeBuffer = useStore((s) => s.closeBuffer);
  const selectBuffer = useStore((s) => s.selectBuffer);
  const activeBuffer = useStore((s) => (conn ? s.activeBuffer[conn.id] : undefined));
  const bufferSchema = useStore((s) => s.bufferSchema);
  /// Remembered placeholder values. Read here and handed to the editor so a
  /// value edited in the panel repaints its chip immediately.
  const paramBindings = useStore((s) => s.params);
  const bufferKeys = useMemo(
    () => (conn ? buffersFor(conn.id, buffers) : []),
    [conn?.id, buffers],
  );
  // A remembered key can outlive its tab — closing happens from the strip,
  // but a connection deleted and re-added takes its buffers with it. Falling
  // back to the first tab beats rendering an editor onto nothing.
  const bufferKey =
    activeBuffer && bufferKeys.includes(activeBuffer) ? activeBuffer : bufferKeys[0];
  const sql = (bufferKey ? buffers[bufferKey] : '') ?? '';
  // Not cleared on switch but ignored on mismatch, so going back to the
  // buffer you explained brings its plan back with it.
  const bufferPlan = plan && plan.key === bufferKey ? plan : null;
  const setSql = (text: string) => {
    if (bufferKey) setBuffer(bufferKey, text);
  };

  const schema = useStore((s) => (conn ? s.schemas[conn.id] : undefined));
  const schemaList = useStore((s) => (conn ? s.schemaList[conn.id] : undefined));
  const activeSchema = useStore((s) => (conn ? s.activeSchema[conn.id] : undefined));
  const toast = useStore((s) => s.toast);
  const slowQueryMs = useStore((s) => s.settings.slowQueryMs);
  const formatStyle = useStore((s) => s.settings.formatStyle);
  const editorHeight = useStore((s) => s.settings.editorHeight);
  const saveSettings = useStore((s) => s.saveSettings);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const flagWriteBlocked = useStore((s) => s.flagWriteBlocked);
  const pinnedCount = conn?.pinnedTables?.length ?? 0;
  /// PartiQL is not SQL. Every string that offers to write the user a
  /// query has to name the language their database actually speaks.
  const lang = queryLanguage(conn?.engine ?? 'postgres');
  /// Whether what Run is pointed at is a question rather than a statement.
  /// Includes prose that happens to open with SELECT — that used to go to
  /// the server and come back as a syntax error.
  const isQuestion = useMemo(() => {
    const target =
      cursor.to > cursor.from
        ? sql.slice(cursor.from, cursor.to)
        : (statementAt(splitStatements(sql, conn?.engine ?? 'postgres'), cursor.from)?.sql ?? sql);
    return looksLikeQuestion(target);
  }, [sql, cursor, conn?.engine]);

  /// Drives the Run button's label, so it is obvious BEFORE you press it
  /// that the next keystroke translates rather than executes. A question
  /// with no CLI to translate it is still a question, but the button must
  /// not promise something this machine cannot do.
  const willTranslate = isQuestion && !noAi;

  /// DynamoDB's whole hazard is that cost is invisible in the syntax: the
  /// same SELECT is a key lookup or a read of the entire table depending on
  /// which attribute you filtered, and you find out from the bill. So the
  /// answer goes above the editor BEFORE you run, not in a plan afterwards.
  const dynamo = useMemo(() => {
    if (conn?.engine !== 'dynamodb') return null;
    const target =
      cursor.to > cursor.from
        ? sql.slice(cursor.from, cursor.to)
        : (statementAt(splitStatements(sql, 'dynamodb'), cursor.from)?.sql ?? sql);
    if (!target.trim() || looksLikeQuestion(target)) return null;
    const name = parseTarget(target).table;
    const table = name
      ? schema?.schemas
          .flatMap((sc) => sc.tables)
          .find((t) => t.name === name)
      : undefined;
    const shape =
      table && table.primaryKey.length
        ? {
            name: table.name,
            keys: { partitionKey: table.primaryKey[0], sortKey: table.primaryKey[1] ?? null },
            indexes: table.indexes.map((i) => ({
              name: i.name,
              keys: { partitionKey: i.columns[0], sortKey: i.columns[1] ?? null },
              type: 'gsi' as const,
              projection: 'ALL',
            })),
          }
        : undefined;
    // The clauses PartiQL does not have. Said here, before Run, because the
    // server's version of this is "Unsupported clause: LIMIT at 5:7:3" —
    // true, unhelpful, and arriving after you have waited for it.
    const prepared = prepareStatement(target);
    return {
      access: analyzePartiql(target, shape),
      notes: [prepared.note, orderByProblem(target, shape)].filter(
        (n): n is string => Boolean(n),
      ),
    };
  }, [conn?.engine, sql, cursor, schema]);

  const dynamoAccess = dynamo?.access ?? null;

  const logCount = useQuery((s) => s.log.length);

  const statementCount = useMemo(
    () => splitStatements(sql, conn?.engine ?? 'postgres').length,
    [sql, conn?.engine],
  );
  const schemaError = useStore((s) => (conn ? s.schemaError[conn.id] : undefined));
  const schemaLoading = useStore((s) => (conn ? s.schemaLoading[conn.id] : false));
  const loadSchema = useStore((s) => s.loadSchema);
  const loadSchemaList = useStore((s) => s.loadSchemaList);
  /// Whether the host is actually up. Pushed from main, so it also catches
  /// a connection that died under us — which is what produced "mysql
  /// adapter is not connected" as a failed row in the log, twenty seconds
  /// after the last query on the same tab worked.
  const live = useStore((s) => (conn ? s.connState[conn.id] : undefined));
  const connected = live === 'open';
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    if (!conn || connecting) return;
    setConnecting(true);
    try {
      // `conn:open` explicitly, rather than leaning on the one loadSchema
      // does for itself: loadSchema returns immediately when a catalog is
      // already cached, and a session that died under us still has its
      // catalog — so pressing Connect opened nothing, said nothing, and
      // the button just blinked. Forced for the same reason: the cached
      // catalog was read from a session that no longer exists.
      const opened = await window.overdb.invoke('conn:open', conn.id);
      if (!opened.ok) {
        toast(opened.error ?? 'Could not connect.', 'error');
        return;
      }
      // A reconnected session has no catalog and no schema selected, and
      // completion going dead is a stranger failure than not being
      // connected.
      await loadSchema(conn.id, { force: true });
      await loadSchemaList(conn.id);
      const failed = useStore.getState().schemaError[conn.id];
      toast(
        failed
          ? `Connected, but the schema could not be read: ${failed}`
          : `Connected to ${conn.name}.`,
        failed ? 'error' : undefined,
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setConnecting(false);
    }
  };
  const switchSchema = useStore((s) => s.switchSchema);
  const { tabs, active, running, run, cancel, setActive, sortBy, filterBy, runEdit } = useQuery();
  const current: ResultTab | undefined = tabs[active];

  /// Table or chart, for whichever result is in front.
  ///
  /// One setting for the pane rather than one per tab: charting is a mode
  /// you are in — having asked for a picture of statement one, being handed
  /// a grid for statement two is a tab's worth of clicking to get back to
  /// where you already were.
  /// The statement waiting for a set to be chosen, when more than one
  /// could be meant. Null when nothing is being picked.
  const [pickSetFor, setPickSetFor] = useState<string | null>(null);

  const handOff = useFanout((s) => s.handOff);
  const selectPane = useStore((s) => s.select);
  const sets = useMemo(
    () => (conn ? eligibleSets(envSets, conn.id) : { mine: [], rest: [], all: [] }),
    [envSets, conn],
  );

  /// Hand one statement to an environment set and go there.
  ///
  /// A handoff rather than a direct call because the two panes are never
  /// mounted together: selecting the set unmounts this one. See
  /// `fanoutStore.handOff`.
  const runOnSet = (envSet: EnvSet, statement: string) => {
    setPickSetFor(null);
    const text = statement.trim();
    if (!text) {
      toast('Nothing to run — put the cursor on a statement first.', 'error');
      return;
    }
    handOff(envSet.id, text);
    selectPane({ kind: 'envSet', id: envSet.id });
    toast(`Running on ${envSet.name}.`);
  };

  const [resultView, setResultView] = useState<'table' | 'chart'>('table');
  /// Whether the thing on screen is a result grid at all. A write's outcome,
  /// an error, a plan and the standing tabs all have nothing to draw.
  const gridShowing =
    active >= 0 &&
    current !== undefined &&
    current.status !== 'error' &&
    current.columns.length > 0;

  /// The catalog in the vocabulary the edit check wants: which columns of
  /// which table address exactly one row.
  const keyedTables = useMemo(
    (): KeyedTable[] =>
      (schema?.schemas ?? []).flatMap((sc) =>
        sc.tables.map((t) => ({
          schema: sc.name,
          name: t.name,
          primaryKey: t.primaryKey,
          indexes: t.indexes,
        })),
      ),
    [schema],
  );

  /// Editing is offered only where the write can be proved to hit one row —
  /// and where it cannot, the grid says which part failed rather than
  /// ignoring the double-click. DynamoDB is excluded for now: addressing an
  /// item needs its full key, and the write has no server-side read-only to
  /// fall back on.
  /// The DynamoDB table a result came from, with its key schema — the half
  /// an item update cannot be written without.
  const dynamoShapeOf = (statement: string) => {
    const name = parseTarget(statement).table;
    const info = name
      ? schema?.schemas.flatMap((sc) => sc.tables).find((t) => t.name === name)
      : undefined;
    return info ? shapeFromTableInfo(info) : undefined;
  };

  const canEdit = (columnIndex: number): { ok: boolean; reason?: string } => {
    if (!conn || !current) return { ok: false };
    if (current.kind !== 'read') return { ok: false, reason: 'This result is not a query.' };
    const check =
      conn.engine === 'dynamodb'
        ? dynamoEditTarget(current.columns, current.sql, dynamoShapeOf(current.sql), columnIndex)
        : editTarget(current.columns, columnIndex, keyedTables);
    return check.ok ? { ok: true } : { ok: false, reason: check.reason };
  };

  const editCell = (rowIndex: number, columnIndex: number, value: string | null) => {
    if (!conn || !current) return;
    if (conn.engine === 'dynamodb') {
      editItem(rowIndex, columnIndex, value);
      return;
    }
    const check = editTarget(current.columns, columnIndex, keyedTables);
    if (!check.ok) {
      toast(check.reason, 'error');
      return;
    }
    // Writes off is not a failure to explain after the fact: the toggle in
    // the header is the answer, so it pulses rather than the server refusing
    // a statement nobody needed to send.
    if (!conn.writesEnabled) {
      flagWriteBlocked(conn.id);
      toast('Writes are off for this connection — the toggle is in the header.', 'error');
      return;
    }

    const keyValues = check.target.keys.map((k) => current.rows[rowIndex][k.index]);
    const { sql, params } = buildUpdate(check.target, value, keyValues, conn.engine);

    askConfirm({
      title: `Update one row in ${check.target.table}?`,
      body:
        `${previewUpdate(sql, params, conn.engine)}\n\n` +
        `Addressed by its ${check.target.keySource}, so it changes exactly this row.` +
        (conn.env === 'prod' ? ' This connection is production.' : ''),
      confirmLabel: 'Update',
      destructive: conn.env === 'prod',
      onConfirm: async () => {
        const result = await runEdit(active, { sql, params }, conn.engine);
        if (!result.ok) toast(result.error ?? 'The update failed.', 'error');
        else if (result.affectedRows === 0) {
          toast('Nothing matched — the row is no longer there.', 'error');
        } else toast('Updated.');
      },
    });
  };

  /// Writing one attribute of one item.
  ///
  /// The confirmation says more than the SQL one does, because the guarantee
  /// is weaker: DynamoDB has no server-side read-only mode, so the toggle
  /// overdb offers is a UX guard and the IAM policy on these credentials is
  /// the only thing that actually stops a write.
  const editItem = (rowIndex: number, columnIndex: number, value: string | null) => {
    if (!conn || !current) return;
    const check = dynamoEditTarget(
      current.columns,
      current.sql,
      dynamoShapeOf(current.sql),
      columnIndex,
    );
    if (!check.ok) {
      toast(check.reason, 'error');
      return;
    }
    if (!conn.writesEnabled) {
      flagWriteBlocked(conn.id);
      toast('Writes are off for this connection — the toggle is in the header.', 'error');
      return;
    }

    const cell = (index: number) => {
      const raw = current.rows[rowIndex][index];
      return {
        text: raw === null || typeof raw === 'object' ? null : String(raw),
        kind: current.columns[index].kind,
      };
    };
    const { sql, params, preview } = buildItemUpdate(
      check.target,
      { text: value, kind: current.columns[columnIndex].kind },
      check.target.keys.map((k) => cell(k.index)),
    );

    askConfirm({
      title: `Update one item in ${check.target.table}?`,
      body:
        `${preview}\n\n` +
        'Addressed by its full primary key, so it changes exactly this item. DynamoDB has no ' +
        'server-side read-only mode — what actually permits this write is the IAM policy on ' +
        'these credentials.' +
        (conn.env === 'prod' ? ' This connection is production.' : ''),
      confirmLabel: 'Update',
      destructive: conn.env === 'prod',
      onConfirm: async () => {
        const result = await runEdit(active, { sql, params }, conn.engine);
        if (!result.ok) toast(result.error ?? 'The update failed.', 'error');
        else toast('Updated.');
      },
    });
  };

  const targetSql = (): string => {
    if (cursor.to > cursor.from) return sql.slice(cursor.from, cursor.to);
    const engine = conn?.engine ?? 'postgres';
    return statementAt(splitStatements(sql, engine), cursor.from)?.sql ?? sql;
  };

  /// Which value chip has its panel open, and where the chip is on screen.
  /// Held here rather than in the editor: the editor knows where the hole
  /// is and nothing about where values are kept.
  const [openParam, setOpenParam] = useState<{ slot: ParamSlot; at: DOMRect } | null>(null);

  /// Fill a statement's placeholders for THIS connection, or say why it
  /// cannot be filled. Used by everything that sends SQL from this pane
  /// other than Run, which binds inside the query store.
  ///
  /// EXPLAIN needs this as much as the run does: Postgres refuses to plan a
  /// statement whose `$1` has no value, and the engines that accept one
  /// plan a shape rather than the search you were about to do.
  const bound = (statement: string): { sql: string; params?: unknown[] } | null => {
    if (!conn) return null;
    const holes = paramSlots(statement, conn.engine);
    if (holes.length === 0) return { sql: statement };
    const target = { connectionId: conn.id, env: conn.env };
    const library = useStore.getState().params;
    const unfilled = unfilledParams(resolveParams(holes, library, target));
    if (unfilled.length > 0) {
      toast(`Needs a value for ${unfilled.map((u) => u.label).join(', ')}.`, 'error');
      return null;
    }
    try {
      return bindFor(statement, conn.engine, library, target);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return null;
    }
  };

  /// The span Run is about to act on, so a translation can replace exactly
  /// that and leave the rest of the buffer alone.
  const targetRange = (): { from: number; to: number } => {
    if (cursor.to > cursor.from) return { from: cursor.from, to: cursor.to };
    const stmt = statementAt(splitStatements(sql, conn?.engine ?? 'postgres'), cursor.from);
    // Through the semicolon: the replacement brings its own, and leaving the
    // old one behind is how a lone `;` ends up on a line of its own.
    return stmt ? { from: stmt.start, to: replaceEnd(sql, stmt.end) } : { from: 0, to: sql.length };
  };

  /// The statement in flight, or the one Run is about to send. Drives the
  /// progress bar's colour.
  const runningSeverity = useMemo((): Severity => {
    if (translating) return 'read';
    const inFlight = tabs.find((t) => t.status === 'running');
    return severity(inFlight?.sql ?? targetSql());
  }, [translating, tabs, sql, cursor, conn?.engine]);


  /// What Run actually runs, in priority order: an explicit selection, then
  /// the statement the cursor is in. Executing the whole buffer because it
  /// happens to be open is how a scratch query above a real one gets run by
  /// accident — every other client works this way for that reason.

  /// Typing a question where SQL goes is a reasonable thing to do, and
  /// making you retype it into a side panel is not. So ⌘↵ on plain English
  /// TRANSLATES rather than runs — and then stops, leaving the SQL in front
  /// of you. Running it is still your keystroke; nothing here executes what
  /// a model wrote.
  const translate = async (rawQuestion: string) => {
    if (!conn || translatingRef.current) return;
    // Twenty statements' worth of muscle memory puts a semicolon on the end
    // of the question too. It terminates a statement; it is not part of what
    // was asked, so it never reaches the model or the comment we leave.
    const question = stripTrailingSemicolons(rawQuestion);
    if (!question) return;
    translatingRef.current = true;
    // Asked again here rather than trusted from mount: a CLI installed
    // while overdb was open should work on the next ⌘↵, not the next launch.
    const detected = await window.overdb.invoke('ai:detect');
    setAiTools(detected);
    const preferred = useStore.getState().settings.aiTool;
    const tool =
      preferred && detected[preferred]
        ? preferred
        : (['claude', 'codex', 'gemini'] as const).find((t) => detected[t]);
    if (!tool) {
      // Nothing to translate with, so the question stays exactly as typed —
      // sending English to the server would only trade this for a syntax
      // error. The panel says what is missing; a toast would be gone before
      // you had read which three names to look for.
      setTranslateNote(NO_AI_NOTE);
      toast('No AI CLI found — that text was left alone.', 'error');
      translatingRef.current = false;
      return;
    }
    const range = targetRange();
    setTranslating(true);
    setTranslateNote(null);
    try {
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: conn.id, tool, mode: 'sql', question, editorText: sql,
        pinned: conn.pinnedTables,
      });
      if (!result.ok || !result.sql) {
        // The message is the answer here: the model has usually named the
        // missing table or the wrong schema. Showing it beats a toast that
        // says only that something went wrong.
        setTranslateNote(result.message?.trim() || result.error || 'No answer came back.');
        toast(result.error ?? `No ${lang} in the answer — see the panel below.`, 'error');
        return;
      }
      // The question is kept as a comment above the query: it documents the
      // intent, and it is what you edit if the translation missed.
      // Formatted here rather than requested in the prompt: a model asked
      // for a layout complies most of the time, and "most of the time" is
      // what makes generated code tiring to read.
      const replacement =
        `-- ${question.replace(/\s+/g, ' ').trim()}\n` +
        `${ensureTerminated(formatSql(result.sql, formatStyle))}\n`;
      setInject((p) => ({ text: replacement, nonce: p.nonce + 1, mode: 'replace', range }));
      setTranslateNote(null);
      toast('Translated — read it, then ⌘↵ to run.');
    } finally {
      translatingRef.current = false;
      setTranslating(false);
    }
  };

  /// Reformat every statement in the buffer, one blank line between each.
  /// Questions are left exactly as written — running English through a SQL
  /// formatter would be nonsense.
  const formatBuffer = () => {
    if (!conn || !sql.trim()) return;
    const next = splitStatements(sql, conn.engine)
      .map((s) => (looksLikeQuestion(s.sql) ? s.sql : ensureTerminated(formatSql(s.sql, formatStyle))))
      .join('\n\n');
    if (next === sql.trim()) return;
    setInject((p) => ({
      text: next,
      nonce: p.nonce + 1,
      mode: 'replace',
      range: { from: 0, to: sql.length },
    }));
    toast('Formatted.');
  };

  /// The `--` lines a statement opens with, which for a generated one are
  /// the question it came from. Kept across a rewrite and added to: the
  /// record of how a query got here is worth more than a tidy top line, and
  /// it is the only thing that says a model was involved at all.
  const leadingComments = (text: string): string[] => {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) {
        if (out.length) break;
        continue;
      }
      if (t.startsWith('--')) out.push(t);
      else break;
    }
    return out;
  };

  /// Change one statement to a follow-up instruction. Everything here is
  /// deliberately the same shape as a translation: the model writes, overdb
  /// puts the text in front of you, and running it is still your keystroke.
  const refineStatement = async (
    statement: { sql: string; from: number; to: number },
    instruction: string,
  ) => {
    if (!conn || refining) return;
    const detected = await window.overdb.invoke('ai:detect');
    setAiTools(detected);
    const preferred = useStore.getState().settings.aiTool;
    const tool =
      preferred && detected[preferred]
        ? preferred
        : (['claude', 'codex', 'gemini'] as const).find((t) => detected[t]);
    if (!tool) {
      setTranslateNote(NO_AI_NOTE);
      toast('No AI CLI found — nothing was changed.', 'error');
      return;
    }
    setRefining(true);
    try {
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: conn.id, tool, mode: 'refine', question: instruction,
        editorText: statement.sql, pinned: conn.pinnedTables,
      });
      if (!result.ok || !result.sql) {
        setTranslateNote(result.message?.trim() || result.error || 'No answer came back.');
        toast(result.error ?? `No ${lang} in the answer — see the panel below.`, 'error');
        return;
      }
      const replacement =
        [...leadingComments(statement.sql), `-- then: ${instruction.replace(/\s+/g, ' ').trim()}`]
          .join('\n') +
        `\n${ensureTerminated(formatSql(result.sql, formatStyle))}\n`;
      setInject((p) => ({
        text: replacement,
        nonce: p.nonce + 1,
        mode: 'replace',
        range: { from: statement.from, to: replaceEnd(sql, statement.to) },
      }));
      setTranslateNote(null);
      toast('Rewritten — read it, then ⌘↵ to run.');
    } finally {
      setRefining(false);
    }
  };

  const doRun = () => {
    // Deliberately not gated on `connected`: the run itself reopens the
    // session. Pressing Run when the dot is hollow is a request to run, not
    // a mistake to be corrected with a disabled button.
    if (!conn) return;
    const target = targetSql();
    if (looksLikeQuestion(target)) {
      // Known-missing CLI: say so here rather than starting a translation
      // that can only end in the same sentence a second later.
      if (noAi) {
        setTranslateNote(NO_AI_NOTE);
        return;
      }
      void translate(target);
      return;
    }
    // The note takes the whole results area, so it has to go the moment
    // something real is on its way — otherwise you run a query, get 29 rows,
    // and are still reading the model's last answer.
    setTranslateNote(null);
    void run(conn.id, target, conn.engine);
  };

  const doRunAll = () => {
    if (!conn) return;
    setTranslateNote(null);
    void run(conn.id, sql, conn.engine);
  };

  /// The note belongs to the connection it was asked about. Carrying it
  /// across a switch means the results pane is answering a question about a
  /// different database than the one named in the header.
  useEffect(() => {
    setTranslateNote(null);
  }, [conn?.id]);

  // Escape cancels, from anywhere in the pane including inside the editor.
  // Capture phase so CodeMirror does not swallow it first — but only while
  // something is actually running, so Escape keeps closing the completion
  // popup the rest of the time.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      void cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [running, cancel]);

  useEffect(() => {
    useQuery.getState().reset();
  }, [selection?.kind, selection && 'id' in selection ? selection.id : null]);

  // The Plan tab disappears with its buffer; sitting on -1 afterwards would
  // show the empty-editor hint under a tab bar with nothing selected.
  useEffect(() => {
    if (active === -1 && !bufferPlan) setActive(0);
  }, [active, bufferPlan, setActive]);

  // Bring the Plan tab forward once it exists — never before.
  useEffect(() => {
    if (focusPlan && bufferPlan) {
      setActive(-1);
      setFocusPlan(0);
    }
  }, [focusPlan, bufferPlan, setActive]);

  // Introspect in the background as soon as a connection is selected, so
  // completion is live by the time you finish typing `select `.
  useEffect(() => {
    if (!conn) return;
    const id = conn.id;
    // Sequenced, not fired in parallel: both want the connection open, and
    // opening is now idempotent, but doing the catalog first means the
    // schema list never delays completion.
    void (async () => {
      await loadSchema(id);
      await loadSchemaList(id);
    })();
  }, [conn?.id, loadSchema, loadSchemaList]);

  if (!conn) {
    // A set gets the editor too. Selecting one used to swap the editor out
    // for a list of its members, which answered "what is in this set" and
    // left the reason it exists — running one statement across all of it —
    // with no way in at all.
    if (envSet) return <FanoutPane key={envSet.id} envSet={envSet} />;
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted px-8 text-center">
        Pick a connection to start querying, or group a few into an environment set.
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {tablesOpen && (
        <div className="shrink-0 min-h-0 w-[320px]">
          <TableBrowser
            conn={conn}
            onInsert={(text) =>
              setInject((p) => ({
                text: ensureTerminated(text),
                nonce: p.nonce + 1,
                mode: 'append',
              }))
            }
            onClose={() => setTablesOpen(false)}
          />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <div className="flex items-center gap-2.5 px-3.5 h-10 border-b border-card shrink-0">
        <span className="text-xs font-medium text-ink">{conn.name}</span>
        <span className="text-[10px] text-ink-faint">{conn.engine}</span>
        {schemaList && schemaList.length > 0 && (
          <select
            value={activeSchema ?? ''}
            onChange={(e) => void switchSchema(conn.id, e.target.value)}
            title={conn.engine === 'mysql' ? 'Active database' : 'Active schema'}
            className="field px-1.5 py-0.5 text-[11px] max-w-[180px]"
          >
            {activeSchema && !schemaList.includes(activeSchema) && (
              <option value={activeSchema}>{activeSchema}</option>
            )}
            {schemaList.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        )}
        {conn.env === 'prod' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-warn/10 text-warn/90 border border-warn/25">
            prod
          </span>
        )}
        <WriteControls conn={conn} />
        {schemaError ? (
          <button
            onClick={() => void loadSchema(conn.id, { force: true })}
            title={`Completion is off because the catalog could not be read: ${schemaError}`}
            className="text-[10px] px-1.5 py-0.5 rounded bg-warn/10 text-warn/90 border border-warn/25"
          >
            no schema — retry
          </button>
        ) : schemaLoading ? (
          <span className="text-[10px] text-ink-faint">reading schema…</span>
        ) : schema ? (
          // The table count is the natural door to "which of these does the
          // AI actually see", so it is the button rather than a label.
          <button
            onClick={() => setSheet({ kind: 'pickTables', connectionId: conn.id })}
            title="Choose which tables the AI always sees"
            className="text-[10px] text-ink-faint hover:text-ink"
          >
            {schema.schemas.reduce((n, sc) => n + sc.tables.length, 0)} tables
            {/* A count that silently excludes most of the account is worse
                than no count, so the filter is stated wherever it applies. */}
            {conn.tableFilter && (
              <span title={`Showing only ${conn.tableFilter}`}> · filtered</span>
            )}
            {pinnedCount > 0 && <span className="text-accent"> · {pinnedCount} pinned</span>}
          </button>
        ) : null}
        <div className="flex-1" />
        <button
          onClick={() => setTablesOpen((v) => !v)}
          title="Browse tables and build a query from their keys"
          className={`text-xs px-2.5 py-1 rounded border ${
            tablesOpen ? 'border-accent text-accent' : 'border-card text-ink-muted hover:text-ink'
          }`}
        >
          Tables
        </button>
        <button
          onClick={formatBuffer}
          disabled={!sql.trim()}
          title="Reformat every statement (⇧⌥F)"
          className="text-xs px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-40"
        >
          Format
        </button>
        <button
          // The plan, and nothing else: no model, no execution. It was
          // reachable only from the results footer, which meant the only
          // way to see what a query was about to do was to do it first.
          onClick={() => void showPlan(targetSql())}
          disabled={!sql.trim()}
          title="Show the plan for this statement — it is not executed (⌥↵)"
          className="text-xs px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-40"
        >
          Plan
        </button>
        <button
          onClick={() => void explain()}
          // EXPLAIN goes to the server like anything else — including the
          // reconnect, which main does for it.
          disabled={!sql.trim() || running}
          title="Plan it AND ask the model to interpret it — Plan alone uses no AI"
          className="text-xs px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-40"
        >
          Explain
        </button>
        <button
          onClick={() => setAskOpen((v) => !v)}
          title="Ask about this database (⌘I)"
          className={`text-xs px-2.5 py-1 rounded border ${
            askOpen ? 'border-accent text-accent' : 'border-card text-ink-muted hover:text-ink'
          }`}
        >
          Ask
        </button>
        {!connected && !running && (
          // Connect stays reachable — it also loads the catalog, which Run
          // does not — but it no longer stands IN the Run slot. Running
          // while disconnected reconnects on the way, so a hollow dot is
          // not a reason to make you press two buttons.
          <button
            onClick={() => void connect()}
            disabled={connecting}
            className="text-xs px-2.5 py-1 rounded border border-warn/50 text-warn-strong hover:bg-warn/10 disabled:opacity-40"
            title={
              live === 'error'
                ? 'The last attempt to connect failed — try again'
                : 'Not connected — Run reconnects on its own; this also reloads the schema'
            }
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {running ? (
          <button
            onClick={() => void cancel()}
            // Red because it stops something already happening. It sits in
            // the slot Run occupied a moment ago, so it has to read as a
            // different kind of action rather than as Run in a new coat.
            className="text-xs px-2.5 py-1 rounded bg-bad/15 text-bad-strong border border-bad/40 hover:bg-bad/25"
            title="Cancel — aborts on the server, not just here (Esc)"
          >
            Cancel <span className="text-bad-strong/60">Esc</span>
          </button>
        ) : (
          <>
            <button
              onClick={doRun}
              disabled={translating}
              className="text-xs px-3 py-1 rounded bg-accent/90 text-white hover:bg-accent disabled:opacity-40"
              title={
                willTranslate
                  ? `That looks like a question — turn it into ${lang} (⌘↵)`
                  : isQuestion
                    ? 'That looks like a question, but no AI CLI was found to translate it'
                    : cursor.to > cursor.from
                      ? `Run the selected ${lang} (⌘↵)`
                      : 'Run the statement at the cursor (⌘↵)'
              }
            >
              {translating
                ? 'Translating…'
                : willTranslate
                  ? `Turn into ${lang}`
                  : isQuestion
                    ? 'Needs AI'
                    : 'Run'}
            </button>
            {statementCount > 1 && (
              <button
                onClick={doRunAll}
                className="text-xs px-2 py-1 rounded border border-card text-ink-muted hover:text-ink"
                title="Run every statement in the editor (⇧⌘↵)"
              >
                All {statementCount}
              </button>
            )}
          </>
        )}
      </div>

      {dynamoAccess && dynamoAccess.path !== 'unknown' && (
        <div
          className={`shrink-0 px-3.5 py-1.5 border-b text-[11px] leading-snug ${
            dynamoAccess.path === 'scan'
              ? 'bg-warn/10 border-warn/25 text-warn-strong/90'
              : 'bg-good/10 border-good/25 text-good-strong/90'
          }`}
        >
          <span className="font-medium">{accessSummary(dynamoAccess)}</span>
          {dynamoAccess.warnings.map((w) => (
            <span key={w.text} className="ml-2 opacity-90">
              {w.text}
            </span>
          ))}
          {dynamo?.notes.map((n) => (
            <span key={n} className="ml-2 opacity-90">
              {n}
            </span>
          ))}
          {dynamoAccess.suggestion && (
            <button
              onClick={() => {
                // Rewrites FROM "table" to FROM "table"."index" in place,
                // which is the entire fix — the conditions are already right.
                const range = targetRange();
                const text = sql.slice(range.from, range.to).replace(
                  /\bfrom\s+"([^"]+)"/i,
                  (_m, t) => `FROM "${t}"."${dynamoAccess.suggestion!.index}"`,
                );
                setInject((p) => ({ text, nonce: p.nonce + 1, mode: 'replace', range }));
                toast(`Now querying ${dynamoAccess.suggestion!.index}.`);
              }}
              className="ml-2 underline underline-offset-2 hover:text-ink"
            >
              Use {dynamoAccess.suggestion.index}
            </button>
          )}
        </div>
      )}

      {(running || translating) && (
        <div className="h-0.5 bg-card overflow-hidden shrink-0">
          {/* Coloured by what the statement can DO, not by the fact that
              something is happening: a SELECT that runs for a minute is not
              alarming, and a DELETE that runs for a second is. */}
          <div className={`h-full w-1/4 animate-progress-slide ${RUNNING_BAR[runningSeverity]}`} />
        </div>
      )}

      {/* Above the editor rather than beside the results, because these are
          things you WRITE in — putting them next to the answers would read
          as another way of looking at one. */}
      <div className="flex items-stretch shrink-0 border-b border-card bg-surface-muted overflow-x-auto">
        {bufferKeys.map((key) => (
          <div
            key={key}
            className={`group flex items-center gap-1 pl-3 pr-1.5 py-1 text-[11px] whitespace-nowrap border-b-2 ${
              key === bufferKey
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-faint hover:text-ink-muted'
            }`}
          >
            <button
              onClick={() => conn && selectBuffer(conn.id, key)}
              title={buffers[key] || 'Empty tab'}
              className="flex items-baseline gap-1.5"
            >
              {bufferLabel(buffers[key] ?? '')}
              {/* Only when it differs from where the session actually is.
                  Switching to this tab MOVES the session — that is a thing
                  to be told before you click, not after. */}
              {bufferSchema[key] && bufferSchema[key] !== activeSchema && (
                <span className="text-[10px] text-warn/70" title={`Opening this tab switches to ${bufferSchema[key]}`}>
                  {bufferSchema[key]}
                </span>
              )}
            </button>
            {/* Only on the tab you are on, and only on hover: a row of close
                buttons invites the one misclick that loses a query. */}
            <button
              onClick={() => {
                if (!conn) return;
                const text = (buffers[key] ?? '').trim();
                if (!text) {
                  closeBuffer(conn.id, key);
                  return;
                }
                askConfirm({
                  title: `Close ${bufferLabel(text)}?`,
                  body: 'The query in this tab is discarded. Nothing that already ran is affected.',
                  confirmLabel: 'Close tab',
                  destructive: true,
                  onConfirm: () => closeBuffer(conn.id, key),
                });
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-ink-faint hover:text-ink px-1 rounded"
              title={bufferKeys.length > 1 ? 'Close this tab' : 'Clear this tab'}
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => conn && newBuffer(conn.id)}
          className="px-2.5 text-[11px] text-ink-faint hover:text-ink border-b-2 border-transparent"
          title="New tab on this connection (⌘T)"
        >
          +
        </button>
      </div>

      <div style={{ height: editorHeight }} className="min-h-[96px] shrink-0 relative">
        <SqlEditor
          key={bufferKey}
          value={sql}
          schema={schema}
          activeSchema={activeSchema}
          inject={inject}
          onChange={setSql}
          onCursor={(from, to) => setCursor({ from, to })}
          // Prose is tinted in the accent colour because the accent means
          // "a model is about to touch this". With no CLI installed that
          // promise is false, so the same text is marked as merely
          // unrunnable instead.
          aiAvailable={!noAi}
          onRefine={(statement, instruction) => void refineStatement(statement, instruction)}
          refining={refining}
          translating={translating}
          onRun={doRun}
          // The values live in the holes themselves. A chip carries what
          // THIS connection resolves, so the buffer reads as the queries
          // that are actually about to run — and an unfilled hole is
          // visible in every statement at once rather than only in the one
          // the cursor is in.
          params={{
            engine: conn.engine,
            bindings: paramBindings,
            target: { connectionId: conn.id, env: conn.env },
          }}
          onParamOpen={(hole, at) => {
            // The statement it belongs to knows how many places it fills;
            // the chip only knows about itself.
            const statement = statementAt(splitStatements(sql, conn.engine), hole.from);
            const inStatement = statement
              ? paramSlots(statement.sql, conn.engine).find((s) => s.key === hole.key)
              : undefined;
            setOpenParam({
              slot: inStatement ?? {
                key: hole.key, label: hole.label, style: hole.style, count: 1, inList: false,
              },
              at,
            });
          }}
          onPlan={() => void showPlan(targetSql())}
          // Fanning out acts on ONE statement, so it is offered on the
          // statement — never on the toolbar, which sits above the whole
          // buffer and reads as applying to all of it.
          runSetLabel={
            sets.all.length === 0
              ? undefined
              : sets.all.length === 1
                ? `Run on ${sets.all[0].name}`
                : 'Run on set'
          }
          // The same three actions the header offers, said on the statement
          // they act on. The header's version reads as applying to the
          // whole buffer; this one cannot be misread.
          onStatementAction={(action, stmt) => {
            if (action === 'plan') return void showPlan(stmt.sql);
            if (action === 'explain') return void explain('', stmt.sql);
            if (action === 'run-set') {
              if (sets.all.length === 1) return runOnSet(sets.all[0], stmt.sql);
              return setPickSetFor(stmt.sql);
            }
            setInject((p) => ({
              text: formatSql(stmt.sql, formatStyle),
              nonce: p.nonce + 1,
              mode: 'replace',
              range: { from: stmt.from, to: stmt.to },
            }));
          }}
          onRunAll={doRunAll}
          onFormat={formatBuffer}
        />

        {pickSetFor !== null && (
          <SetPicker
            sets={sets}
            connectionName={conn.name}
            onPick={(envSet) => runOnSet(envSet, pickSetFor)}
            onDismiss={() => setPickSetFor(null)}
          />
        )}
      </div>

      {openParam && (
        <ParamPopover
          slot={openParam.slot}
          at={openParam.at}
          target={{ connectionId: conn.id, env: conn.env }}
          onClose={() => setOpenParam(null)}
        />
      )}

      <Resizer
        axis="y"
        label="Editor height"
        value={editorHeight}
        min={96}
        // Always leave room for the result grid's header plus a row or two;
        // dragging the editor to fill the pane would hide the answer.
        max={() => Math.max(160, window.innerHeight - 220)}
        fallback={280}
        onChange={(h) => saveSettings({ editorHeight: h })}
      />

      {/* Always present, not only for a batch. Without it the results half
          of the window is an unframed expanse of background with a sentence
          floating in it, and there is nothing to tell you it is a region at
          all — let alone which of several answers you are looking at. */}
      <div className="flex items-stretch gap-px shrink-0 border-y border-card bg-surface-muted overflow-x-auto">
          {tabs.map((t, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              title={t.sql}
              className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 ${
                i === active
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-faint hover:text-ink-muted'
              }`}
            >
              <span className="tabular-nums opacity-60 mr-1.5">{i + 1}</span>
              {label(t)}
              <TabStatus tab={t} />
            </button>
          ))}
          {bufferPlan && (
            <button
              onClick={() => setActive(-1)}
              className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 ${
                active === -1 ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-muted'
              }`}
            >
              Plan
              {bufferPlan.rows.some((r) => r.warn) && (
                <span className="ml-1.5 text-warn/90">•</span>
              )}
            </button>
          )}
          <div className="flex-1" />
      </div>

      <div className="flex-1 min-h-0 bg-surface">
        {translating ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-center px-8">
            <p className="text-xs text-ink">Turning your question into {lang}…</p>
            <p className="text-[11px] text-ink-faint">
              It will land in the editor for you to read. Nothing runs on its own.
            </p>
          </div>
        ) : active === HISTORY_TAB ? (
          <HistoryPane
            connection={conn}
            onOpen={(text) => appendSuggestion(text, 'From history')}
          />
        ) : active === HEALTH_TAB ? (
          <HealthPane
            connection={conn}
            onOpenSql={(text) => appendSuggestion(text, 'From a session')}
          />
        ) : active === ERD_TAB ? (
          <ErdView
            snapshot={schema}
            connectionName={conn.name}
            onPickTable={(sc, table) =>
              // Double-clicking a table in the diagram is "show me this" —
              // a statement to read, not to run. It lands in the editor
              // like everything else does.
              setInject((p) => ({
                text: ensureTerminated(
                  formatSql(`select * from ${sc}.${table} limit 100`, formatStyle),
                ),
                nonce: p.nonce + 1,
              }))
            }
          />
        ) : active === SLOW_TAB ? (
          <SlowQueryPane
            connectionId={conn.id}
            connectionName={conn.name}
            onOpen={(text) => appendSuggestion(text, 'From slow queries')}
            onPlan={(text) => void showPlan(text)}
            // Straight into the tuner that already exists. Finding the
            // expensive statement and improving it are the same errand, and
            // making the user retype it in between is where that errand
            // usually stops.
            onFaster={(text) => {
              setAskOpen(true);
              setAskRequest((p) => ({
                mode: 'faster',
                question: '',
                nonce: (p?.nonce ?? 0) + 1,
                sql: text,
              }));
            }}
          />
        ) : active === LOG_TAB ? (
          <LogView
            // Only this connection's lines can be acted on: the log spans
            // every connection, and replaying `delete from account` against
            // whichever one happens to be selected is not a thing to make
            // one click away.
            connectionId={conn.id}
            // Appended under a comment, never dropped at the cursor: a
            // statement pulled back out of the log is a whole statement,
            // and landing it mid-line welds it into whatever you were
            // reading.
            onOpen={(text) => appendSuggestion(text, 'From the log')}
            onPlan={(text) => void showPlan(text)}
            onReplay={(text) => {
              // Read it again and you get the same rows. Run a write again
              // and you get a second one — so that one is asked about.
              if (severity(text) === 'read') {
                void run(conn.id, text, conn.engine);
                return;
              }
              askConfirm({
                title: 'Run this again?',
                body:
                  `${text.replace(/\s+/g, ' ').trim()}\n\n` +
                  'This statement changes data, and running it a second time is a second ' +
                  'change — not a repeat of the first.' +
                  (conn.env === 'prod' ? ' This connection is production.' : ''),
                confirmLabel: 'Run again',
                destructive: conn.env === 'prod' || severity(text) === 'destructive',
                onConfirm: () => void run(conn.id, text, conn.engine),
              });
            }}
          />
        ) : translateNote ? (
          <div className="h-full overflow-y-auto p-4">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-[11px] text-ink-muted">
                {translateNote === NO_AI_NOTE
                  ? 'That reads as a question rather than a statement:'
                  : `No ${lang} came back for that question — here is what it said:`}
              </p>
              <button
                onClick={() => setTranslateNote(null)}
                className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-faint hover:text-ink hover:bg-card"
              >
                Dismiss
              </button>
            </div>
            <Markdown
              text={translateNote}
              onInsertSql={(text) =>
                setInject((p) => ({
                  text: ensureTerminated(formatSql(text, formatStyle)),
                  nonce: p.nonce + 1,
                }))
              }
            />
            {activeSchema && (
              <p className="mt-3 text-[10px] text-ink-faint">
                The question was answered against{' '}
                <code className="font-mono text-ink-muted">{activeSchema}</code>, plus any schema
                your editor names explicitly. Switch schema above if that was the wrong one.
              </p>
            )}
          </div>
        ) : active === -1 && bufferPlan ? (
          <PlanView
            rows={bufferPlan.rows}
            raw={bufferPlan.raw}
            // The plan alone cannot say what was wasted: that needs what the
            // statement actually returned, which only the result knows.
            result={
              current?.status === 'done'
                ? { rowCount: current.rowCount, durationMs: current.durationMs }
                : null
            }
            sql={bufferPlan.sql}
            compare={bufferPlan.compare}
            onDropCompare={() => setPlan((p) => (p ? { ...p, compare: undefined } : p))}
            onTune={tune}
            tuning={askBusy}
          />
        ) : !current ? (
          <div className="h-full flex items-center justify-center text-xs text-ink-faint">
            ⌘↵ runs the statement at your cursor. ⇧⌘↵ runs all of them.
            <br />
            Or just ask in plain English — ⌘↵ turns it into {lang} for you to check.
          </div>
        ) : current.status === 'error' ? (
          <QueryError
            conn={conn}
            error={current.error ?? ''}
            failingSql={current.sql}
            schema={schema}
            onApply={(next) => setInject((p) => ({ text: next, nonce: p.nonce + 1, mode: 'replace' }))}
            onInsert={(text) => setInject((p) => ({ text: ensureTerminated(formatSql(text, formatStyle)), nonce: p.nonce + 1 }))}
          />
        ) : current.columns.length === 0 && current.status === 'done' ? (
          <WriteOutcome tab={current} />
        ) : resultView === 'chart' ? (
          <ChartView columns={current.columns} rows={current.rows} truncated={current.truncated} />
        ) : (
          <ResultGrid
            columns={current.columns}
            rows={current.rows}
            sort={current.sort}
            sortable={current.kind === 'read' && !running}
            onSort={(column) => void sortBy(active, column, conn.engine)}
            filters={current.filters}
            onFilter={(filter, column) => void filterBy(active, filter, column, conn.engine)}
            canEdit={canEdit}
            onEditCell={editCell}
          />
        )}
      </div>

      {/* Everything about this result — how many rows, how long, what is
          filtering it, and whether you are looking at the grid or a picture
          of it — goes out to the one rail that ends the window. The panes on
          its right are the ones that used to sit in the tab strip dressed as
          tabs: they are the server and the session, not this answer. */}
      <RailSlot>
        <div className="flex items-center gap-3 min-w-0">
        {!current && <span>Ready.</span>}
        {current?.status === 'running' && (
          <span>Running… {current.rows.length.toLocaleString()} rows so far</span>
        )}
        {current?.status === 'pending' && <span>Queued.</span>}
        {current?.status === 'cancelled' && (
          <span className="text-warn/90">
            {/* Rows in the grid after a cancel are not the answer — they are
                however much of it arrived first, and saying which is the
                difference between a partial result and a wrong one. */}
            {current.rows.length > 0
              ? `Cancelled — these are the ${current.rows.length.toLocaleString()} rows that arrived before it stopped, not the whole result.`
              : 'Cancelled — the server stopped executing it.'}
          </span>
        )}
        {current?.status === 'done' && (
          <>
            {/* A write always returns zero rows, so reporting rowCount for
                one says nothing. What it changed is the whole result. */}
            {current.affectedRows !== null ? (
              <span className={current.affectedRows > 0 ? 'text-good/90' : undefined}>
                {current.affectedRows.toLocaleString()} row
                {current.affectedRows === 1 ? '' : 's'} {affectedVerb(current.sql)}
              </span>
            ) : (
              <span>
                {current.rowCount.toLocaleString()} row{current.rowCount === 1 ? '' : 's'}
              </span>
            )}
            {current.durationMs !== null && <span>{current.durationMs} ms</span>}
            {/* The plan belongs where you are already looking after a run.
                Explain in the header does this too, and also asks the model;
                this one is just the picture, and costs nothing. */}
            {current.kind === 'read' && !running && (
              <button
                onClick={() => void showPlan()}
                title="Run EXPLAIN on this statement and draw its plan — nothing is executed"
                className="text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
              >
                plan
              </button>
            )}
            {current.durationMs !== null &&
              slowQueryMs > 0 &&
              current.durationMs >= slowQueryMs &&
              current.kind === 'read' && (
                <button
                  onClick={() => void explain('Why is this slow, and what would make it faster?')}
                  className="text-warn/90 hover:text-warn-strong underline underline-offset-2"
                >
                  see why
                </button>
              )}
            {current.truncated && (
              <span className="text-warn/90">
                stopped at the row limit — raise it in Settings
              </span>
            )}
            {/* Filters live here rather than over the grid because they are
                part of the question that was asked, not a view of the
                answer — the row count next to them counts filtered rows. */}
            {current.filters.map((f) => (
              <button
                key={f.column}
                onClick={() => void filterBy(active, null, f.column, conn.engine)}
                title="Remove this filter and re-run"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
              >
                <span className="font-mono">
                  {f.column} {f.op} {f.value ?? ''}
                </span>
                <span className="text-[10px]">✕</span>
              </button>
            ))}
            {/* A local sort orders what came back, not the table. On a
                truncated result those are different answers, and the
                difference is invisible in the grid. */}
            {current.sort?.local && (
              <span className={current.truncated ? 'text-warn/90' : 'text-ink-faint'}>
                sorted here, within the {current.rowCount.toLocaleString()} rows fetched —
                DynamoDB cannot sort a scan
              </span>
            )}
          </>
        )}
          {tabs.length > 1 && (
            <span className="whitespace-nowrap">
              statement {active + 1} of {tabs.length}
            </span>
          )}
          {/* Table and chart are two views of ONE result, so the switch sits
              with the count of the rows it is drawing — a tab would imply a
              second answer, and would also put the table a click away at
              exactly the moment you want to check a point against it. Only
              shown when there is a grid to switch: a write's outcome has no
              picture. */}
          {gridShowing && (
            <div className="flex items-center gap-px shrink-0">
              {(['table', 'chart'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setResultView(mode)}
                  title={
                    mode === 'table'
                      ? 'The rows themselves'
                      : 'Draw these rows — the axis and series are picked from the column types, and adjustable'
                  }
                  className={`px-2 py-0.5 rounded capitalize ${
                    resultView === mode
                      ? 'bg-accent/20 text-ink'
                      : 'text-ink-faint hover:text-ink-muted hover:bg-card'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Right of the rail, in scope order: the server first (what it is
            doing, how it is shaped, where its time goes), then you (what you
            have run, ever, and what this session has run). */}
        <div className="flex items-center gap-px shrink-0">
          <RailPane
            on={active === HEALTH_TAB}
            onClick={() => setActive(HEALTH_TAB)}
            title="Sessions, connection headroom, cache and sizes — what this server is doing right now"
          >
            Health
          </RailPane>
          <RailPane
            on={active === ERD_TAB}
            onClick={() => setActive(ERD_TAB)}
            title="The foreign-key graph, drawn from the constraints this server holds"
          >
            Diagram
          </RailPane>
          <RailPane
            on={active === SLOW_TAB}
            onClick={() => setActive(SLOW_TAB)}
            title="What this server spends its time on, across every client — not just this session"
          >
            Slow queries
          </RailPane>
          <RailPane
            on={active === HISTORY_TAB}
            onClick={() => setActive(HISTORY_TAB)}
            title="Every statement you have run, across restarts — plus the ones you named and kept"
          >
            History
          </RailPane>
          <RailPane
            on={active === LOG_TAB}
            onClick={() => setActive(LOG_TAB)}
            title="Every statement this session, with what it returned"
          >
            Log
            {logCount > 0 && <span className="ml-1 tabular-nums opacity-60">{logCount}</span>}
            {running && (
              <span className="ml-1 w-1.5 h-1.5 rounded-full bg-good animate-pulse" />
            )}
          </RailPane>
        </div>
      </RailSlot>
      </div>

      {askOpen && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = askWidth;
            const move = (ev: MouseEvent) =>
              setAskWidth(Math.min(900, Math.max(280, startW + (startX - ev.clientX))));
            const up = () => {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
          className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      {askOpen && (
        <div className="shrink-0 min-h-0" style={{ width: askWidth }}>
          <AskPane
            conn={conn}
            editorText={sql}
            request={askRequest}
            onInsertSql={(text, note) => appendSuggestion(text, note)}
            onNewTabSql={(text, note) => openSuggestion(text, note)}
            onExplainSql={(text) => void planAlternative(text)}
            onBusyChange={setAskBusy}
            onClose={() => setAskOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

/// Whether a statement in the batch worked, on the tab itself.
///
/// Running eight statements produced eight tabs that all looked alike, so
/// "did they all go through?" cost eight clicks — and the one that failed
/// looked exactly like the seven that did not. The mark answers it from the
/// strip. A write that matched nothing is deliberately NOT green: it ran,
/// but it changed nothing, and those are different answers.
function TabStatus({ tab }: { tab: ResultTab }): JSX.Element | null {
  if (tab.status === 'pending') {
    return <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-ink-faint/40 align-middle" aria-hidden />;
  }
  if (tab.status === 'running') {
    return <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-ink-faint animate-pulse align-middle" aria-hidden />;
  }
  if (tab.status === 'error') return <span className="ml-1.5 text-bad">✗</span>;
  if (tab.status === 'cancelled') return <span className="ml-1.5 text-warn">⦸</span>;
  const changedNothing = tab.kind !== 'read' && tab.affectedRows === 0;
  return <span className={`ml-1.5 ${changedNothing ? 'text-ink-faint' : 'text-good/90'}`}>✓</span>;
}

/// A tab needs a name you can scan. The leading keyword plus the first
/// table mentioned is almost always enough to tell three statements apart.
function label(tab: ResultTab): string {
  const flat = tab.sql.replace(/\s+/g, ' ').trim();
  const m = /^(\w+)(?:.*?\b(?:from|into|update|table)\s+([`"\w.]+))?/i.exec(flat);
  if (!m) return flat.slice(0, 24);
  const verb = m[1].toLowerCase();
  const target = m[2]?.replace(/[`"]/g, '');
  return target ? `${verb} ${target}` : verb;
}

/// What a finished statement that returned no grid actually did.
///
/// "Statement completed. It returned no result set." is true of a DELETE
/// that removed 400 rows and of one that matched nothing, which is exactly
/// the ambiguity behind "the flyway query will not delete" — it had run
/// fine, it just had nothing to match. So the count is the headline, and
/// zero says so in its own words rather than looking like success.
function WriteOutcome({ tab }: { tab: ResultTab }): JSX.Element {
  if (tab.kind === 'read') {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">No rows.</div>
    );
  }

  const n = tab.affectedRows;
  const changed = n !== null && n > 0;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-8">
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${
          changed
            ? 'bg-good/15 text-good border border-good/40'
            : 'bg-card text-ink-faint border border-card'
        }`}
        aria-hidden
      >
        ✓
      </div>
      {n === null ? (
        <p className="text-xs text-ink">Statement completed.</p>
      ) : (
        <p className={`text-xs ${changed ? 'text-good-strong' : 'text-ink'}`}>
          {n.toLocaleString()} row{n === 1 ? '' : 's'} {affectedVerb(tab.sql)}
        </p>
      )}
      <p className="text-[11px] text-ink-faint">
        {n === 0
          ? 'The statement ran and nothing matched — the rows it describes are not there.'
          : 'No result set to show.'}
      </p>
    </div>
  );
}

/// The environment sets this statement could be fanned out to.
///
/// Sets containing this connection come first, because "this database, and
/// its siblings elsewhere" is what the action means nine times in ten. The
/// others are still offered, marked, since a statement written here is
/// often exactly what you want to ask somewhere else.
function eligibleSets(envSets: EnvSet[], connectionId: string) {
  const live = envSets.filter((e) => !e.archived);
  const mine = live.filter((e) => e.memberIds.includes(connectionId));
  const rest = live.filter((e) => !e.memberIds.includes(connectionId));
  return { mine, rest, all: [...mine, ...rest] };
}

/// Which set to fan out to, when more than one could be meant.
///
/// The set is CHOSEN, never guessed. A connection can belong to several,
/// and running against the wrong group of servers is exactly the class of
/// accident the rest of this app is built to prevent — so a single eligible
/// set runs on one click, and more than one asks, with no default that
/// quietly picks for you.
///
/// Anchored in the pane rather than inside the statement strip: the strip
/// is driven by where the mouse is, and a menu that vanishes when you move
/// towards it is not a menu.
function SetPicker({
  sets,
  connectionName,
  onPick,
  onDismiss,
}: {
  sets: ReturnType<typeof eligibleSets>;
  connectionName: string;
  onPick(envSet: EnvSet): void;
  onDismiss(): void;
}): JSX.Element {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onDismiss} />
      <div className="absolute right-3.5 top-3.5 z-30 min-w-[230px] rounded-md border border-card bg-surface-elevated shadow-lg shadow-black/30 py-1">
        <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
          Run this statement on
        </p>
        {sets.mine.map((e) => (
          <SetChoice key={e.id} envSet={e} onPick={() => onPick(e)} />
        ))}
        {sets.rest.length > 0 && (
          <>
            {sets.mine.length > 0 && <div className="my-1 h-px bg-card" />}
            <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
              {connectionName} is not in these
            </p>
            {sets.rest.map((e) => (
              <SetChoice key={e.id} envSet={e} onPick={() => onPick(e)} />
            ))}
          </>
        )}
        <p className="px-3 pt-1.5 pb-0.5 text-[10px] text-ink-faint leading-snug max-w-[270px]">
          Every member gets the same statement, and the answers are compared against the set's
          baseline.
        </p>
      </div>
    </>
  );
}

function SetChoice({ envSet, onPick }: { envSet: EnvSet; onPick(): void }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const members = envSet.memberIds.filter((id) => connections.some((c) => c.id === id));
  // Naming the baseline here, before anything runs: everything a fan-out
  // reports is measured against it, so which member it is changes what the
  // answer means.
  const baseline = connections.find((c) => c.id === envSet.baselineId);
  return (
    <button
      onClick={onPick}
      className="w-full text-left px-3 py-1 hover:bg-card flex items-baseline gap-2"
    >
      <span className="text-[11px] text-ink">{envSet.name}</span>
      <span className="text-[10px] text-ink-faint">
        {members.length} member{members.length === 1 ? '' : 's'}
        {baseline && ` · against ${baseline.name}`}
      </span>
    </button>
  );
}

/// One of the rail's right-hand panes.
///
/// Deliberately not the tab shape used above the grid: those name an answer
/// to something you ran, these name a place to go. A pill that fills when it
/// is open says "somewhere else" where an underline said "another result".
function RailPane({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick(): void;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 rounded whitespace-nowrap flex items-center ${
        on ? 'bg-accent/20 text-ink' : 'text-ink-faint hover:text-ink-muted hover:bg-card'
      }`}
    >
      {children}
    </button>
  );
}
