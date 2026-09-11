import { Fragment } from 'react';

/// A deliberately small markdown renderer: fenced code, inline code, bold,
/// bullets, paragraphs. Written rather than pulled in because the
/// alternative is three dependencies (marked + DOMPurify + highlight.js) to
/// render a chat bubble.
///
/// Everything is emitted as React text nodes, never dangerouslySetInnerHTML,
/// so model output cannot inject markup into the app no matter what it says.
export function Markdown({
  text,
  onInsertSql,
  onNewTabSql,
  onExplainSql,
}: {
  text: string;
  onInsertSql?(sql: string): void;
  /// The same statement, in a tab of its own — for a rewrite you want to
  /// keep beside the original rather than under it.
  onNewTabSql?(sql: string): void;
  /// Plan this statement without running it. A suggested rewrite is a claim
  /// about cost, and EXPLAIN is how you check a claim about cost.
  onExplainSql?(sql: string): void;
}): JSX.Element {
  const blocks = splitFences(text);
  return (
    <div className="text-xs leading-relaxed text-ink space-y-2">
      {blocks.map((block, i) =>
        block.kind === 'code' ? (
          <div key={i} className="rounded border border-card bg-surface overflow-hidden">
            <div className="flex items-center gap-2 px-2 py-1 border-b border-card">
              <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                {block.lang || 'code'}
              </span>
              <div className="flex-1" />
              {onExplainSql && /^\s*(select|with)\b/i.test(block.text) && (
                <button
                  onClick={() => onExplainSql(block.text)}
                  title="Run EXPLAIN on this statement and draw its plan — it is not executed"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
                >
                  Plan this
                </button>
              )}
              {onNewTabSql && (
                <button
                  onClick={() => onNewTabSql(block.text)}
                  title="Open this statement in a new tab, leaving the current one alone"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
                >
                  New tab
                </button>
              )}
              {onInsertSql && (
                <button
                  onClick={() => onInsertSql(block.text)}
                  // It appends now rather than inserting at the cursor, and
                  // the label says so: "Insert into editor" on a button
                  // that lands text at the bottom is a small lie you only
                  // catch after it has cut a statement in half.
                  title="Add to the end of this tab, under a comment saying where it came from"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
                >
                  Append to tab
                </button>
              )}
            </div>
            <pre className="px-2.5 py-2 overflow-x-auto text-[11px] font-mono whitespace-pre">
              {block.text}
            </pre>
          </div>
        ) : (
          <Prose key={i} text={block.text} />
        ),
      )}
    </div>
  );
}

interface Block {
  kind: 'code' | 'prose';
  text: string;
  lang?: string;
}

function splitFences(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'prose', text: text.slice(last, m.index) });
    out.push({ kind: 'code', lang: m[1] || undefined, text: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'prose', text: text.slice(last) });
  return out.filter((b) => b.kind === 'code' || b.text.trim());
}

function Prose({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n');
  const nodes: JSX.Element[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    const { ordered, items } = list;
    list = null;
    const cls = `pl-4 space-y-1 marker:text-ink-faint ${ordered ? 'list-decimal' : 'list-disc'}`;
    const children = items.map((b, i) => <li key={i}>{inline(b)}</li>);
    nodes.push(
      ordered ? (
        <ol key={`u${nodes.length}`} className={cls}>
          {children}
        </ol>
      ) : (
        <ul key={`u${nodes.length}`} className={cls}>
          {children}
        </ul>
      ),
    );
  };

  for (const line of lines) {
    // A heading is the model's own structure; rendering it as literal `##`
    // is worse than not supporting it at all, because the marker reads as
    // noise in the middle of the answer.
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      nodes.push(
        <p
          key={`h${nodes.length}`}
          className={
            'font-semibold text-ink pt-1 ' +
            (level <= 2 ? 'text-[12px]' : 'text-[11px] uppercase tracking-wide text-ink-muted')
          }
        >
          {inline(heading[2])}
        </p>,
      );
      continue;
    }
    if (/^\s{0,3}([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flush();
      nodes.push(<hr key={`r${nodes.length}`} className="border-0 border-t border-card my-1" />);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const match = bullet ?? numbered;
    if (match) {
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(match[1]);
      continue;
    }
    flush();
    if (line.trim()) nodes.push(<p key={`p${nodes.length}`}>{inline(line)}</p>);
  }
  flush();
  return <>{nodes}</>;
}

/// Inline code and bold. Split on the markers rather than replacing into
/// HTML, so the result is always plain text nodes.
function inline(text: string): JSX.Element {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return (
            <code key={i} className="font-mono text-[11px] px-1 py-0.5 rounded bg-card text-ink">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
