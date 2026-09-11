import { useState } from 'react';
import { keyLabel, type PlanRow } from '@shared/plan';
import { chainFlow } from '@shared/planFlow';
import { isDriven } from '@shared/planLoops';
import { planShape, share } from '@shared/planShape';
import { resolveStep } from '@shared/aliases';
import { kindLabel, splitCondition, type ConditionKind } from '@shared/planCondition';
import { branchesOf, chainOf, planTree, type PlanNode } from '@shared/planTree';

/// Every step of the plan, on one scale, read top to bottom.
///
/// The river above says what SHAPE the query is. This says what it did, and
/// it is deliberately a list: a real plan is deep rather than wide — the one
/// that prompted this has thirty-three steps — and every horizontal layout
/// answers that depth by truncating names, shrinking type, or showing you
/// the first five. A line each costs nothing and hides nothing.
///
/// Two things it does that a plan table does not. Every bar is on ONE scale,
/// so the heaviest step is the one you can see from across the room. And the
/// `Work` column prints the multiplication — rows per run × runs — that a
/// plan table leaves the reader to do in their head, which is where the cost
/// of a nested loop has always been hiding.
///
/// Subqueries COLLAPSE. Six of them, three steps each, is eighteen rows of
/// detail in front of a question that is usually "which one is expensive?".
/// Each folds to one line carrying its own subtotal; the heaviest opens by
/// default, because that is the one being looked for.

const COLUMNS = { gridTemplateColumns: '300px 152px minmax(48px, 1fr) 88px' } as const;

interface Item {
  node: PlanNode;
  read: number;
  per: number;
  runs: number;
  /// How deep inside its subquery this step sits, for the indent.
  inset: number;
}

/// One subquery, flattened to the order its rows actually travel: the steps
/// that BUILD it first, then the step that reads what they built.
function branchItems(node: PlanNode, inset = 0): Item[] {
  const out: Item[] = [];
  for (const child of chainOf(node)) out.push(...branchItems(child, inset + 1));
  const per = node.row.actualRows ?? node.row.rows ?? 0;
  const runs = Math.max(1, node.row.loops ?? 1);
  out.push({ node, per, runs, read: per * runs, inset });
  return out;
}

export function PlanLedger({
  rows,
  result,
  aliases,
}: {
  rows: PlanRow[];
  result?: { rowCount: number; durationMs: number | null } | null;
  aliases: Record<string, string>;
}): JSX.Element | null {
  const tree = planTree(rows);
  const shape = planShape(rows, result?.rowCount ?? null);
  const [opened, setOpened] = useState<Set<string> | null>(null);
  if (!tree.length || shape.read === null) return null;

  const trunk = tree.filter((n) => (n.row.actualRows ?? n.row.rows) !== undefined);
  if (!trunk.length) return null;

  const flows = chainFlow(
    trunk.map((n) => ({
      per: n.row.actualRows ?? n.row.rows ?? 0,
      runs: Math.max(1, n.row.loops ?? 1),
      filtered: n.row.filtered,
      driven: isDriven(n.row.access),
    })),
    shape.returned ?? null,
  );

  const max = Math.max(
    1,
    ...rows.map((r) => (r.actualRows ?? r.rows ?? 0) * Math.max(1, r.loops ?? 1)),
  );

  // Subqueries, heaviest first. The order they are evaluated in is not
  // something the plan reports and not something anyone can act on; which
  // of them costs the most is both.
  const groups = trunk.flatMap((parent, pi) =>
    branchesOf(parent).map((branch, bi) => {
      const items = branchItems(branch);
      return {
        key: `${pi}:${bi}`,
        parent,
        ordinal: bi + 1,
        of: branchesOf(parent).length,
        items,
        // A subquery's own steps drop rows between one another, but what
        // the LAST of them hands to the query above is not something the
        // plan reports — so it is passed no returned count and claims no
        // drop, rather than being credited with the single row a semi-join
        // usually yields.
        flow: chainFlow(
          items.map((it) => ({
            per: it.per,
            runs: it.runs,
            filtered: it.node.row.filtered,
            driven: isDriven(it.node.row.access),
          })),
          null,
        ),
        total: items.reduce((n, it) => n + it.read, 0),
      };
    }),
  );
  groups.sort((a, b) => b.total - a.total);

  // Default: the heaviest one open. A view that opens everything is the
  // eighteen rows this was meant to fold; one that opens nothing makes you
  // click to find out what you came to find out.
  const isOpen = (key: string): boolean =>
    opened === null ? key === groups[0]?.key : opened.has(key);
  const toggle = (key: string): void =>
    setOpened((prev) => {
      const next = new Set(prev ?? (groups[0] ? [groups[0].key] : []));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col">
      <div className="grid gap-3 px-2.5 pb-1.5 border-b border-card" style={COLUMNS}>
        <Head>Step</Head>
        <Head>Work</Head>
        <Head>Share of rows read</Head>
        <Head className="text-right">Rows</Head>
      </div>

      <Divider label="Main line" note="runs once" />
      {trunk.map((node, i) => (
        <Line
          key={`t${i}`}
          node={node}
          per={node.row.actualRows ?? node.row.rows ?? 0}
          runs={Math.max(1, node.row.loops ?? 1)}
          read={flows[i].read}
          dropped={flows[i].dropped}
          kept={flows[i].out}
          estimated={flows[i].estimated}
          max={max}
          inset={i === 0 ? 0 : 1}
          aliases={aliases}
        />
      ))}

      {groups.length > 0 && (
        <Divider
          label={`${groups.length} ${groups.length === 1 ? 'subquery feeds' : 'subqueries feed'} ${
            resolveStep(groups[0].parent.row.title, aliases)?.table ?? groups[0].parent.row.title
          }`}
          note="independent of each other · evaluated one at a time"
          accent
        />
      )}

      {groups.map((group) => {
        const open = isOpen(group.key);
        const head = group.items[group.items.length - 1];
        const name = groupName(group.items, aliases);
        return (
          <div key={group.key} className="flex flex-col">
            <button
              onClick={() => toggle(group.key)}
              className="grid gap-3 items-center px-2.5 py-1.5 rounded text-left hover:bg-card"
              style={{ ...COLUMNS, background: open ? 'rgb(251 146 60 / 0.05)' : undefined }}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Chevron open={open} />
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {group.ordinal}/{group.of}
                </span>
                <span className="font-mono text-[11.5px] text-ink truncate">{name}</span>
              </span>
              <span className="text-[10.5px] text-ink-muted">
                {group.items.length} step{group.items.length === 1 ? '' : 's'}
                {head.node.row.materialized ? ' · materialized' : ''}
              </span>
              <Bar value={group.total / max} tone={group.total > max / 2 ? 'hot' : 'warn'} faded />
              <span className="font-mono text-[12px] tabular-nums text-right text-warn/90">
                {group.total.toLocaleString()}
              </span>
            </button>

            {open &&
              group.items.map((item, i) => (
                <Line
                  key={`${group.key}-${i}`}
                  node={item.node}
                  per={item.per}
                  runs={item.runs}
                  read={item.read}
                  dropped={group.flow[i].dropped}
                  kept={group.flow[i].out}
                  estimated={group.flow[i].estimated}
                  max={max}
                  inset={item.inset + 1}
                  aliases={aliases}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

/// What to call a folded subquery.
///
/// The step it ends on is often `<materialized_subquery>` — the server's
/// name for the temporary table, not for anything anybody wrote. A row
/// labelled that says nothing about which subquery it is, so the heaviest
/// step with a real name is used instead: that is the table the subquery is
/// actually about, and the one worth deciding whether to open it for.
function groupName(items: Item[], aliases: Record<string, string>): string {
  const named = [...items]
    .filter((it) => !it.node.row.title.startsWith('<'))
    .sort((a, b) => b.read - a.read)[0];
  const pick = named ?? items[items.length - 1];
  return resolveStep(pick.node.row.title, aliases)?.table ?? pick.node.row.title;
}

function Line({
  node,
  per,
  runs,
  read,
  dropped,
  kept,
  estimated,
  max,
  inset,
  aliases,
}: {
  node: PlanNode;
  per: number;
  runs: number;
  read: number;
  dropped: number;
  /// Rows surviving this step's own condition.
  kept: number;
  estimated: boolean;
  max: number;
  inset: number;
  aliases: Record<string, string>;
}): JSX.Element {
  const row = node.row;
  const named = resolveStep(row.title, aliases);
  const scan = row.warn !== undefined && !row.key;
  const hot = read > max / 2 || scan;
  // A drop worth naming, on the same threshold the rest of the view uses:
  // throwing away forty rows is not why anything is slow.
  const notable = dropped >= 500 && dropped / Math.max(1, read) > 0.75;

  return (
    <div className="flex flex-col">
      <div
        className="grid gap-3 items-center px-2.5 py-1.5 rounded mt-[3px]"
        style={{ ...COLUMNS, background: hot ? 'rgb(251 146 60 / 0.08)' : undefined }}
      >
        <span
          className="flex flex-col gap-[2px] min-w-0"
          style={{
            paddingLeft: inset * 14,
            borderLeft: inset > 0 ? '1px solid var(--c-card-border)' : undefined,
            marginLeft: inset > 0 ? 8 : 0,
          }}
        >
          <span className="font-mono text-[12px] text-ink truncate" title={named?.table ?? row.title}>
            {named?.table ?? row.title}
          </span>
          <span className={`text-[10.5px] truncate ${scan ? 'text-warn/90' : 'text-ink-faint'}`}>
            {[named?.alias, row.key ? `via ${keyLabel(row.key)}` : row.access]
              .filter(Boolean)
              .join(' · ') || '—'}
            {scan && ' — no index used'}
          </span>
        </span>

        {/* The multiplication, done. This is the column that did not exist. */}
        <span
          className={`font-mono text-[11px] tabular-nums ${
            runs > 1 ? 'text-warn/90' : 'text-ink-faint'
          }`}
        >
          {runs > 1 ? `${per.toLocaleString()} × ${runs.toLocaleString()} runs` : `${per.toLocaleString()} × 1`}
        </span>

        <Bar value={read / max} tone={hot ? 'hot' : 'cool'} />

        <span
          className={`font-mono text-[12px] tabular-nums text-right ${
            hot ? 'text-warn/90' : 'text-ink-muted'
          }`}
        >
          {read.toLocaleString()}
        </span>
      </div>
      {notable && (
        <div className="px-2.5 flex flex-col gap-1" style={{ paddingLeft: 24 + inset * 14 }}>
          {/* The WHERE clause, spelled out. `filtered` is the only account
              a plan gives of the filtering without ANALYZE, and it sits in
              the plan table six columns from the row count it applies to,
              which is why nobody ever multiplies the two. */}
          <span className="text-[10.5px] text-warn/90">
            {row.filtered !== undefined
              ? `The condition keeps ${share(row.filtered)} — ${estimated ? 'about ' : ''}${kept.toLocaleString()} row${
                  kept === 1 ? '' : 's'
                } survive${kept === 1 ? 's' : ''}, ${dropped.toLocaleString()} stop here.`
              : `${dropped.toLocaleString()} of the rows it reads stop here.`}
          </span>
          <Condition condition={row.condition} indexed={row.key} />
        </div>
      )}
    </div>
  );
}

/// What is actually doing the filtering.
///
/// `filtered` says how much a step's condition removes and never says which
/// part of it did. The server does say — in `attached_condition`, the
/// expression it evaluates against every row the step reads — and until now
/// that arrived as one four-thousand-character grey line at the bottom of
/// the raw plan.
///
/// Folded by default. It is the answer to the second question, and putting
/// six unfoldable subquery predicates under every step would bury the first.
function Condition({
  condition,
  indexed,
}: {
  condition?: string;
  /// The index that had already narrowed things down before any of this was
  /// evaluated. Worth naming: it is the difference between rows the server
  /// never read and rows it read and threw away.
  indexed?: string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const parts = splitCondition(condition);
  if (!parts.length) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start text-[10.5px] text-ink-faint hover:text-ink"
      >
        <Chevron open={open} />
        What is doing the filtering — {parts.length} condition{parts.length === 1 ? '' : 's'}
      </button>

      {open && (
        <div className="flex flex-col gap-[3px] pl-4 pb-1">
          {indexed && (
            <span className="text-[10px] text-ink-faint leading-snug">
              <span className="font-mono text-ink-muted">{indexed}</span> chose which rows to read.
              Everything below is checked against each of them afterwards.
            </span>
          )}
          {parts.map((part, i) => (
            <div key={i} className="flex items-baseline gap-2 min-w-0">
              <span className={`text-[9.5px] shrink-0 w-[128px] ${toneOf(part.kind)}`}>
                {part.branches ? `${part.branches} alternatives` : kindLabel(part.kind)}
              </span>
              <span
                className="font-mono text-[10.5px] text-ink-muted truncate"
                title={part.text}
              >
                {part.text}
              </span>
            </div>
          ))}
          {/* Said once, plainly. Without it this list invites the reading
              that the first condition is the one costing 99.5% of the rows,
              and the plan has made no such claim. */}
          <span className="text-[10px] text-ink-faint leading-snug mt-0.5">
            The server reports one combined figure for all of these — it does not say how much each
            one removes on its own.
          </span>
        </div>
      )}
    </div>
  );
}

function toneOf(kind: ConditionKind): string {
  if (kind === 'subquery') return 'text-accent';
  if (kind === 'alternatives') return 'text-warn/90';
  return 'text-ink-faint';
}

function Bar({
  value,
  tone,
  faded,
}: {
  value: number;
  tone: 'hot' | 'warn' | 'cool';
  faded?: boolean;
}): JSX.Element {
  const colour =
    tone === 'hot' ? 'bg-hot' : tone === 'warn' ? 'bg-warn' : 'bg-good';
  return (
    <span className="h-[7px] rounded-[3.5px] bg-card block relative overflow-hidden">
      <span
        className={`absolute inset-y-0 left-0 rounded-[3.5px] bar-grow ${colour} ${faded ? 'opacity-50' : ''}`}
        // A floor of 2px: a bar for three rows beside one for ten thousand
        // is mathematically a hairline, and an invisible bar reads as no
        // bar at all rather than as a very small one.
        style={{ width: `max(2px, ${(Math.max(0, Math.min(1, value)) * 100).toFixed(3)}%)` }}
      />
    </span>
  );
}

function Divider({
  label,
  note,
  accent,
}: {
  label: string;
  note: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2.5 pt-3 pb-1">
      <span className={`text-[10.5px] font-medium ${accent ? 'text-accent' : 'text-ink-muted'}`}>
        {label}
      </span>
      <span
        className="h-px flex-1"
        style={{ background: accent ? 'rgb(var(--c-accent) / 0.28)' : 'var(--c-rule)' }}
      />
      <span className="text-[10.5px] text-ink-faint">{note}</span>
    </div>
  );
}

function Head({ children, className = '' }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <span className={`text-[10px] uppercase tracking-[0.04em] text-ink-faint ${className}`}>
      {children}
    </span>
  );
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0">
      <path
        d={open ? 'M1.5 3 L5 7 L8.5 3' : 'M3 1.5 L7 5 L3 8.5'}
        stroke="rgb(var(--c-ink-muted))"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
