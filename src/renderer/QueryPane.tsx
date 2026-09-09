import { useEffect, useMemo, useRef, useState } from 'react';
import { AskPane } from './AskPane';
import { QueryError } from './QueryError';
import { PlanView } from './PlanView';
import { parsePlan, type PlanRow } from '@shared/plan';
import { splitStatements, statementAt } from '@shared/sqlGuard';
import { looksLikeQuestion } from '@shared/looksLikeSql';
import { ensureTerminated, formatSql } from '@shared/formatSql';
import { ResultGrid } from './ResultGrid';
import { SqlEditor } from './SqlEditor';
import { useQuery, type ResultTab } from './queryStore';
import { useStore } from './store';

export function QueryPane(): JSX.Element {
  const selection = useStore((s) => s.selection);
  const connections = useStore((s) => s.connections);

  const [askOpen, setAskOpen] = useState(false);
  const [inject, setInject] = useState<{
    text: string;
    nonce: number;
    mode?: 'insert' | 'replace';
    range?: { from: number; to: number };
  }>({ text: '', nonce: 0 });
  const [askRequest, setAskRequest] = useState<{ mode: 'ask' | 'explain'; question: string; nonce: number; sql?: string }>();
  const [plan, setPlan] = useState<{ rows: PlanRow[]; raw: string } | null>(null);
  const [askWidth, setAskWidth] = useState(400);
  const [cursor, setCursor] = useState({ from: 0, to: 0 });
  const [translating, setTranslating] = useState(false);
  // A ref as well as state: `setTranslating` doesn't take effect until the
  // next render, so two quick ⌘↵ presses both passed the state check and
  // translated twice — the second one replacing a range the first had
  // already moved. The ref closes that window synchronously.
  const translatingRef = useRef(false);

  /// Explain and the slow-query nudge both do the same thing: open the panel
  /// and ask it about the statement in front of you. The panel is where the
  /// answer lands, not where the question has to begin.
  /// Explain does two things at once, deliberately: it shows you the plan
  /// your server actually produced, and it asks for an interpretation. The
  /// prose is worth more when you can see what it is talking about.
  const explain = async (question = '') => {
    // The statement you are looking at, not the whole buffer: EXPLAIN takes
    // exactly one, and a two-statement editor would just error.
    const statement = (tabs[active]?.sql ?? targetSql()).trim();
    if (!statement || !conn) return;
    setAskOpen(true);
    setAskRequest((p) => ({ mode: 'explain', question, nonce: (p?.nonce ?? 0) + 1, sql: statement }));
    try {
      const result = await window.overdb.invoke('query:explain', {
        connectionId: conn.id, sql: statement, analyze: false,
      });
      setPlan({ rows: parsePlan(conn.engine, result.format, result.plan), raw: result.plan });
    } catch (err) {
      setPlan({ rows: [], raw: err instanceof Error ? err.message : String(err) });
    }
  };

  const conn =
    selection?.kind === 'connection'
      ? connections.find((c) => c.id === selection.id) ?? null
      : null;

  // One buffer per connection, persisted. Carrying a query written for one
  // schema over to another is at best noise and at worst a query that means
  // something different against the tables it now lands on.
  const buffers = useStore((s) => s.buffers);
  const setBuffer = useStore((s) => s.setBuffer);
  const sql = (conn ? buffers[conn.id] : '') ?? '';
  const setSql = (text: string) => {
    if (conn) setBuffer(conn.id, text);
  };

  const schema = useStore((s) => (conn ? s.schemas[conn.id] : undefined));
  const schemaList = useStore((s) => (conn ? s.schemaList[conn.id] : undefined));
  const activeSchema = useStore((s) => (conn ? s.activeSchema[conn.id] : undefined));
  const toast = useStore((s) => s.toast);
  const slowQueryMs = useStore((s) => s.settings.slowQueryMs);
  /// Drives the Run button's label, so it is obvious BEFORE you press it
  /// that the next keystroke translates rather than executes.
  const willTranslate = useMemo(() => {
    const target =
      cursor.to > cursor.from
        ? sql.slice(cursor.from, cursor.to)
        : (statementAt(splitStatements(sql, conn?.engine ?? 'postgres'), cursor.from)?.sql ?? sql);
    return looksLikeQuestion(target);
  }, [sql, cursor, conn?.engine]);

  const statementCount = useMemo(
    () => splitStatements(sql, conn?.engine ?? 'postgres').length,
    [sql, conn?.engine],
  );
  const schemaError = useStore((s) => (conn ? s.schemaError[conn.id] : undefined));
  const schemaLoading = useStore((s) => (conn ? s.schemaLoading[conn.id] : false));
  const loadSchema = useStore((s) => s.loadSchema);
  const loadSchemaList = useStore((s) => s.loadSchemaList);
  const switchSchema = useStore((s) => s.switchSchema);
  const { tabs, active, running, run, cancel, setActive, sortBy } = useQuery();
  const current: ResultTab | undefined = tabs[active];

  /// What Run actually runs, in priority order: an explicit selection, then
  /// the statement the cursor is in. Executing the whole buffer because it
  /// happens to be open is how a scratch query above a real one gets run by
  /// accident — every other client works this way for that reason.
  const targetSql = (): string => {
    if (cursor.to > cursor.from) return sql.slice(cursor.from, cursor.to);
    const engine = conn?.engine ?? 'postgres';
    return statementAt(splitStatements(sql, engine), cursor.from)?.sql ?? sql;
  };

  /// The span Run is about to act on, so a translation can replace exactly
  /// that and leave the rest of the buffer alone.
  const targetRange = (): { from: number; to: number } => {
    if (cursor.to > cursor.from) return { from: cursor.from, to: cursor.to };
    const stmt = statementAt(splitStatements(sql, conn?.engine ?? 'postgres'), cursor.from);
    return stmt ? { from: stmt.start, to: stmt.end } : { from: 0, to: sql.length };
  };

  /// Typing a question where SQL goes is a reasonable thing to do, and
  /// making you retype it into a side panel is not. So ⌘↵ on plain English
  /// TRANSLATES rather than runs — and then stops, leaving the SQL in front
  /// of you. Running it is still your keystroke; nothing here executes what
  /// a model wrote.
  const translate = async (question: string) => {
    if (!conn || translatingRef.current) return;
    translatingRef.current = true;
    const detected = await window.overdb.invoke('ai:detect');
    const tool = (['claude', 'codex', 'gemini'] as const).find((t) => detected[t]);
    if (!tool) {
      toast('No AI CLI found — install claude, codex or gemini to translate questions.', 'error');
      translatingRef.current = false;
      return;
    }
    const range = targetRange();
    setTranslating(true);
    try {
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: conn.id, tool, mode: 'sql', question, editorText: sql,
      });
      if (!result.ok || !result.sql) {
        toast(result.error ?? 'Could not turn that into SQL.', 'error');
        return;
      }
      // The question is kept as a comment above the query: it documents the
      // intent, and it is what you edit if the translation missed.
      // Formatted here rather than requested in the prompt: a model asked
      // for a layout complies most of the time, and "most of the time" is
      // what makes generated code tiring to read.
      const replacement =
        `-- ${question.replace(/\s+/g, ' ').trim()}\n` +
        `${ensureTerminated(formatSql(result.sql))}\n`;
      setInject((p) => ({ text: replacement, nonce: p.nonce + 1, mode: 'replace', range }));
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
      .map((s) => (looksLikeQuestion(s.sql) ? s.sql : ensureTerminated(formatSql(s.sql))))
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

  const doRun = () => {
    if (!conn) return;
    const target = targetSql();
    if (looksLikeQuestion(target)) {
      void translate(target);
      return;
    }
    void run(conn.id, target, conn.engine);
  };

  const doRunAll = () => {
    if (conn) void run(conn.id, sql, conn.engine);
  };

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
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted px-8 text-center">
        Environment sets run one query across several connections. That fan-out
        isn&#39;t built yet — pick a single connection for now.
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
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
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/90 border border-amber-500/25">
            prod · read-only
          </span>
        )}
        {schemaError ? (
          <button
            onClick={() => void loadSchema(conn.id, { force: true })}
            title={`Completion is off because the catalog could not be read: ${schemaError}`}
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/90 border border-amber-500/25"
          >
            no schema — retry
          </button>
        ) : schemaLoading ? (
          <span className="text-[10px] text-ink-faint">reading schema…</span>
        ) : schema ? (
          <span className="text-[10px] text-ink-faint">
            {schema.schemas.reduce((n, sc) => n + sc.tables.length, 0)} tables
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          onClick={formatBuffer}
          disabled={!sql.trim()}
          title="Reformat every statement (⇧⌥F)"
          className="text-xs px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink disabled:opacity-40"
        >
          Format
        </button>
        <button
          onClick={() => void explain()}
          disabled={!sql.trim() || running}
          title="Run EXPLAIN on this query and interpret the plan"
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
        {running ? (
          <button
            onClick={() => void cancel()}
            className="text-xs px-2.5 py-1 rounded border border-card text-ink hover:bg-card"
            title="Cancel — aborts on the server, not just here (Esc)"
          >
            Cancel <span className="text-ink-faint">Esc</span>
          </button>
        ) : (
          <>
            <button
              onClick={doRun}
              disabled={translating}
              className="text-xs px-3 py-1 rounded bg-accent/90 text-white hover:bg-accent disabled:opacity-40"
              title={
                willTranslate
                  ? 'That looks like a question — turn it into SQL (⌘↵)'
                  : cursor.to > cursor.from
                    ? 'Run the selected SQL (⌘↵)'
                    : 'Run the statement at the cursor (⌘↵)'
              }
            >
              {translating ? 'Translating…' : willTranslate ? 'Turn into SQL' : 'Run'}
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

      {(running || translating) && (
        <div className="h-0.5 bg-card overflow-hidden shrink-0">
          <div className="h-full w-1/4 bg-accent animate-progress-slide" />
        </div>
      )}

      <div className="h-[34%] min-h-[96px] border-b border-card shrink-0">
        <SqlEditor
            key={conn.id}
            value={sql}
            schema={schema}
            activeSchema={activeSchema}
            inject={inject}
            onChange={setSql}
            onCursor={(from, to) => setCursor({ from, to })}
            onRun={doRun}
            onRunAll={doRunAll}
            onFormat={formatBuffer}
          />
      </div>

      {/* One tab per statement. Only shown for an actual batch — a single
          statement doesn't need a tab bar telling it it's alone. */}
      {(tabs.length > 1 || plan) && (
        <div className="flex items-stretch gap-px shrink-0 border-b border-card bg-surface-muted overflow-x-auto">
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
            </button>
          ))}
          {plan && (
            <button
              onClick={() => setActive(-1)}
              className={`px-3 py-1.5 text-[11px] whitespace-nowrap border-b-2 ${
                active === -1 ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-muted'
              }`}
            >
              Plan
              {plan.rows.some((r) => r.warn) && <span className="ml-1.5 text-amber-400/90">•</span>}
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0">
        {translating ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-center px-8">
            <p className="text-xs text-ink">Turning your question into SQL…</p>
            <p className="text-[11px] text-ink-faint">
              It will land in the editor for you to read. Nothing runs on its own.
            </p>
          </div>
        ) : active === -1 && plan ? (
          <PlanView rows={plan.rows} raw={plan.raw} />
        ) : !current ? (
          <div className="h-full flex items-center justify-center text-xs text-ink-faint">
            ⌘↵ runs the statement at your cursor. ⇧⌘↵ runs all of them.
            <br />
            Or just ask in plain English — ⌘↵ turns it into SQL for you to check.
          </div>
        ) : current.status === 'error' ? (
          <QueryError
            conn={conn}
            error={current.error ?? ''}
            failingSql={current.sql}
            schema={schema}
            onApply={(next) => setInject((p) => ({ text: next, nonce: p.nonce + 1, mode: 'replace' }))}
            onInsert={(text) => setInject((p) => ({ text: ensureTerminated(formatSql(text)), nonce: p.nonce + 1 }))}
          />
        ) : current.columns.length === 0 && current.status === 'done' ? (
          <div className="h-full flex items-center justify-center text-xs text-ink-faint">
            {current.kind === 'read'
              ? 'No rows.'
              : 'Statement completed. It returned no result set.'}
          </div>
        ) : (
          <ResultGrid
            columns={current.columns}
            rows={current.rows}
            sort={current.sort}
            sortable={current.kind === 'read' && !running}
            onSort={(column) => void sortBy(active, column, conn.engine)}
          />
        )}
      </div>

      <div className="h-7 shrink-0 border-t border-card px-3.5 flex items-center gap-3 text-[11px] text-ink-faint">
        {!current && <span>Ready.</span>}
        {current?.status === 'running' && (
          <span>Running… {current.rows.length.toLocaleString()} rows so far</span>
        )}
        {current?.status === 'pending' && <span>Queued.</span>}
        {current?.status === 'cancelled' && (
          <span className="text-amber-400/90">
            Cancelled — the server stopped executing it.
          </span>
        )}
        {current?.status === 'done' && (
          <>
            <span>
              {current.rowCount.toLocaleString()} row{current.rowCount === 1 ? '' : 's'}
            </span>
            {current.durationMs !== null && <span>{current.durationMs} ms</span>}
            {current.durationMs !== null &&
              slowQueryMs > 0 &&
              current.durationMs >= slowQueryMs &&
              current.kind === 'read' && (
                <button
                  onClick={() => void explain('Why is this slow, and what would make it faster?')}
                  className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2"
                >
                  see why
                </button>
              )}
            {current.truncated && (
              <span className="text-amber-400/90">
                stopped at the row limit — raise it in Settings
              </span>
            )}
          </>
        )}
        {tabs.length > 1 && (
          <>
            <div className="flex-1" />
            <span>
              statement {active + 1} of {tabs.length}
            </span>
          </>
        )}
      </div>
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
            onInsertSql={(text) => setInject((p) => ({ text: ensureTerminated(formatSql(text)), nonce: p.nonce + 1 }))}
            onClose={() => setAskOpen(false)}
          />
        </div>
      )}
    </div>
  );
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
