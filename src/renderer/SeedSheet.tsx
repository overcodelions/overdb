import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiTool, Cell, SeedSize, SeedStep } from '@shared/types';
import type { GateCheck } from '@shared/seedGate';
import { repoLinkOwner } from '@shared/overcliHandoff';
import { bareTicketKey } from '@shared/seedSql';
import { useStore } from './store';
import { useSeed, type SeedPhase } from './seedStore';

// The Seed for a ticket sheet. The flow and every rule it keeps live in
// seedStore.ts; this file only draws it.

const PHASES: Array<{ id: SeedPhase; name: string }> = [
  { id: 'describe', name: 'Describe' },
  { id: 'investigate', name: 'Investigate' },
  { id: 'plan', name: 'Plan' },
  { id: 'sql', name: 'SQL' },
  { id: 'run', name: 'Run' },
];

const SIZES: Array<{ id: SeedSize; label: string }> = [
  { id: 'minimal', label: 'Just enough' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'volume', label: 'Volume' },
];

const BTN = 'h-7 px-3 rounded-[5px] border border-card text-[12px] text-ink hover:bg-wash-strong disabled:opacity-40';
const PRIMARY =
  'h-7 px-3.5 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-[12px] font-semibold disabled:opacity-40 flex items-center gap-2';
const LABEL = 'text-[11px] font-semibold text-ink-muted';
const CARD = 'rounded-md border border-card bg-card';

/// `/Users/you/code/shop` → `~/code/shop`. The window has no homedir, and
/// the full path is noise in a sentence.
function tildify(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function Sparkle({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

function Check({ ok }: { ok: boolean | null }): JSX.Element {
  if (ok === null) {
    return <span className="mt-[3px] w-3.5 h-3.5 shrink-0 rounded-full border-2 border-ink-muted/40 border-t-ink-muted animate-spin" aria-label="Checking" />;
  }
  return ok ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-px text-good" aria-label="Passed">
      <path d="M5 12l5 5L20 7" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0 mt-px text-bad" aria-label="Failed">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function Spinner(): JSX.Element {
  return <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-ai/30 border-t-ai animate-spin" aria-hidden="true" />;
}

/// Seconds since `from`, ticking.
function useElapsed(from: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!from) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [from]);
  return from ? Math.max(0, Math.round((now - from) / 1000)) : 0;
}

export function SeedSheet({ connectionId }: { connectionId: string }): JSX.Element {
  const conn = useStore((s) => s.connections.find((c) => c.id === connectionId));
  const setSheet = useStore((s) => s.setSheet);
  const seed = useSeed();

  useEffect(() => {
    void useSeed.getState().open(connectionId);
  }, [connectionId]);

  // Leaving by any route — Escape, the backdrop, the close button — stops a
  // model in flight and rolls back a seed nobody committed.
  useEffect(() => () => void useSeed.getState().close(), []);

  const blocked = !seed.checking && (seed.gateError !== null || (seed.gate !== null && !seed.gate.ok));
  const title = seed.need.trim().split('\n')[0]?.trim();

  return (
    <div className="flex flex-col min-h-0 h-full text-[12px] text-ink">
      <div className="shrink-0 flex items-center gap-3 px-5 pt-4 pb-3">
        <Sparkle className="text-ai" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Seed for a ticket</h2>
          <p className="text-[11px] text-ink-muted mt-0.5 truncate">
            {seed.phase !== 'describe' && title
              ? title
              : 'Nothing is written until you run it, and nothing is committed until you say so.'}
          </p>
        </div>
        {conn && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-[5px] border ${blocked ? 'border-bad/30 bg-bad/5' : 'border-card bg-card'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${blocked ? 'bg-bad' : 'bg-good'}`} />
            <span className="font-mono text-[11px]">{conn.name}</span>
            <span className={`text-[10px] font-semibold px-1.5 rounded-[3px] ${conn.env === 'local' ? 'text-good bg-good/10' : 'text-warn-strong bg-warn/10'}`}>
              {conn.env}
            </span>
          </div>
        )}
        <button aria-label="Close" onClick={() => setSheet(null)} className="w-[26px] h-[26px] rounded-[5px] text-ink-muted hover:text-ink hover:bg-wash-strong flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      {blocked && conn ? (
        <Blocked connectionName={conn.name} />
      ) : (
        <>
          <Stepper phase={seed.phase} />
          {seed.phase === 'describe' && <Describe />}
          {seed.phase === 'investigate' && <Investigate />}
          {seed.phase === 'plan' && <Plan />}
          {seed.phase === 'sql' && <Sql />}
          {seed.phase === 'run' && <Run />}
        </>
      )}
    </div>
  );
}

function Stepper({ phase }: { phase: SeedPhase }): JSX.Element {
  const at = PHASES.findIndex((p) => p.id === phase);
  return (
    <ol className="shrink-0 flex items-center gap-1 px-5 pb-3 border-b border-card" aria-label="Steps">
      {PHASES.map((p, i) => {
        const done = i < at;
        const here = i === at;
        return (
          <li
            key={p.id}
            aria-current={here ? 'step' : undefined}
            className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full ${here ? 'bg-accent/15' : ''}`}
          >
            <span
              className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold ${
                done ? 'bg-good/15 text-good' : here ? 'bg-accent-strong text-white' : 'bg-wash-strong text-ink-muted'
              }`}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={`text-[11px] font-semibold ${here ? 'text-ink' : 'text-ink-muted'}`}>{p.name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Footer({ children, note }: { children: React.ReactNode; note?: React.ReactNode }): JSX.Element {
  return (
    <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-card bg-surface-muted/60">
      <div className="flex-1 min-w-0 text-[11px] text-ink-muted truncate">{note}</div>
      {children}
    </div>
  );
}

function ErrorLine({ text, problems = [] }: { text: string | null; problems?: string[] }): JSX.Element | null {
  if (!text && !problems.length) return null;
  return (
    <div role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-[12px] text-bad-strong">
      {text && <p>{text}</p>}
      {problems.length > 0 && (
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

// ---- describe -----------------------------------------------------------

function GateList({ checks }: { checks: GateCheck[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2 items-start">
          <Check ok={c.ok} />
          <div className="min-w-0">
            <div className={c.ok === false ? 'font-semibold' : ''}>{c.label}</div>
            {c.detail && <div className={`text-[11px] mt-0.5 ${c.ok === false ? 'font-mono text-ink-muted' : 'text-ink-muted'}`}>{c.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Describe(): JSX.Element {
  const seed = useSeed();
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const linkRepos = useStore((s) => s.linkRepos);
  const installed = (['claude', 'codex', 'gemini'] as AiTool[]).filter((t) => seed.tools?.[t]);
  const passed = seed.gate?.checks.filter((c) => c.ok).length ?? 0;
  const total = seed.gate?.checks.length ?? 0;
  const canGo = !!seed.gate?.ok && !!seed.tool && seed.need.trim().length > 0;
  const bareTicket = bareTicketKey(seed.need);
  const readsCode = !!seed.repo && seed.tool === 'claude' && seed.readRepo;

  const linkRepo = async () => {
    if (!seed.connectionId) return;
    const owner = repoLinkOwner(seed.connectionId, connections, envSets);
    if (!owner) return;
    const picked = await window.overdb.invoke('overcli:pickRepo', { name: owner.name });
    if (!picked) return;
    await linkRepos(owner, [picked]);
    await useSeed.getState().recheck();
  };

  return (
    <>
      <div className="flex-1 min-h-0 flex gap-5 px-5 py-4 overflow-y-auto">
        <div className="flex-1 min-w-0 flex flex-col gap-3.5">
          <div className="flex-1 flex flex-col gap-1.5 min-h-[220px]">
            <label htmlFor="seed-need" className={LABEL}>What do you need to test?</label>
            <textarea
              id="seed-need"
              autoFocus
              value={seed.need}
              onChange={(e) => seed.setNeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGo) {
                  e.preventDefault();
                  void seed.investigate();
                }
              }}
              placeholder={'Paste the ticket, or describe the state you need.\n\nSHOP-418 — Free shipping for gold customers. Check the boundary at exactly $50.00, and that a gold customer just under it still pays.'}
              className="field flex-1 resize-none px-3 py-2.5 font-mono text-[12px] leading-relaxed"
            />
            {bareTicket && (
              <p role="status" className="text-[11px] leading-relaxed rounded-md border border-warn/30 bg-warn/5 px-2.5 py-1.5">
                The model can’t open <span className="font-mono">{bareTicket}</span> — it has no access to your tracker.
                Paste the ticket’s description and acceptance criteria, or say what state you need.
              </p>
            )}
            <p className="text-[11px] text-ink-muted leading-relaxed">
              Goes to <span className="font-mono text-ink">{seed.tool ?? 'the model'}</span> with the schema, row counts
              {readsCode ? ' and what it reads in the repo' : ''} — never your rows.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL} id="seed-size">How much data</span>
            <div role="radiogroup" aria-labelledby="seed-size" className="self-start flex rounded-[5px] border border-card overflow-hidden">
              {SIZES.map((s, i) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={seed.size === s.id}
                  onClick={() => seed.setSize(s.id)}
                  className={`h-7 px-3 text-[12px] ${i ? 'border-l border-card' : ''} ${
                    seed.size === s.id ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="w-[340px] shrink-0 flex flex-col gap-3">
          <div className={`${CARD} p-3`}>
            <div className="flex items-center justify-between mb-2.5">
              <span className={LABEL}>Safe to seed?</span>
              {seed.gate && (
                <span className={`text-[10px] font-semibold ${seed.gate.ok ? 'text-good' : 'text-ink-muted'}`}>
                  {passed} of {total}
                </span>
              )}
            </div>
            {seed.gate ? <GateList checks={seed.gate.checks} /> : <GateList checks={[{ id: 'size', ok: null, label: 'Checking this connection…' }]} />}
          </div>

          {seed.repo ? (
            <div className={`${CARD} p-3 flex flex-col gap-2`}>
              <div className="flex items-center justify-between">
                <span className={LABEL}>Reads the code in</span>
                <button onClick={() => void linkRepo()} className="text-[11px] text-accent hover:underline">Change</button>
              </div>
              <div className="font-mono text-[11px] truncate" title={seed.repo}>{tildify(seed.repo)}</div>
              {seed.tool === 'claude' ? (
                <>
                  <label className="flex items-center gap-2 text-[12px]">
                    <input type="checkbox" checked={seed.readRepo} onChange={(e) => seed.setReadRepo(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
                    Read the code while planning
                  </label>
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    Read, Grep and Glob only, inside this folder. No shell, no MCP servers, and <span className="font-mono">.env</span> files are denied — it can’t reach the database.
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  Reading code needs <span className="font-mono">claude</span>, the one CLI that can be held to read-only tools with no shell. {seed.tool} plans from the schema alone.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-warn/30 bg-warn/5 p-3 flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-warn-strong">Schema only — no repo linked</span>
              <p className="text-[11px] leading-relaxed">
                Allowed status values, JSON shapes and app rules won’t be known, so the rows may insert cleanly and still not produce the screen you need.
              </p>
              <button onClick={() => void linkRepo()} className={`${BTN} self-start h-[26px] px-2.5 text-[11px]`}>Link a repo…</button>
            </div>
          )}

          {installed.length === 0 && seed.tools && (
            <div className="rounded-md border border-warn/30 bg-warn/5 p-3 text-[11px] leading-relaxed">
              No AI CLI found. Install and log in to <span className="font-mono">claude</span>, <span className="font-mono">codex</span> or <span className="font-mono">gemini</span> to use this.
            </div>
          )}
        </div>
      </div>

      <Footer
        note={
          installed.length > 1 ? (
            <label className="flex items-center gap-1.5">
              Model:
              <select value={seed.tool ?? ''} onChange={(e) => seed.setTool(e.target.value as AiTool)} className="field px-1.5 py-0.5 text-[11px]">
                {installed.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              on your login
            </label>
          ) : seed.tool ? (
            <>Model: <span className="font-mono text-ink">{seed.tool}</span> on your login</>
          ) : null
        }
      >
        <button className={BTN} onClick={() => useStore.getState().setSheet(null)}>Cancel</button>
        <button className={PRIMARY} disabled={!canGo} onClick={() => void seed.investigate()}>
          Investigate <span className="font-mono text-[10px] opacity-80">⌘↵</span>
        </button>
      </Footer>
    </>
  );
}

// ---- blocked ------------------------------------------------------------

function Blocked({ connectionName }: { connectionName: string }): JSX.Element {
  const seed = useSeed();
  const connections = useStore((s) => s.connections);
  const setSheet = useStore((s) => s.setSheet);
  const setWrites = useStore((s) => s.setWrites);
  const others = connections.filter((c) => c.env === 'local' && c.engine !== 'dynamodb' && c.id !== seed.connectionId);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const onlyWrites = seed.gate?.checks.filter((c) => c.ok === false).every((c) => c.id === 'writes') ?? false;
  const machine = seed.gate?.checks.find((c) => c.id === 'machine');
  const size = seed.gate?.checks.find((c) => c.id === 'size');

  const why =
    seed.gateError ??
    (onlyWrites
      ? 'Writes are off for this connection. Seeding needs them on — it is a local connection, so that is one click.'
      : machine?.ok === false && machine.label.includes('tunnel')
        ? 'Its host looks local, but that port is an SSH tunnel. The database behind it is somewhere else.'
        : machine?.ok === false && machine.label.startsWith('Port-forwarded')
          ? 'Its host looks local, but the process holding that port forwards it to a server somewhere else.'
          : size?.ok === false
            ? 'overdb couldn’t see which process is listening on that port — usually a server running as another user — so size is the only check left, and a table this size doesn’t belong to a scratch database. A port forward looks exactly like a local server from here.'
            : 'Seeding only runs against a database on this machine that you already treat as scratch.');

  const turnOnWrites = async () => {
    if (!seed.connectionId) return;
    const problem = await setWrites(seed.connectionId, true);
    if (!problem) await seed.recheck();
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-10 py-7 flex flex-col gap-5 border-t border-card">
        <div className="flex gap-3.5 items-start">
          <div className="w-9 h-9 shrink-0 rounded-full bg-bad/10 flex items-center justify-center text-bad">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-base font-semibold">{connectionName} can’t be seeded</h3>
            <p className="leading-relaxed max-w-[620px]">{why}</p>
          </div>
        </div>

        {seed.gate && (
          <div className={`${CARD} px-4 py-3.5 max-w-[680px]`}>
            <GateList checks={seed.gate.checks} />
          </div>
        )}

        {!onlyWrites && (
          <p className="text-ink-muted leading-relaxed max-w-[680px]">
            There is no override. An SSH tunnel, <span className="font-mono">kubectl port-forward</span> or a cloud SQL proxy all show up as <span className="font-mono">localhost</span>, and a wrong tag is exactly the mistake this check exists to catch. If this really is a scratch database, run it on this machine and connect to it directly.
          </p>
        )}

        {!onlyWrites && others.length > 0 && (
          <div className="flex flex-col gap-1.5 max-w-[360px]">
            <label htmlFor="seed-other" className={LABEL}>Seed a different connection</label>
            <select id="seed-other" value={other} onChange={(e) => setOther(e.target.value)} className="field h-[30px] px-2 text-[12px]">
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.env} · {c.engine === 'sqlite' ? 'SQLite' : `${c.host ?? 'localhost'}${c.port ? `:${c.port}` : ''}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <Footer>
        <button className={BTN} onClick={() => setSheet(null)}>Close</button>
        {onlyWrites ? (
          <button className={PRIMARY} onClick={() => void turnOnWrites()}>Turn writes on</button>
        ) : (
          others.length > 0 && (
            <button className={PRIMARY} disabled={!other} onClick={() => setSheet({ kind: 'seed', connectionId: other })}>
              Use {others.find((c) => c.id === other)?.name ?? 'it'}
            </button>
          )
        )}
      </Footer>
    </>
  );
}

// ---- investigate --------------------------------------------------------

const STEP_TONE: Record<SeedStep['kind'], string> = {
  schema: 'text-accent',
  count: 'text-accent',
  read: 'text-ai',
  grep: 'text-ai',
  glob: 'text-ai',
  note: 'text-ink-muted',
};

function Investigate(): JSX.Element {
  const seed = useSeed();
  const elapsed = useElapsed(seed.busy ? seed.startedAt : null);
  const log = useRef<HTMLOListElement>(null);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [seed.steps.length]);

  const reading = seed.repo && seed.tool === 'claude' && seed.readRepo;

  return (
    <>
      {seed.busy ? (
        <div className="shrink-0 flex items-center gap-2.5 px-5 py-3 bg-ai/5 border-b border-card" role="status">
          <Spinner />
          <div className="flex-1 min-w-0 truncate">
            <b className="font-semibold">Investigating</b>
            <span className="text-ink-muted">
              {' '}— reading the schema{reading ? ` and the code in ${tildify(seed.repo!)}` : ''} · {elapsed} s
            </span>
          </div>
          <button className={`${BTN} h-[26px] px-2.5 text-[11px]`} onClick={() => seed.stop()}>Stop</button>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 flex flex-col px-5 py-3 gap-3">
        <ErrorLine text={seed.error} />
        <div className={LABEL}>What it’s looking at</div>
        <ol ref={log} className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-snug flex flex-col gap-1.5" aria-live="polite">
          {seed.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className={`w-12 shrink-0 ${STEP_TONE[s.kind]}`}>{s.kind === 'note' ? '·' : s.kind}</span>
              <span className="min-w-0 break-all">{s.text}</span>
            </li>
          ))}
          {seed.busy && (
            <li className="flex gap-2 text-ink-muted">
              <span className="w-12 shrink-0">…</span>
              <span>{reading ? 'reading the code the need is about' : 'drafting the plan'}</span>
            </li>
          )}
        </ol>
        <p className="text-[11px] text-ink-muted">
          Only the names of what it opens are shown here, never the contents. Findings and the plan appear when it finishes; no SQL is written yet.
        </p>
      </div>

      <Footer>
        <button className={BTN} onClick={() => { seed.stop(); seed.setPhase('describe'); }}>Back</button>
        {seed.busy ? (
          <button className={PRIMARY} disabled>Drafting the plan…</button>
        ) : (
          <button className={PRIMARY} onClick={() => void seed.investigate()}>Try again</button>
        )}
      </Footer>
    </>
  );
}

// ---- plan ---------------------------------------------------------------

function SourceTag({ source }: { source: 'code' | 'schema' }): JSX.Element {
  return (
    <span className={`shrink-0 text-[10px] font-semibold px-1.5 rounded-[3px] ${source === 'code' ? 'bg-ai/10 text-ai' : 'bg-accent/15 text-accent'}`}>
      {source}
    </span>
  );
}

function Plan(): JSX.Element {
  const seed = useSeed();
  const [instruction, setInstruction] = useState('');
  const inv = seed.investigation!;
  const revising = seed.busy === 'revise';
  const writing = seed.busy === 'write';
  const rowCount = inv.plan.groups.reduce((n, g) => n + g.rows.length, 0);

  const revise = () => {
    const text = instruction.trim();
    if (!text) return;
    void seed.revise(text).then(() => setInstruction(''));
  };

  return (
    <>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-3.5 overflow-y-auto">
          {inv.plan.summary && <p className="text-[13px] leading-relaxed">{inv.plan.summary}</p>}

          {inv.plan.groups.map((g) => (
            <section key={g.table} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] font-semibold text-ink-muted">{g.table}</span>
                <span className="text-[11px] text-ink-muted">{g.rows.length} line{g.rows.length === 1 ? '' : 's'}</span>
              </div>
              <ul className={`${CARD} divide-y divide-rule`}>
                {g.rows.map((r, i) => (
                  <li key={i} className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-4 px-3 py-1.5">
                    <span className="truncate" title={r.label}>{r.label}</span>
                    <span className="text-ink-muted">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {inv.plan.note && <p className="text-[11px] text-ink-muted leading-relaxed">{inv.plan.note}</p>}

          <ErrorLine text={seed.error} problems={seed.problems} />

          <div className="mt-auto flex gap-2 pt-1">
            <label htmlFor="seed-revise" className="sr-only">Change the plan</label>
            <input
              id="seed-revise"
              value={instruction}
              disabled={revising || writing}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') revise(); }}
              placeholder="Change the plan — e.g. “add a gold customer with an unpaid $60 order”"
              className="field flex-1 h-[30px] px-2.5 text-[12px]"
            />
            <button className={BTN} disabled={!instruction.trim() || revising || writing} onClick={revise}>
              {revising ? 'Revising…' : 'Revise'}
            </button>
          </div>
        </div>

        <aside className="w-[380px] shrink-0 border-l border-card p-4 flex flex-col gap-4 overflow-y-auto">
          {inv.plan.assumptions.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className={LABEL}>Check these first</h3>
              {inv.plan.assumptions.map((a, i) => {
                const ok = seed.confirmed.includes(i);
                return (
                  <div key={i} className={`rounded-md border p-2.5 flex flex-col gap-2 ${ok ? 'border-card bg-card' : 'border-warn/30 bg-warn/5'}`}>
                    <p className="leading-snug">{a}</p>
                    {ok ? (
                      <span className="text-[11px] text-good">Confirmed</span>
                    ) : (
                      <div className="flex gap-1.5">
                        <button className={`${BTN} h-6 px-2.5 text-[11px]`} onClick={() => seed.confirm(i)}>That’s right</button>
                        <button className="h-6 px-2 text-[11px] text-accent hover:underline" onClick={() => setInstruction(`Not quite: ${a} — `)}>Change</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {inv.findings.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className={LABEL}>Rules it will follow</h3>
              <ul className="flex flex-col gap-2 leading-snug">
                {inv.findings.map((f, i) => (
                  <li key={i} className="flex gap-2">
                    <SourceTag source={f.source} />
                    <div className="min-w-0">
                      <div>{f.text}</div>
                      {f.ref && <div className="font-mono text-[10.5px] text-ink-muted break-all mt-0.5">{f.ref}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-1.5">
            <h3 className={LABEL}>How it cleans up</h3>
            <p className="leading-relaxed">{inv.marker} The teardown deletes only those.</p>
          </section>

          {!seed.readCode && (
            <p className="text-[11px] text-ink-muted leading-relaxed">Planned from the schema alone — nothing in the code was checked.</p>
          )}
        </aside>
      </div>

      <Footer note={`${rowCount} line${rowCount === 1 ? '' : 's'} across ${inv.plan.groups.length} table${inv.plan.groups.length === 1 ? '' : 's'}`}>
        <button className={BTN} disabled={writing} onClick={() => seed.setPhase('describe')}>Back</button>
        {writing ? (
          <>
            <button className={BTN} onClick={() => seed.stop()}>Stop</button>
            <button className={PRIMARY} disabled><Spinner /> Writing the SQL…</button>
          </>
        ) : (
          <button className={PRIMARY} disabled={revising} onClick={() => void seed.writeSql()}>Write the SQL</button>
        )}
      </Footer>
    </>
  );
}

// ---- sql ----------------------------------------------------------------

const KEYWORDS = /^(insert|into|values|delete|from|where|select|join|left|inner|on|and|or|not|null|as|in|like|order|by|group|limit|is|case|when|then|else|end|true|false|distinct|exists)$/i;

/// Just enough colour to read by: keywords, strings, numbers, comments.
function highlight(sql: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]+)|([^A-Za-z_'\-\d]+|-)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(sql))) {
    const [t, comment, str, num, word] = m;
    const cls = comment ? 'text-ink-muted italic' : str ? 'text-[rgb(var(--c-sql-string))]' : num ? 'text-[rgb(var(--c-sql-number))]' : word && KEYWORDS.test(word) ? 'text-accent' : '';
    out.push(cls ? <span key={i++} className={cls}>{t}</span> : <span key={i++}>{t}</span>);
  }
  return out;
}

function Sql(): JSX.Element {
  const seed = useSeed();
  const txnOpen = useStore((s) => (seed.connectionId ? s.txnState[seed.connectionId]?.open : false));
  const [tab, setTab] = useState<'seed' | 'teardown' | 'verify'>('seed');
  const script = seed.script!;
  const check = seed.check!;
  const body = tab === 'seed' ? script.seed : tab === 'teardown' ? script.teardown : script.verify;
  const lit = useMemo(() => highlight(body), [body]);
  const rows = check.perTable.reduce((n, p) => n + p.rows, 0);

  return (
    <>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div role="tablist" aria-label="Script" className="shrink-0 flex gap-0.5 px-5 pt-2.5 border-b border-rule">
            {(['seed', 'teardown', 'verify'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                disabled={t === 'verify' && !script.verify}
                className={`h-[30px] px-3 text-[12px] border-b-2 capitalize disabled:opacity-40 ${tab === t ? 'border-accent text-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <pre className="flex-1 min-h-0 m-0 px-5 py-3.5 overflow-auto font-mono text-[11px] leading-relaxed bg-surface-muted whitespace-pre">{lit}</pre>
        </div>

        <aside className="w-[300px] shrink-0 border-l border-card p-4 flex flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-2">
            <h3 className={LABEL}>What it does</h3>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-warn/15 text-warn-strong">writes</span>
              <span>{check.inserts.length} INSERT{check.inserts.length === 1 ? '' : 's'} · {rows} row{rows === 1 ? '' : 's'}</span>
            </div>
            <p className="text-ink-muted leading-relaxed">No UPDATE, no DELETE, no DDL — anything else would have stopped it here. The teardown is not run; it is saved for you.</p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className={LABEL}>Insert order, from the foreign keys</h3>
            <ol className="font-mono text-[11px] flex flex-col gap-1.5">
              {check.perTable.map((p, i) => (
                <li key={p.table} className="flex gap-2">
                  <span className="w-3.5 text-ink-muted">{i + 1}</span>
                  <span className="flex-1 truncate">{p.table}</span>
                  <span className="text-ink-muted">{p.rows}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className={LABEL}>Checked before you see it</h3>
            <ul className="flex flex-col gap-1.5 leading-snug">
              {[
                'Only INSERT … VALUES, no upserts',
                `Every table and column exists on ${useStore.getState().connections.find((c) => c.id === seed.connectionId)?.name ?? 'this connection'}`,
                'Parents inserted before children',
                'Teardown is DELETE … WHERE only, children first',
              ].map((t) => (
                <li key={t} className="flex gap-1.5"><Check ok /> <span>{t}</span></li>
              ))}
            </ul>
          </section>
          {seed.error && <ErrorLine text={seed.error} />}
        </aside>
      </div>

      <Footer
        note={
          txnOpen ? (
            <span className="text-warn-strong">A transaction is already open on this connection — commit or roll it back first.</span>
          ) : (
            <button className="text-accent hover:underline" onClick={() => seed.openInEditor()}>Open in the editor instead</button>
          )
        }
      >
        <button className={BTN} onClick={() => seed.setPhase('plan')}>Back to the plan</button>
        <button className={PRIMARY} disabled={!!txnOpen} onClick={() => void seed.runSeed()}>Run in a transaction</button>
      </Footer>
    </>
  );
}

// ---- run ----------------------------------------------------------------

function cellText(c: Cell): string {
  if (c === null) return 'NULL';
  if (typeof c === 'object') return `(${c.byteLength} bytes)`;
  return String(c);
}

function Run(): JSX.Element {
  const seed = useSeed();
  const txn = useStore((s) => (seed.connectionId ? s.txnState[seed.connectionId] : undefined));
  const setSheet = useStore((s) => s.setSheet);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = seed.run!;
  const expected = run.inserted.reduce((n, r) => n + r.expected, 0);
  const affected = run.inserted.reduce((n, r) => n + (r.affected ?? 0), 0);
  const unknownCounts = run.inserted.some((r) => r.affected === null);
  const matches = !unknownCounts && affected === expected;
  const left = txn?.expiresAt ? Math.max(0, Math.round((txn.expiresAt - now) / 1000)) : null;

  const banner =
    run.status === 'running' ? (
      <div className="flex items-center gap-2.5 px-5 py-3 bg-ai/5 border-b border-card" role="status"><Spinner /> <b className="font-semibold">Inserting…</b></div>
    ) : run.status === 'open' || run.status === 'ending' ? (
      <div className="flex items-center gap-2.5 px-5 py-3 bg-warn/10 border-b border-warn/20" role="status">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-warn shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <div className="flex-1"><b className="font-semibold">Transaction open — {unknownCounts ? 'the seed is' : `${affected} rows`} inserted, nothing committed.</b> Rolls back by itself after 90 s idle.</div>
        {left !== null && <span className="font-mono text-[11px] text-warn-strong">{left} s left</span>}
      </div>
    ) : run.status === 'committed' ? (
      <div className="flex items-center gap-2.5 px-5 py-3 bg-good/10 border-b border-good/20" role="status"><Check ok /> <b className="font-semibold">Committed.</b> {seed.saveQueries ? 'The seed and its teardown are in your saved queries.' : ''}</div>
    ) : run.status === 'rolledBack' ? (
      <div className="px-5 py-3 bg-wash-strong border-b border-card" role="status"><b className="font-semibold">Rolled back.</b> Nothing was kept.</div>
    ) : run.status === 'expired' ? (
      <div className="px-5 py-3 bg-wash-strong border-b border-card" role="status"><b className="font-semibold">Rolled back after 90 s idle.</b> Nothing was kept — run it again when you’re ready.</div>
    ) : (
      <div className="px-5 py-3 bg-bad/5 border-b border-bad/20 text-bad-strong" role="alert">{run.error}</div>
    );

  return (
    <>
      <div className="shrink-0">{banner}</div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2.5">
          <div className={`${CARD} px-3 py-2.5 flex gap-2`}>
            <Check ok={run.status === 'running' ? null : run.status === 'failed' ? false : unknownCounts || matches} />
            <div>
              <div className="font-semibold">
                {unknownCounts ? 'Every insert ran' : matches ? `${affected} rows, as planned` : `${affected} of ${expected} rows`}
              </div>
              <div className="font-mono text-[11px] text-ink-muted mt-0.5">{run.inserted.map((r) => r.affected ?? '·').join(' · ')} by table</div>
            </div>
          </div>
          <div className={`${CARD} px-3 py-2.5 flex gap-2`}>
            <Check ok={run.status === 'running' ? null : run.verify ? !run.verify.error : false} />
            <div>
              <div className="font-semibold">Read back</div>
              <div className="text-[11px] text-ink-muted mt-0.5">
                {run.verify ? (run.verify.error ? 'The verify query failed' : `${run.verify.rows.length} rows, inside the transaction`) : 'No verify query'}
              </div>
            </div>
          </div>
          <div className={`${CARD} px-3 py-2.5 flex gap-2`}>
            <Check ok={run.status === 'running' ? null : run.status !== 'failed'} />
            <div>
              <div className="font-semibold">One transaction</div>
              <div className="text-[11px] text-ink-muted mt-0.5">Commit keeps all of it; anything else keeps none</div>
            </div>
          </div>
        </div>

        {run.verify && (
          <section className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2"><span className={LABEL}>What landed</span><span className="text-[11px] text-ink-muted">— read back inside the transaction</span></div>
            {run.verify.error ? (
              <ErrorLine text={run.verify.error} />
            ) : (
              <div className="rounded-md border border-card overflow-auto max-h-[260px]">
                <table className="w-full font-mono text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-surface-muted">
                    <tr>{run.verify.columns.map((c) => <th key={c.name} className="text-left font-semibold text-ink-muted px-3 py-1.5 whitespace-nowrap">{c.name}</th>)}</tr>
                  </thead>
                  <tbody>
                    {run.verify.rows.map((r, i) => (
                      <tr key={i} className="border-t border-rule odd:bg-wash">
                        {r.map((c, j) => (
                          <td key={j} className={`px-3 py-1.5 whitespace-nowrap ${run.verify!.columns[j]?.name === 'should_show' ? 'text-good' : ''}`}>{cellText(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {(run.status === 'open' || run.status === 'running') && (
          <div className={`${CARD} mt-auto p-3 flex flex-col gap-2`}>
            <span className={LABEL}>When you commit</span>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={seed.saveQueries} onChange={(e) => seed.setSaveQueries(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
              Save the seed and its teardown as saved queries
            </label>
          </div>
        )}
      </div>

      <Footer note={run.status === 'open' ? 'Closing this sheet rolls back.' : undefined}>
        {run.status === 'open' || run.status === 'ending' || run.status === 'running' ? (
          <>
            <button className={BTN} disabled={run.status !== 'open'} onClick={() => void seed.rollback()}>Roll back</button>
            <button
              className="h-7 px-3.5 rounded-[5px] bg-[rgb(4_113_82)] hover:bg-[rgb(6_95_70)] text-white text-[12px] font-semibold disabled:opacity-40"
              disabled={run.status !== 'open'}
              onClick={() => void seed.commit()}
            >
              {unknownCounts ? 'Commit' : `Commit ${affected} rows`}
            </button>
          </>
        ) : run.status === 'committed' ? (
          <button className={PRIMARY} onClick={() => setSheet(null)}>Done</button>
        ) : (
          <>
            <button className={BTN} onClick={() => setSheet(null)}>Close</button>
            <button className={PRIMARY} onClick={() => seed.setPhase('sql')}>Back to the SQL</button>
          </>
        )}
      </Footer>
    </>
  );
}
