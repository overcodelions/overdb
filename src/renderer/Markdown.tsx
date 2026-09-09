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
}: {
  text: string;
  onInsertSql?(sql: string): void;
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
              {onInsertSql && (
                <button
                  onClick={() => onInsertSql(block.text)}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
                >
                  Insert into editor
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
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    nodes.push(
      <ul key={`u${nodes.length}`} className="list-disc pl-4 space-y-0.5">
        {bullets.map((b, i) => (
          <li key={i}>{inline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
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
