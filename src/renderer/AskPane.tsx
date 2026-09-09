import { useEffect, useRef, useState } from 'react';
import type { Connection } from '@shared/types';
import { Markdown } from './Markdown';
import { useStore } from './store';

type Tool = 'claude' | 'codex' | 'gemini';
type Mode = 'ask' | 'sql' | 'explain';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  context?: { included: string[]; total: number };
  failed?: boolean;
}

export function AskPane({
  conn,
  editorText,
  request,
  onInsertSql,
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
  onInsertSql(sql: string): void;
  onClose(): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [tools, setTools] = useState<Record<Tool, boolean> | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const detected = await window.overdb.invoke('ai:detect');
      setTools(detected);
      setTool((['claude', 'codex', 'gemini'] as Tool[]).find((t) => detected[t]) ?? null);
    })();
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns, busy]);

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
    if ((!question && mode !== 'explain') || !tool || busy) return;

    const asked: Turn = {
      role: 'user',
      text:
        question ||
        (sqlOverride ? `Explain: ${sqlOverride.replace(/\s+/g, ' ').slice(0, 90)}` : 'Explain the query in the editor.'),
    };
    setTurns((t) => [...t, asked]);
    if (override === undefined) setDraft('');
    setBusy(true);
    try {
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: conn.id,
        tool,
        mode,
        question,
        editorText: sqlOverride ?? editorText,
        history: turns.map((t) => ({ role: t.role, text: t.text })),
      });
      setTurns((t) => [
        ...t,
        {
          role: 'assistant',
          text: result.ok ? result.message : (result.error ?? 'No response.'),
          failed: !result.ok,
          context: { included: result.contextTables, total: result.totalTables },
        },
      ]);
    } finally {
      setBusy(false);
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
        <span className="text-[10px] text-ink-faint">
          Ask a question, or describe a query you want
        </span>
        <div className="flex-1" />
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

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {turns.length === 0 && (
          <p className="text-[11px] text-ink-faint leading-relaxed">
            Ask about {conn.name}&#39;s schema, or describe a query you want. Explain — next
            to Run — sends the editor&#39;s query through a real EXPLAIN and interprets the
            plan your server actually produced.
            <br />
            <br />
            Only table and column names, types and constraints are ever sent — never your rows.
            Nothing here runs on its own: SQL lands in the editor for you to read first.
          </p>
        )}
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="text-xs text-ink-muted">
              <span className="text-ink-faint">You: </span>
              {turn.text}
            </div>
          ) : (
            <div key={i}>
              {turn.failed ? (
                <p className="text-xs text-red-300/90">{turn.text}</p>
              ) : (
                <Markdown text={turn.text} onInsertSql={(sql) => { onInsertSql(sql); toast('Inserted into the editor.'); }} />
              )}
              {turn.context && turn.context.total > 0 && (
                <p
                  className="mt-1.5 text-[10px] text-ink-faint"
                  title={turn.context.included.join(', ')}
                >
                  saw {turn.context.included.length} of {turn.context.total} tables
                </p>
              )}
            </div>
          ),
        )}
        {busy && <p className="text-[11px] text-ink-faint">Thinking… (up to 90s)</p>}
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
            disabled={busy || !tool || !draft.trim()}
            className="text-xs px-2.5 py-1 rounded bg-accent/90 text-white hover:bg-accent disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Send'}
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
