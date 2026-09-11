import type { PlanRow } from '@shared/plan';
import { planFindings } from '@shared/planFindings';
import { planShape, stageSentence, wasteSentence } from '@shared/planShape';

/// The numbers the whole view is about, before any of the drawing.
///
/// Three of them and a sentence. Everything below this — the river, the
/// ledger, the table — exists to answer "why", and none of it is worth
/// looking at until "what" has landed: this query read a hundred and fifty
/// thousand rows to hand back one.
export function PlanVerdict({
  rows,
  result,
}: {
  rows: PlanRow[];
  result?: { rowCount: number; durationMs: number | null } | null;
}): JSX.Element | null {
  const shape = planShape(rows, result?.rowCount ?? null);
  if (shape.total === null) return null;
  const sentence = wasteSentence(shape);
  // Said beside the ratio rather than instead of it: they are two different
  // reasons a query is slow, and a query can have both.
  const blocking = stageSentence(shape);

  return (
    <div className="mx-3 mt-2 flex items-stretch rounded-md border border-card bg-card overflow-hidden">
      <Cell value={shape.total.toLocaleString()} label={shape.measured ? 'rows read' : 'rows to read, estimated'} tone="text-hot" />
      {shape.returned !== null && (
        <Cell value={shape.returned.toLocaleString()} label="rows returned" tone="text-good" />
      )}
      {result?.durationMs != null && (
        <Cell value={`${result.durationMs.toLocaleString()} ms`} label="elapsed" tone="text-ink" />
      )}
      <div className="flex flex-col justify-center gap-0.5 px-4 py-2.5 flex-1 min-w-0">
        <span className="text-[11.5px] text-ink-muted leading-snug">
          {sentence ?? 'Run the statement to see how many of those rows come back.'}
        </span>
        {blocking && <span className="text-[11.5px] text-warn/90 leading-snug">{blocking}</span>}
      </div>
    </div>
  );
}

function Cell({ value, label, tone }: { value: string; label: string; tone: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-[3px] px-4 py-2.5 border-r border-card shrink-0">
      <span className={`font-mono text-[19px] leading-none tabular-nums ${tone}`}>{value}</span>
      <span className="text-[10.5px] text-ink-faint">{label}</span>
    </div>
  );
}

/// What the picture shows, said in words.
///
/// The river and the ledger are both faithful and both silent: they put the
/// expensive step in front of you and leave you to work out what is wrong
/// with it. This says it — grouped by what you would DO, so three scans of
/// one table are one missing index rather than three amber lines.
export function PlanReading({
  rows,
  result,
  aliases,
  onTune,
  tuning,
}: {
  rows: PlanRow[];
  result?: { rowCount: number; durationMs: number | null } | null;
  aliases: Record<string, string>;
  onTune?(): void;
  tuning?: boolean;
}): JSX.Element | null {
  const findings = planFindings(rows, aliases);
  const shape = planShape(rows, result?.rowCount ?? null);

  return (
    <div className="flex flex-col gap-3">
      {findings.length > 0 ? (
        <div className="rounded-md border border-warn/35 bg-warn/[0.07] px-4 py-3 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-[0.04em] text-warn/90">
            Worth looking at
          </span>
          {findings.slice(0, 4).map((finding, i) => (
            <div key={i} className="flex gap-2.5">
              <span className="font-mono text-[11px] text-hot shrink-0">{i + 1}</span>
              <span className="text-[11.5px] leading-[1.5] text-ink">{finding.text}</span>
            </div>
          ))}
          {findings.length > 4 && (
            <span className="text-[10.5px] text-ink-faint">
              {findings.length - 4} more, all of them visible in the steps above.
            </span>
          )}
        </div>
      ) : (
        // A view with nothing amber in it looks like a view that failed to
        // draw. Saying so is the finding.
        <div className="rounded-md border border-good/30 bg-good/[0.06] px-4 py-3">
          <span className="text-[11.5px] leading-snug text-good/90">
            Nothing here stands out: every step uses an index and passes on about what it reads.
          </span>
        </div>
      )}

      {onTune && (
        // Directly under the findings, not at the foot of the column: the
        // box above is what is wrong, this is the only thing on the view you
        // can do about it, and a reader who has just read four amber lines is
        // asking this question already. Deliberately still a question, not
        // "Optimise" — what comes back is a candidate to plan and read, and a
        // button promising a faster query would promise something nothing
        // here has measured.
        <button
          onClick={onTune}
          disabled={tuning}
          className="w-full rounded-md border border-accent/60 bg-accent/20 px-3 py-2.5 text-left text-[12px] text-ink hover:bg-accent/30 hover:border-accent/80 disabled:opacity-50"
        >
          {tuning ? 'Thinking…' : 'Ask what to try instead →'}
        </button>
      )}

      {shape.heaviest && (
        <div className="rounded-md border border-card bg-card px-4 py-3 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-[0.04em] text-ink-faint">
            Where the time goes
          </span>
          <span className="text-[11.5px] leading-[1.5] text-ink-muted">
            The heaviest single step is{' '}
            <span className="font-mono text-ink">{shape.heaviest.title}</span>, at{' '}
            <span className="font-mono text-ink">{(shape.read ?? 0).toLocaleString()}</span> rows
            {shape.total !== null && shape.read !== null && shape.total > 0 && (
              <> — {Math.round((shape.read / shape.total) * 100)}% of everything this query reads.</>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
