import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AgentActivity, Connection, EnvKind } from '@shared/types';
import type { AgentContextSetting } from '@shared/agentContext';
import { useStore } from './store';
import { Agent } from './Icons';
import { ENV_DOT } from './engineTags';
import { ProdConfirm, useAgentToggle } from './WriteControls';
import { AgentContextEditor } from './AgentContextEditor';
import { activityOutcome, activityText, clientLabel, clockTime, shortPath, useAgentActivity } from './agentActivity';

/// Everything about agents in one place, because before this it was a
/// switch at the bottom of the Writes menu and a paragraph in the README.
///
/// Overview answers the questions in the order someone asks them: how do I
/// connect one, is one connected, what can it read, what has it done.
/// "What agents are told" is the briefing editor beside the exact text an
/// agent receives — the only way to know a note reads the way you meant.

type Tab = 'overview' | 'briefing';

export function AgentsSheet({ connectionId, tab: initial }: { connectionId?: string; tab: Tab }): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const [tab, setTab] = useState<Tab>(initial);
  const [briefFor, setBriefFor] = useState<string | undefined>(connectionId);
  useEffect(() => setTab(initial), [initial]);

  const brief = (id: string) => {
    setBriefFor(id);
    setTab('briefing');
  };

  return (
    <div className="flex flex-col min-h-0 h-full text-[12px] text-ink">
      <div className="shrink-0 flex items-center gap-3 px-5 pt-4 pb-3 border-b border-card">
        <Agent className="w-4 h-4 text-accent" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Agents</h2>
          <p className="text-[11px] text-ink-muted mt-0.5">Read-only access for coding agents, over MCP, to the connections you choose.</p>
        </div>
        <div role="tablist" aria-label="Agents" className="flex gap-px p-[2px] rounded-md bg-surface border border-card">
          {(
            [
              ['overview', 'Overview'],
              ['briefing', 'What agents are told'],
            ] as const
          ).map(([value, name]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`h-[24px] px-2.5 rounded-[4px] text-[11.5px] ${tab === value ? 'bg-wash-strong text-ink font-semibold' : 'text-ink-muted hover:text-ink'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <button aria-label="Close" onClick={() => setSheet(null)} className="w-[26px] h-[26px] rounded-[5px] text-ink-muted hover:text-ink hover:bg-wash-strong flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {tab === 'overview' ? <Overview onBrief={brief} /> : <Briefing connectionId={briefFor} onPick={setBriefFor} />}
    </div>
  );
}

function Overview({ onBrief }: { onBrief(id: string): void }): JSX.Element {
  const { clients, activity, loaded } = useAgentActivity(3000);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-5">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4 items-start">
        <Connect />
        <Connected />
      </div>
      <Readable activity={activity} onBrief={onBrief} />
      <Activity activity={activity} loaded={loaded} clientsConnected={clients.length > 0} />
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-card bg-surface p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold flex-1">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/// A word with a space in it, quoted for a POSIX shell.
const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function Connect(): JSX.Element {
  const { command, clients, activity } = useAgentActivity(3000);
  const connections = useStore((s) => s.connections);
  const toast = useStore((s) => s.toast);
  const [client, setClient] = useState<'claude' | 'other'>('claude');

  const text =
    client === 'claude'
      ? `claude mcp add --scope user overdb -- ${command.map(shellWord).join(' ')}`
      : JSON.stringify({ mcpServers: { overdb: { command: command[0] ?? '', args: command.slice(1) } } }, null, 2);
  const steps: Array<[boolean, React.ReactNode]> = [
    [clients.length > 0 || activity.length > 0, clients.length > 0 ? `${clientLabel(clients[0])} is connected` : 'An agent has connected'],
    [connections.some((c) => c.mcpExposed), 'At least one connection is open to agents'],
    [
      activity.some((a) => a.tool === 'query' && a.ok),
      <>
        Ask it something: <span className="text-ink">“on {connections.find((c) => c.mcpExposed)?.name ?? 'your database'}, which tables changed most this week?”</span>
      </>,
    ],
  ];

  return (
    <Card title="Connect an agent">
      <div role="tablist" aria-label="Client" className="flex gap-1">
        {(
          [
            ['claude', 'Claude Code'],
            ['other', 'Cursor and other MCP clients'],
          ] as const
        ).map(([value, name]) => (
          <button
            key={value}
            role="tab"
            aria-selected={client === value}
            onClick={() => setClient(value)}
            className={`h-[26px] px-2.5 rounded-md text-[11.5px] border ${client === value ? 'border-accent/50 bg-accent/15 text-ink' : 'border-card text-ink-muted hover:text-ink'}`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex items-start gap-2 rounded-md border border-card bg-surface-muted p-2.5">
        <pre className="flex-1 min-w-0 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{command.length ? text : '…'}</pre>
        <button
          onClick={() => {
            void window.overdb.invoke('app:copyText', text);
            toast('Copied.');
          }}
          className="shrink-0 h-[24px] px-2.5 rounded-[5px] bg-accent text-white text-[11px] font-semibold hover:bg-accent-strong"
        >
          Copy
        </button>
      </div>
      <p className="text-[11px] text-ink-muted leading-relaxed">
        {client === 'claude'
          ? 'Run it once in a terminal. Every Claude Code session then has overdb’s tools.'
          : 'Add it to the client’s MCP settings (Cursor: ~/.cursor/mcp.json).'}{' '}
        Hosted agents use your org’s server instead: publish a connection from its Agents menu.
      </p>
      <ul className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
        {steps.map(([done, what], i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className={`w-3 shrink-0 ${done ? 'text-good' : 'text-ink-faint'}`} aria-label={done ? 'Done' : 'Not yet'}>
              {done ? '✓' : '○'}
            </span>
            <span>{what}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Connected(): JSX.Element {
  const { clients, activity } = useAgentActivity(3000);
  // Filtered outside the selector: zustand 5 re-renders whenever a selector
  // returns something new, and a fresh array is new every time — a loop.
  const connections = useStore((s) => s.connections);
  const published = useMemo(() => connections.filter((c) => c.orgPublishedAt), [connections]);
  return (
    <Card title="Who’s connected">
      {clients.length === 0 ? (
        <p className="text-[11.5px] text-ink-muted leading-relaxed">
          No agent is connected now. An agent starts overdb itself when it needs it, so this fills in once one is working.
        </p>
      ) : (
        <ul className="flex flex-col">
          {clients.map((c) => {
            const calls = activity.filter((a) => a.pid === c.pid).length;
            return (
              <li key={c.pid} className="flex items-center gap-2.5 py-2 border-b border-card last:border-b-0">
                <span className="w-2 h-2 rounded-full bg-good shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{clientLabel(c)}</div>
                  <div className="text-[11px] text-ink-muted truncate" title={c.cwd}>
                    {shortPath(c.cwd)} · since {clockTime(c.since)}
                  </div>
                </div>
                <span className="text-[11px] text-ink-muted tabular-nums">
                  {calls} call{calls === 1 ? '' : 's'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2.5 pt-1 text-[11.5px]">
        <span className="w-2 h-2 rounded-full border border-ink-faint shrink-0" />
        <span className="flex-1 min-w-0 text-ink-muted">
          Org server: {published.length ? published.map((c) => c.name).join(', ') : 'nothing published'}
        </span>
      </div>
    </Card>
  );
}

const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
const ENV_LABEL: Record<EnvKind, string> = { local: 'Local', dev: 'Dev', sandbox: 'Sandbox', staging: 'Staging', prod: 'Prod', other: 'Other' };

/// The connections agents can read, and below them, folded away, the rest.
///
/// Folded because most connections are not open to agents, and listing all
/// of them pushed the activity log — the part you come back for — off the
/// sheet. The rest are grouped by environment, as in the sidebar, so prod
/// reads as prod before you reach for its switch. Branches are left out:
/// a branch is a scratch copy, not something to hand an agent, unless it
/// already is.
function Readable({ activity, onBrief }: { activity: AgentActivity[]; onBrief(id: string): void }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const [adding, setAdding] = useState(false);
  const open = useMemo(() => connections.filter((c) => c.mcpExposed).sort((a, b) => a.name.localeCompare(b.name)), [connections]);
  const groups = useMemo(() => {
    const rest = connections.filter((c) => !c.mcpExposed && !c.branchOf);
    return ENV_ORDER.map((env) => ({
      env,
      rows: rest.filter((c) => (c.env ?? 'other') === env).sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.rows.length);
  }, [connections]);
  const restCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const counts = new Map<string, number>();
  for (const a of activity) if (a.at >= dayAgo) counts.set(a.connection, (counts.get(a.connection) ?? 0) + 1);

  return (
    <Card title="What agents can read" aside={<span className="text-[11px] text-ink-muted">Read-only, always. Prod asks for the connection’s name.</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[11.5px] border-collapse table-fixed">
          <colgroup>
            <col />
            <col className="w-[260px]" />
            <col className="w-[120px]" />
            <col className="w-[90px]" />
            <col className="w-[120px]" />
          </colgroup>
          <thead>
            <tr className="text-left text-[10.5px] text-ink-faint">
              <th className="py-1.5 pr-3 font-medium">Connection</th>
              <th className="py-1.5 pr-3 font-medium">Agents</th>
              <th className="py-1.5 pr-3 font-medium">Where</th>
              <th className="py-1.5 pr-3 font-medium">Last 24 h</th>
              <th className="py-1.5 font-medium">
                <span className="sr-only">Briefing</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && (
              <tr className="border-t border-card">
                <td colSpan={5} className="py-2.5 text-ink-muted">
                  None yet. Agents see nothing until you turn a connection on.
                </td>
              </tr>
            )}
            {open.map((c) => (
              <ReadableRow key={c.id} conn={c} calls={counts.get(c.name) ?? 0} onBrief={() => onBrief(c.id)} />
            ))}
            {restCount > 0 && (
              <tr className="border-t border-card">
                <td colSpan={5} className="py-2">
                  <button onClick={() => setAdding((v) => !v)} aria-expanded={adding} className="text-accent hover:underline">
                    {adding ? 'Hide the others' : `Give agents another connection (${restCount})`}
                  </button>
                </td>
              </tr>
            )}
            {adding &&
              groups.map((g) => (
                <Fragment key={g.env}>
                  <tr>
                    <td colSpan={5} className="pt-3 pb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                      {ENV_LABEL[g.env]}
                    </td>
                  </tr>
                  {g.rows.map((c) => (
                    <ReadableRow key={c.id} conn={c} calls={0} onBrief={() => onBrief(c.id)} />
                  ))}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ReadableRow({ conn, calls, onBrief }: { conn: Connection; calls: number; onBrief(): void }): JSX.Element {
  const agents = useAgentToggle(conn);
  const toggle = async () => {
    if (agents.exposed) return void agents.disable();
    if (conn.env === 'prod') return agents.begin();
    await agents.enable();
  };
  const where = [conn.mcpExposed ? 'This Mac' : null, conn.orgPublishedAt ? 'org server' : null].filter(Boolean).join(' · ');
  return (
    <tr className="border-t border-card align-middle">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${conn.env ? ENV_DOT[conn.env] : 'bg-ink-faint'}`} />
          <span className="font-medium truncate" title={conn.name}>
            {conn.name}
          </span>
          <span className="text-ink-faint shrink-0">{conn.engine}</span>
        </div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <button
            role="switch"
            aria-checked={agents.exposed}
            aria-label={`Agents can read ${conn.name}`}
            onClick={() => void toggle()}
            className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${agents.exposed ? 'bg-accent' : 'bg-wash-strong border border-card'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${agents.exposed ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          {agents.confirming && <ProdConfirm conn={conn} gate={agents} />}
        </div>
      </td>
      <td className="py-2 pr-3 text-ink-muted">{where || '—'}</td>
      <td className="py-2 pr-3 text-ink-muted tabular-nums">{calls ? `${calls} call${calls === 1 ? '' : 's'}` : '—'}</td>
      <td className="py-2 text-right">
        {conn.mcpExposed && (
          <button onClick={onBrief} className="text-accent hover:underline whitespace-nowrap">
            What they’re told
          </button>
        )}
      </td>
    </tr>
  );
}

type Filter = 'all' | 'refused' | 'slow';
const SLOW_MS = 5000;

function Activity({ activity, loaded, clientsConnected }: { activity: AgentActivity[]; loaded: boolean; clientsConnected: boolean }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [filter, setFilter] = useState<Filter>('all');
  const refused = activity.filter((a) => !a.ok);
  const slow = activity.filter((a) => a.ms >= SLOW_MS);
  const shown = filter === 'refused' ? refused : filter === 'slow' ? slow : activity;

  return (
    <Card
      title="Activity"
      aside={
        <div className="flex gap-1">
          {(
            [
              ['all', 'All', activity.length],
              ['refused', 'Refused or failed', refused.length],
              ['slow', 'Over 5 s', slow.length],
            ] as const
          ).map(([value, name, n]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`h-[24px] px-2 rounded-md text-[11px] border ${filter === value ? 'border-accent/50 bg-accent/15 text-ink' : 'border-card text-ink-muted hover:text-ink'}`}
            >
              {name}
              {value !== 'all' && n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
            </button>
          ))}
        </div>
      }
    >
      {!loaded ? (
        <p className="text-ink-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-[11.5px] text-ink-muted">
          {filter !== 'all'
            ? 'None.'
            : clientsConnected
              ? 'An agent is connected but hasn’t called anything yet.'
              : 'Nothing yet. Each call an agent makes shows here: the tool, the connection, the statement and how it went. Never the rows.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((a, i) => (
            <li key={`${a.at}-${i}`} className="group flex items-baseline gap-3 py-1.5 border-t border-card first:border-t-0 text-[11.5px]">
              <span className="w-11 shrink-0 text-ink-faint tabular-nums" title={new Date(a.at).toLocaleString()}>
                {clockTime(a.at)}
              </span>
              <span className="w-32 shrink-0 truncate text-ink-muted" title={a.connection}>
                {a.connection}
              </span>
              <span className="w-28 shrink-0 truncate font-mono text-[10.5px] text-accent" title={a.client ? clientLabel(a) : undefined}>
                {a.tool}
              </span>
              <code className="flex-1 min-w-0 truncate font-mono text-[10.5px]" title={a.error ?? activityText(a)}>
                {activityText(a)}
              </code>
              <span className={`shrink-0 ${!a.ok ? 'text-bad-strong' : a.truncated || a.ms >= SLOW_MS ? 'text-warn-strong' : 'text-ink-faint'}`} title={a.error}>
                {activityOutcome(a)}
              </span>
              {a.sql && (
                <button
                  onClick={() => {
                    void window.overdb.invoke('app:copyText', a.sql!);
                    toast('Copied the statement.');
                  }}
                  className="shrink-0 text-[11px] text-accent opacity-0 group-hover:opacity-100 focus:opacity-100 hover:underline"
                >
                  Copy
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Briefing({ connectionId, onPick }: { connectionId?: string; onPick(id: string): void }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const conn = connections.find((c) => c.id === connectionId) ?? connections.find((c) => c.mcpExposed) ?? connections[0];
  const [view, setView] = useState<'connect' | 'question'>('connect');
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [preview, setPreview] = useState<{ instructions: string; describe: string } | { error: string } | null>(null);
  const [version, setVersion] = useState(0);
  // The form as it stands, unsaved: the preview follows it, not the file,
  // so a tenancy rule or a note shows up as you choose it.
  const [draft, setDraft] = useState<AgentContextSetting | null>(null);
  const draftKey = JSON.stringify(draft);
  useEffect(() => setDraft(null), [conn?.id]);

  useEffect(() => {
    if (!conn) return;
    let stale = false;
    // A beat after typing stops: notes change a key at a time.
    const id = setTimeout(() => {
      void window.overdb
        .invoke('agents:preview', { connectionId: conn.id, ...(asked ? { question: asked } : {}), ...(draft ? { draft } : {}) })
        .then((r) => {
          if (stale) return;
          setPreview(r.ok ? { instructions: r.instructions, describe: r.describe } : { error: r.error });
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, asked, version, draftKey]);

  if (!conn) return <div className="p-5 text-ink-muted">No connections yet.</div>;

  const text = !preview ? '…' : 'error' in preview ? preview.error : view === 'connect' ? preview.instructions : preview.describe;

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-4 border-r border-card">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-ink-muted">Connection</span>
          <select value={conn.id} onChange={(e) => onPick(e.target.value)} className="field px-1.5 py-1 text-[12px]">
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.mcpExposed ? '' : ' (hidden from agents)'}
              </option>
            ))}
          </select>
        </label>
        {!conn.mcpExposed && (
          <p className="rounded-md border border-card bg-surface px-3 py-2 text-[11.5px] text-ink-muted">
            Agents can’t see {conn.name} yet. What you set here applies once you turn it on.
          </p>
        )}
        <AgentContextEditor key={conn.id} conn={conn} alwaysEditing onDraft={setDraft} onSaved={() => setVersion((v) => v + 1)} />
      </div>

      <div className="min-h-0 flex flex-col bg-surface-muted">
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-card">
          <h3 className="text-[12px] font-semibold flex-1">
            Exactly what an agent receives
            {draft && <span className="ml-2 font-normal text-warn-strong">· with your unsaved changes</span>}
          </h3>
          <div role="tablist" aria-label="Preview" className="flex gap-1">
            {(
              [
                ['connect', 'As it connects'],
                ['question', 'For a question'],
              ] as const
            ).map(([value, name]) => (
              <button
                key={value}
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
                className={`h-[24px] px-2 rounded-md text-[11px] border ${view === value ? 'border-accent/50 bg-accent/15 text-ink' : 'border-card text-ink-muted hover:text-ink'}`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        {view === 'question' && (
          <form
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-card"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(question.trim());
            }}
          >
            <label htmlFor="agents-question" className="text-[11px] text-ink-muted shrink-0">
              describe_database
            </label>
            <input
              id="agents-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="A question, as an agent would ask it — blank for the overview"
              className="field flex-1 min-w-0 px-2 py-1 text-[11.5px]"
            />
            <button type="submit" className="h-[24px] px-2.5 rounded-[5px] border border-accent/50 bg-accent/15 text-[11px]">
              Show
            </button>
          </form>
        )}
        <pre className="flex-1 min-h-0 overflow-y-auto m-0 px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{text}</pre>
        <p className="shrink-0 px-4 py-2 border-t border-card text-[10.5px] text-ink-faint">
          {view === 'connect'
            ? 'Sent once, as the agent connects, with every connection it can read. Notes are cut to fit.'
            : 'What describe_database answers. The map’s age is checked against the catalog only while this connection is open here.'}
        </p>
      </div>
    </div>
  );
}
