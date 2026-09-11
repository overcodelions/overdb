import { useEffect, useMemo, useState } from 'react';
import type { Connection, SchemaSnapshot } from '@shared/types';
import { parseSqlError, suggestIdentifier } from '@shared/sqlErrors';
import { Markdown } from './Markdown';
import { useStore } from './store';
import { ProdConfirm, useWriteToggle } from './WriteControls';

/// The error surface. Most of what happens here involves no model at all:
/// when the server says a column doesn't exist, the catalog already holds
/// the real name, and offering it is a lookup. The AI is the fallback for
/// everything that isn't a straightforward misspelling.
export function QueryError({
  conn,
  error,
  failingSql,
  schema,
  onApply,
  onInsert,
}: {
  conn: Connection;
  error: string;
  failingSql: string;
  schema?: SchemaSnapshot;
  /// Mechanical rename — safe to apply directly to the editor.
  onApply(nextSql: string): void;
  /// Model output — inserted for review, never applied over your text.
  onInsert(sql: string): void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const activeSchema = useStore((s) => s.activeSchema[conn.id]);
  const aiFastModel = useStore((s) => s.settings.aiFastModel);
  const [fixing, setFixing] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  const parsed = useMemo(() => parseSqlError(error), [error]);

  // The server refusing a write is not a mistake in the SQL, so none of the
  // machinery below applies: no spelling suggestion, no model. It is a
  // setting, and the answer is to point at it.
  const readOnlyRefusal =
    /read.only transaction|cannot execute in a read.only|25006|attempted to write a readonly database/i.test(
      error,
    );

  // Tell the header control it should draw attention to itself — the error
  // says what happened, the toggle up there is what answers it, and the two
  // are far enough apart on screen to need connecting.
  const flagWriteBlocked = useStore((s) => s.flagWriteBlocked);
  useEffect(() => {
    if (readOnlyRefusal) flagWriteBlocked(conn.id);
  }, [readOnlyRefusal, conn.id, flagWriteBlocked, error]);

  const gate = useWriteToggle(conn);

  // Which schema the failing statement actually resolved against, asked of
  // the server rather than read from our own state. "No such table" is
  // nearly always "right table, wrong schema", and that is invisible
  // unless the panel says which schema it was.
  const [sessionSchema, setSessionSchema] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.overdb
      .invoke('conn:currentSchema', conn.id)
      .then((s) => { if (live) setSessionSchema(s); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [conn.id, error]);

  const suggestions = useMemo(() => {
    if (!schema || !parsed.identifier) return [];
    if (parsed.kind === 'unknown-column') {
      const cols: Array<{ name: string; context: string }> = [];
      for (const sc of schema.schemas) {
        for (const t of sc.tables) {
          // Only tables the failing statement actually mentions, when it
          // mentions any — otherwise a 400-table database offers a dozen
          // equally-plausible `name` columns and helps nobody.
          if (!mentions(failingSql, t.name)) continue;
          for (const c of t.columns) cols.push({ name: c.name, context: t.name });
        }
      }
      const pool = cols.length
        ? cols
        : schema.schemas.flatMap((sc) =>
            sc.tables.flatMap((t) => t.columns.map((c) => ({ name: c.name, context: t.name }))),
          );
      return suggestIdentifier(parsed.identifier, pool);
    }
    if (parsed.kind === 'unknown-table') {
      const tables = schema.schemas.flatMap((sc) =>
        sc.tables.map((t) => ({ name: t.name, context: sc.name })),
      );
      return suggestIdentifier(parsed.identifier, tables);
    }
    return [];
  }, [schema, parsed, failingSql]);

  /// What clicking a suggestion actually writes. For a table in some OTHER
  /// schema than the session's, the fix is to qualify it — the name itself
  /// is already right, and rewriting `panel_widget` to `panel_widget` is a
  /// button that does nothing while claiming to have fixed the query.
  const replacementFor = (s: { name: string; context?: string }): string =>
    // Against the SESSION's schema, not the picker's. When those two
    // disagree — which is the exact situation this panel is often reporting
    // — qualifying by the picker produces a bare name that fails again.
    parsed.kind === 'unknown-table' && s.context && s.context !== (sessionSchema ?? activeSchema)
      ? `${s.context}.${s.name}`
      : s.name;

  const applyRename = (to: string) => {
    const from = parsed.identifier!;
    // Word-boundary replace so `id` doesn't also rewrite `client_id`.
    const next = failingSql.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), to);
    onApply(next);
    toast(to === from ? `${from} is already correct.` : `Replaced ${from} with ${to}.`);
  };

  const askAi = async () => {
    setFixing(true);
    setAnswer(null);
    try {
      const detected = await window.overdb.invoke('ai:detect');
      // Honour the CLI chosen in Settings; fall back to whichever is
      // installed only when nothing is chosen.
      const preferred = useStore.getState().settings.aiTool;
      const use =
        preferred && detected[preferred]
          ? preferred
          : (['claude', 'codex', 'gemini'] as const).find((t) => detected[t]);
      if (!use) {
        setAnswer('No AI CLI found. Install `claude`, `codex` or `gemini` to use this.');
        return;
      }
      const result = await window.overdb.invoke('ai:ask', {
        connectionId: conn.id,
        tool: use,
        mode: 'fix',
        question: '',
        failingSql,
        errorText: error,
        editorText: failingSql,
      });
      const text = result.ok ? result.message : (result.error ?? '');
      // An empty answer is still an answer that has to appear. Falsy text
      // rendered nothing, so a CLI that returned no body looked exactly like
      // a button that did nothing at all.
      setAnswer(text.trim() || 'The AI CLI returned nothing. Try again, or ask in the panel.');
    } catch (err) {
      // A rejected invoke is the one failure this panel used to swallow
      // whole: `fixing` went back to false, `answer` stayed null, and the
      // button simply sat there looking unclicked.
      setAnswer(`Could not ask: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="p-4 overflow-y-auto h-full">
      <pre className="text-[11px] font-mono whitespace-pre-wrap text-bad-strong/90 bg-bad/10 border border-bad/30 rounded p-3">
        {error}
      </pre>

      {sessionSchema && (
        <p className="mt-1.5 text-[10px] text-ink-faint">
          Ran against <code className="font-mono text-ink-muted">{sessionSchema}</code>
          {sessionSchema !== activeSchema && activeSchema && (
            <> — the picker says {activeSchema}, so the session and the picker disagree.</>
          )}
        </p>
      )}

      {readOnlyRefusal && (
        <div className="mt-3 rounded border border-warn/25 bg-warn/10 p-3">
          <p className="text-[11px] leading-relaxed text-warn-strong/90">
            {conn.name} is read-only, so the server refused this statement — nothing was changed.
          </p>

          {/* The fix, here, rather than a sentence pointing at a control on
              the other side of the screen. */}
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            {gate.writes ? (
              <span className="text-[11px] text-warn-strong/90">
                Writes are on now — run it again.
              </span>
            ) : gate.confirming ? (
              <ProdConfirm conn={conn} gate={gate} />
            ) : (
              <button
                onClick={() => (conn.env === 'prod' ? gate.begin() : void gate.enable())}
                className="text-[11px] px-2 py-1 rounded bg-warn/15 text-warn-strong border border-warn/30 hover:bg-warn/25"
              >
                Enable writes on {conn.name}
              </button>
            )}
            <span className="text-[10px] text-warn-strong/60">
              {conn.env === 'prod'
                ? 'A production connection asks you to type its name first.'
                : 'Stays on until you turn it off.'}
            </span>
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-warn-strong/60">
            The toggle above the editor also chooses whether each write commits on its own or waits
            inside a transaction you commit or roll back yourself.
          </p>
        </div>
      )}

      {!readOnlyRefusal && suggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] text-ink-muted mb-1.5">
            {parsed.kind === 'unknown-column' ? 'No such column' : 'No such table'}{' '}
            <code className="font-mono text-ink">{parsed.identifier}</code>. Did you mean:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => {
              const to = replacementFor(s);
              return (
                <button
                  key={`${s.context}.${s.name}`}
                  onClick={() => applyRename(to)}
                  className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card font-mono text-ink"
                  title={
                    to.includes('.')
                      ? `${s.name} lives in ${s.context}, not ${activeSchema ?? 'the current schema'}`
                      : s.context
                        ? `on ${s.context}`
                        : undefined
                  }
                >
                  {to}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-faint">
            From the schema — no AI involved. Applies straight to the editor.
          </p>
        </div>
      )}

      <div className={readOnlyRefusal ? 'hidden' : 'mt-4'}>
        <button
          onClick={() => void askAi()}
          disabled={fixing}
          className="text-xs px-2.5 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-card disabled:opacity-40"
        >
          {fixing ? 'Asking…' : suggestions.length ? 'Ask AI instead' : 'Ask AI to fix this'}
        </button>
        {aiFastModel.claude && (
          <span className="ml-2 text-[10px] text-ink-faint">
            uses the fast model ({aiFastModel.claude})
          </span>
        )}
      </div>

      {fixing && (
        <p className="mt-3 text-[11px] text-accent/80 animate-pulse">
          Asking {useStore.getState().settings.aiTool ?? 'the AI CLI'}…
        </p>
      )}

      {answer && (
        <div className="mt-3 border-l-2 border-accent/25 pl-2.5">
          <Markdown text={answer} onInsertSql={onInsert} />
        </div>
      )}
    </div>
  );
}

function mentions(sql: string, table: string): boolean {
  return new RegExp(`\\b${escapeRe(table)}\\b`, 'i').test(sql);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
