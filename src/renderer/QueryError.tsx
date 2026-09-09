import { useMemo, useState } from 'react';
import type { Connection, SchemaSnapshot } from '@shared/types';
import { parseSqlError, suggestIdentifier } from '@shared/sqlErrors';
import { Markdown } from './Markdown';
import { useStore } from './store';

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
  const aiFastModel = useStore((s) => s.settings.aiFastModel);
  const [fixing, setFixing] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  const parsed = useMemo(() => parseSqlError(error), [error]);

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

  const applyRename = (to: string) => {
    const from = parsed.identifier!;
    // Word-boundary replace so `id` doesn't also rewrite `client_id`.
    const next = failingSql.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), to);
    onApply(next);
    toast(`Replaced ${from} with ${to}.`);
  };

  const askAi = async () => {
    const tool = (['claude', 'codex', 'gemini'] as const).find(Boolean);
    setFixing(true);
    setAnswer(null);
    try {
      const detected = await window.overdb.invoke('ai:detect');
      const use = (['claude', 'codex', 'gemini'] as const).find((t) => detected[t]);
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
      setAnswer(result.ok ? result.message : (result.error ?? 'No response.'));
    } finally {
      setFixing(false);
    }
    void tool;
  };

  return (
    <div className="p-4 overflow-y-auto h-full">
      <pre className="text-[11px] font-mono whitespace-pre-wrap text-red-300/90 bg-red-950/25 border border-red-900/40 rounded p-3">
        {error}
      </pre>

      {suggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] text-ink-muted mb-1.5">
            {parsed.kind === 'unknown-column' ? 'No such column' : 'No such table'}{' '}
            <code className="font-mono text-ink">{parsed.identifier}</code>. Did you mean:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={`${s.context}.${s.name}`}
                onClick={() => applyRename(s.name)}
                className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card font-mono text-ink"
                title={s.context ? `on ${s.context}` : undefined}
              >
                {s.name}
                {s.context && <span className="text-ink-faint ml-1.5 font-sans">{s.context}</span>}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-faint">
            From the schema — no AI involved. Applies straight to the editor.
          </p>
        </div>
      )}

      <div className="mt-4">
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

      {answer && (
        <div className="mt-3">
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
