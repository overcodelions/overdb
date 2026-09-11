import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskTurn, Connection } from '@shared/types';
import { Markdown } from './Markdown';
import { useStore } from './store';
import { queryLanguage } from '@shared/engines';
import { filterTurns } from './askFilter';

type Tool = 'claude' | 'codex' | 'gemini';
type Mode = 'ask' | 'sql' | 'explain' | 'faster';

const NO_TURNS: AskTurn[] = [];

export function AskPane({
  conn,
  editorText,
  request,
  onInsertSql,
  onNewTabSql,
  onExplainSql,
  onBusyChange,
  onClose,
}: {
  conn: Connection;
  editorText: string;
  /// An action initiated elsewhere in the app — Explain from the toolbar, or
  /// the slow-query nudge. The panel is where the ANSWER lands; it is not
  /// where the question has to start.
  request?: {
    mode: Mode;
    question: string;
    nonce: number;
    /// The single statement to explain. EXPLAIN takes one statement, so
    /// sending the whole editor silently fails and the model is left
    /// answering from the schema alone.
    sql?: string;
  };
  onInsertSql(sql: string, note: string): void;
  /// The same statement, in a tab of its own.
  onNewTabSql?(sql: string, note: string): void;
  /// Plan a statement the model suggested, without running it.
  onExplainSql?(sql: string): void;
  /// Whether a request is in flight, for callers that put their own button
  /// on one of these flows and need it to say "thinking" too.
  onBusyChange?(busy: boolean): void;
  onClose(): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const [tools, setTools] = useState<Record<Tool, boolean> | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);

  // One thread per connection, not one panel-wide. A conversation is about
  // a specific database's tables, so carrying it to the next connection
  // showed an answer about `panel_widget` above a DynamoDB editor — and fed
  // it back as history on the next question.
  //
  // It lives in the app store rather than in this component, and is written
  // to disk after every turn: closing the panel used to throw the whole
  // conversation away, which made "what did I ask about this yesterday" a
  // question with no answer.
  const threads = useStore((s) => s.askThreads);
  const appendAskTurn = useStore((s) => s.appendAskTurn);
  const clearAskThread = useStore((s) => s.clearAskThread);
  // A stable empty array: a fresh `[]` each render would re-fire the
  // scroll-to-bottom effect on every keystroke.
  const turns = threads[conn.id] ?? NO_TURNS;
  const append = (id: string, turn: Omit<AskTurn, 'at'>) =>
    appendAskTurn(id, { ...turn, at: Date.now() });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[conn.id] ?? '';
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [conn.id]: text }));

  // Narrows the thread to the exchanges that mention something. Deliberately
  // NOT per-connection and NOT persisted: a filter is a thing you are doing
  // right now, and a thread that came back still filtered from yesterday
  // would read as a thread that had lost most of its turns.
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [conn.id]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => filterTurns(turns, filter), [turns, filter]);
  const questions = turns.filter((t) => t.role === 'user').length;
  const shownQuestions = shown.filter((t) => t.role === 'user').length;

  /// The connection a request is in flight for — so the spinner belongs to
  /// the connection that asked, not to whichever one you switched to.
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const busy = busyFor === conn.id;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const detected = await window.overdb.invoke('ai:detect');
      setTools(detected);
      // The CLI chosen in Settings wins; the first installed one is only a
      // fallback for when nothing has been chosen.
      const preferred = useStore.getState().settings.aiTool;
      setTool(
        (preferred && detected[preferred] ? preferred : null) ??
          (['claude', 'codex', 'gemini'] as Tool[]).find((t) => detected[t]) ??
          null,
      );
    })();
  }, []);

  useEffect(() => {
    // Filtering is a search, not a new message: it goes to the top, where
    // the oldest match is — the bottom is the one place you already know
    // how to reach.
    scroller.current?.scrollTo({ top: needle ? 0 : scroller.current.scrollHeight });
  }, [shown, busy, needle]);

  useEffect(() => {
    onBusyChange?.(busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const lastRequest = useRef(0);
  useEffect(() => {
    if (!request || !tool || request.nonce === lastRequest.current) return;
    lastRequest.current = request.nonce;
    void send(request.mode, request.question, request.sql);
    // `send` is recreated every render; keying on the nonce is what makes
    // this fire once per request rather than on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce, tool]);

  const send = async (mode: Mode = 'ask', override?: string, sqlOverride?: string) => {
    const question = (override ?? draft).trim();
    if ((!question && mode !== 'explain' && mode !== 'faster') || !tool || busyFor) return;

    // Captured, not read from `conn` when the answer lands: a 90-second
    // request outlives any number of connection switches, and the answer
    // belongs to the thread that asked for it.
    const id = conn.id;
    // The statement rides along with the question. "Why is this slow?" is
    // unreadable a day later — or five turns later — without the query it
    // was asked about, and that is exactly the question the slow-query nudge
    // and the Explain button both ask.
    const asked: Omit<AskTurn, 'at'> = {
      role: 'user',
      text:
        question ||
        (mode === 'faster' ? 'What would make this faster?' : 'Explain the query in the editor.'),
      sql:
        (sqlOverride ?? (mode === 'explain' || mode === 'faster' ? editorText : undefined))?.trim() ||
        undefined,
    };
    append(id, asked);
    if (override === undefined) setDraft('');
    setBusyFor(id);
    try {
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: id,
        tool,
        mode,
        question,
        editorText: sqlOverride ?? editorText,
        history: turns.map((t) => ({ role: t.role, text: t.text })),
        pinned: conn.pinnedTables,
      });
      append(id, {
        role: 'assistant',
        text: result.ok ? result.message : (result.error ?? 'No response.'),
        failed: !result.ok,
        context: { included: result.contextTables, total: result.totalTables },
      });
    } catch (err) {
      // Without this a rejected invoke left the question sitting there with
      // no answer under it and no sign anything had gone wrong.
      append(id, {
        role: 'assistant',
        failed: true,
        text: `Could not ask: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyFor(null);
    }
  };

  if (tools && !tool) {
    return (
      <Shell onClose={onClose}>
        <div className="p-4 text-xs text-ink-muted leading-relaxed">
          <p className="mb-2">No AI CLI found.</p>
          <p className="text-ink-faint">
            overdb uses whichever of <code className="font-mono">claude</code>,{' '}
            <code className="font-mono">codex</code> or <code className="font-mono">gemini</code>{' '}
            you already have installed and logged in — there is no API key to enter and no
            subscription to add. Install one and reopen this panel.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-card shrink-0">
        {/* The filter takes the count line's place rather than adding a row
            of its own: in a pane this narrow every permanent row is one less
            line of answer, and the count reads perfectly well as a
            placeholder. Below a couple of questions there is nothing to
            search, so it stays a plain label. */}
        {questions >= 2 ? (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setFilter('');
                }
              }}
              placeholder={threadLabel(questions, conn.name)}
              aria-label="Filter this thread"
              className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[10px] text-ink placeholder:text-ink-faint hover:bg-card focus:bg-card focus:outline-none"
            />
            {needle && (
              <span className="shrink-0 text-[10px] text-ink-faint tabular-nums">
                {shownQuestions} of {questions}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="text-[10px] text-ink-faint">
              {turns.length
                ? threadLabel(questions, conn.name)
                : 'Ask a question, or describe a query you want'}
            </span>
            <div className="flex-1" />
          </>
        )}
        {turns.length > 0 && (
          <button
            onClick={() =>
              askConfirm({
                title: `Forget this thread?`,
                body: `Deletes the ${turns.length} saved turns for ${conn.name}. The statements themselves stay in the activity log.`,
                confirmLabel: 'Forget',
                destructive: true,
                onConfirm: () => clearAskThread(conn.id),
              })
            }
            className="text-[10px] text-ink-faint hover:text-ink"
          >
            Clear
          </button>
        )}
        {tools && (
          <select
            value={tool ?? ''}
            onChange={(e) => setTool(e.target.value as Tool)}
            className="field px-1 py-0.5 text-[10px]"
            title="Uses this CLI's existing login"
          >
            {(['claude', 'codex', 'gemini'] as Tool[])
              .filter((t) => tools[t])
              .map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
          </select>
        )}
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {turns.length === 0 && (
          <p className="text-[11px] text-ink-faint leading-relaxed">
            Ask about {conn.name}&#39;s schema, or describe a query you want. Explain — next
            to Run — sends the editor&#39;s query through a real EXPLAIN and interprets the
            plan your server actually produced.
            <br />
            <br />
            Only table and column names, types and constraints are ever sent — never your rows.
            Nothing here runs on its own: {queryLanguage(conn.engine)} lands in the editor for you
            to read first.
          </p>
        )}
        {needle && shown.length === 0 && (
          <p className="text-[11px] text-ink-faint">
            No question or answer in this thread mentions &ldquo;{filter.trim()}&rdquo;.
          </p>
        )}
        {shown.map((turn, i) => (
          <div key={i} className="space-y-3">
            {/* A day marker, so a thread you come back to reads as a history
                rather than as one long conversation with no time in it. */}
            {dayOf(turn.at) !== dayOf(shown[i - 1]?.at) && (
              <div className="flex items-center gap-2 pt-1">
                <span className="h-px flex-1 bg-card" />
                <span className="text-[9px] uppercase tracking-[0.07em] text-ink-faint">
                  {dayLabel(turn.at)}
                </span>
                <span className="h-px flex-1 bg-card" />
              </div>
            )}
            {turn.role === 'user' ? (
            // The question is tinted and boxed, the answer is not: in a long
            // scroll the only thing you actually hunt for is where each turn
            // began, and that is the question.
            <div className="rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs text-ink">
              <div className="whitespace-pre-wrap">{turn.text}</div>
              {turn.sql && (
                <pre className="mt-1.5 pt-1.5 border-t border-accent/20 font-mono text-[10px] leading-snug text-ink-muted whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                  {turn.sql}
                </pre>
              )}
            </div>
          ) : (
            <div className="border-l-2 border-accent/25 pl-2.5">
              {turn.failed ? (
                <p className="text-xs text-bad">{turn.text}</p>
              ) : (
                <Markdown
                  text={turn.text}
                  // The note travels with the statement: a week later the
                  // only thing that distinguishes a suggestion from your
                  // own SQL is the line above it saying which is which.
                  onInsertSql={(sql) => {
                    onInsertSql(sql, `Suggested by ${tool ?? 'the assistant'}`);
                    toast('Added to the end of this tab.');
                  }}
                  onNewTabSql={
                    onNewTabSql &&
                    ((sql) => {
                      onNewTabSql(sql, `Suggested by ${tool ?? 'the assistant'}`);
                      toast('Opened in a new tab.');
                    })
                  }
                  onExplainSql={onExplainSql}
                />
              )}
              {turn.context && turn.context.total > 0 && (
                // Which tables it saw is the first thing you want when an
                // answer is wrong, and the second thing you want is to
                // change them — so the line that reports the guess is also
                // the way to override it.
                <button
                  onClick={() => setSheet({ kind: 'pickTables', connectionId: conn.id })}
                  className="mt-1.5 text-[10px] text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
                  title={`${turn.context.included.join(', ')}\n\nClick to choose which tables it always sees.`}
                >
                  saw {turn.context.included.length} of {turn.context.total} tables
                </button>
              )}
            </div>
            )}
          </div>
        ))}
        {busy && (
          <p className="text-[11px] text-accent/80 animate-pulse">Thinking… (up to 90s)</p>
        )}
      </div>

      <div className="shrink-0 border-t border-card p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send('ask');
            }
          }}
          rows={3}
          placeholder={'Ask about this database, or describe a query… ⌘↵'}
          className="field w-full px-2 py-1.5 text-xs resize-none"
        />
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-ink-faint">Nothing runs automatically.</span>
          <div className="flex-1" />
          <button
            onClick={() => void send('ask')}
            // Any connection's request blocks: one CLI runs at a time, and a
            // disabled button says so better than a click that does nothing.
            disabled={!!busyFor || !tool || !draft.trim()}
            className="text-xs px-2.5 py-1 rounded bg-accent/90 text-white hover:bg-accent disabled:opacity-40"
          >
            {busyFor ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose(): void }): JSX.Element {
  return (
    <div className="h-full flex flex-col min-h-0 border-l border-card bg-surface-muted">
      <div className="flex items-center h-10 px-3 border-b border-card shrink-0">
        <span className="text-xs font-medium text-ink">Ask</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          aria-label="Close"
          className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {children}
    </div>
  );
}

/// Local calendar day, for the separators. Epoch millis are compared by day
/// rather than by date string so a thread read at midnight does not grow a
/// separator between two turns a second apart.
function dayOf(at: number | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(at: number): string {
  const today = dayOf(Date.now());
  const yesterday = dayOf(Date.now() - 86_400_000);
  const day = dayOf(at);
  if (day === today) return 'today';
  if (day === yesterday) return 'yesterday';
  return new Date(at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: dayOf(at).slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  });
}

function threadLabel(questions: number, name: string): string {
  return `${questions} question${questions === 1 ? '' : 's'} about ${name}`;
}
