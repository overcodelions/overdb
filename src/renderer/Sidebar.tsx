import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, EnvKind, EnvSet } from '@shared/types';
import { variantLabel } from '@shared/engines';
import type { Variant } from '@shared/engines';
import { useStore } from './store';
import { EnvSetSuggestion } from './Welcome';
import { TAG_MONO, TAG_TEXT } from './engineTags';
import { middleTruncate, nameBudget } from '@shared/truncate';
import { useTickets } from './ticketsStore';
import { Branches } from './TicketSection';
import { devInstanceRefusal, isProxyConnectionId } from '@shared/instances';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { MAP_TAB, openPane } from './queryStore';
import { Agent } from './Icons';
import { agentReach } from '@shared/hostedConnection';

/// Which sections the user has folded away. Per-viewer convenience, so it
/// lives in the browser rather than the app store — and every access is
/// guarded, because a private window or blocked site data makes these
/// throw rather than return empty.
const COLLAPSE_KEY = 'overdb.sidebar.collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/// Everything about a connection someone might type to find it: not just
/// the name, because half of these are called "localhost".
function haystack(c: Connection): string {
  return [c.name, c.host, c.database, c.env, c.engine, c.variant, c.user]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const ENV_KEY = 'overdb.sidebar.env';

function loadEnv(): EnvKind | 'all' {
  try {
    return (localStorage.getItem(ENV_KEY) as EnvKind | 'all' | null) ?? 'all';
  } catch {
    return 'all';
  }
}

// Environment order is deliberate and fixed: it reads the way work flows,
// and it puts prod last, where it is hardest to click by accident.
const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
const ENV_NAME: Record<EnvKind, string> = { local: 'Local', dev: 'Dev', sandbox: 'Sandbox', staging: 'Staging', prod: 'Prod', other: 'Other' };

/// The sidebar is two questions: which environment you are in, then which
/// database. The switch at the top answers the first — you work in one at a
/// time, and a team with five connections per environment cannot see them
/// all at once anyway. Every connection is listed under its environment,
/// whether or not a set holds it; environment sets (one database, in each
/// place) are how you compare, so they sit in a dock below the list.
/// Branches nest under the connection they came from.
export function Sidebar(): JSX.Element {
  const allConnections = useStore((s) => s.connections);
  const ticketState = useTickets();
  // Branches and the proxy's own connection show under their source, not as
  // connections of their own.
  const ticketConnIds = useMemo(() => new Set(ticketState.tickets.map((t) => t.connectionId)), [ticketState.tickets]);
  const connections = useMemo(
    () => allConnections.filter((c) => !ticketConnIds.has(c.id) && !isProxyConnectionId(c.id)),
    [allConnections, ticketConnIds],
  );
  const groups = useStore((s) => s.groups);
  const envSets = useStore((s) => s.envSets);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);

  const [query, setQuery] = useState('');
  const [starred, setStarred] = useState(false);
  const [env, setEnv] = useState<EnvKind | 'all'>(loadEnv);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // Losing fold state costs nothing; failing to render the nav does not.
    }
  }, [collapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(ENV_KEY, env);
    } catch {
      // As above.
    }
  }, [env]);

  // ⌘F puts the cursor in the filter from anywhere. Finding one connection
  // among twenty by scrolling is the thing this replaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const envs = ENV_ORDER.filter((e) => connections.some((c) => c.env === e));
  const showTabs = envs.length > 1;
  const current: EnvKind | 'all' = showTabs && env !== 'all' && envs.includes(env) ? env : 'all';

  // Opening a connection from elsewhere (the palette, a shortcut, a branch)
  // that this tab hides moves to its environment, so the row you are on is
  // always one you can see.
  useEffect(() => {
    if (selection?.kind !== 'connection' || current === 'all') return;
    const c = connections.find((x) => x.id === selection.id);
    if (c && c.env !== current) setEnv(c.env);
    const t = ticketState.tickets.find((x) => x.connectionId === selection.id);
    const src = t && connections.find((x) => x.id === t.sourceConnectionId);
    if (src && src.env !== current) setEnv(src.env);
  }, [selection]);

  const q = query.trim().toLowerCase();
  const active = envSets.filter((e) => !e.archived);
  const starredSet = (c: Connection) => c.pinned || active.some((e) => e.pinned && e.memberIds.includes(c.id));
  // A search looks everywhere: the tab is where you are, not a wall.
  const inScope = (c: Connection) => (!!q || current === 'all' || c.env === current) && (!starred || starredSet(c));
  const matches = useMemo(
    () => connections.filter((c) => inScope(c) && (!q || haystack(c).includes(q))),
    [connections, q, current, starred, active],
  );
  const matchIds = new Set(matches.map((c) => c.id));
  const byPin = (a: { pinned?: boolean }, b: { pinned?: boolean }) => Number(!!b.pinned) - Number(!!a.pinned);

  // Sets are how you compare, not where a connection lives: every
  // connection is listed under its environment, and the sets sit in a dock
  // below, one row each. A search keeps a set whose name or members match.
  const sets = active
    .filter((e) => {
      if (starred && !e.pinned) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.memberIds.some((id) => matchIds.has(id));
    })
    .sort(byPin);
  const inGroup = new Set(groups.flatMap((g) => g.connectionIds));
  const loose = matches.filter((c) => !inGroup.has(c.id)).sort(byPin);
  const looseByEnv = ENV_ORDER.map((e) => ({ env: e, items: loose.filter((c) => c.env === e) })).filter((b) => b.items.length > 0);
  // Branches whose connection was deleted still need a home.
  const orphans = ticketState.tickets.some((t) => !connections.some((c) => c.id === t.sourceConnectionId));

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  // A filter that hides its results inside a folded section is broken, so
  // searching overrides the fold rather than fighting it.
  const isFolded = (key: string) => !q && Boolean(collapsed[key]);
  const withBranches = (c: Connection, opts: { showEnv: boolean }) => (
    <div key={c.id}>
      <ConnectionRow connection={c} showEnv={opts.showEnv} />
      <Branches
        sourceConnectionId={c.id}
        query={q}
        folded={isFolded(`branches:${c.id}`)}
        onToggle={() => toggle(`branches:${c.id}`)}
      />
    </div>
  );

  const nothingMatched = (q.length > 0 || starred) && matches.length === 0 && sets.length === 0;
  const nothingHere = !q && !starred && connections.length > 0 && matches.length === 0;

  return (
    <div className="h-full flex flex-col bg-surface-muted border-r border-card">
      <div className="px-2.5 pt-2.5 pb-2 shrink-0 flex gap-1.5">
        <label className="group field flex-1 min-w-0 h-[26px] flex items-center gap-1.5 pl-2 pr-1.5 rounded-md cursor-text">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0 text-ink-muted">
            <circle cx="5.2" cy="5.2" r="3.6" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 8l2.6 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setQuery('');
                return;
              }
              // Enter opens the first match, so finding and selecting is one
              // gesture rather than type-then-reach-for-the-mouse.
              if (e.key === 'Enter' && matches.length > 0) {
                e.preventDefault();
                select({ kind: 'connection', id: matches[0].id });
              }
            }}
            placeholder="Find a connection"
            aria-label="Find a connection or set"
            className="flex-1 min-w-0 h-full bg-transparent outline-none text-[11.5px] text-ink placeholder:text-ink-faint"
          />
          {/* The shortcut is the hint; once you are in the field it has done
              its job. */}
          {!query && (
            <kbd aria-hidden="true" className="shrink-0 px-1 rounded border border-card text-[9.5px] leading-[13px] font-sans text-ink-muted group-focus-within:hidden">
              ⌘F
            </kbd>
          )}
        </label>
        <button
          onClick={() => setStarred(!starred)}
          aria-pressed={starred}
          title={starred ? 'Show everything' : 'Only starred'}
          aria-label="Only starred"
          className={`shrink-0 w-[26px] h-[26px] rounded-md border flex items-center justify-center ${starred ? 'border-accent/60 bg-accent/15 text-accent' : 'border-transparent bg-card text-ink-muted hover:text-ink'}`}
        >
          <StarIcon filled={starred} size={12} />
        </button>
      </div>

      {showTabs && (
        <div
          role="tablist"
          aria-label="Environment"
          className={`mx-2.5 mb-2 shrink-0 flex gap-0.5 p-[2px] rounded-[7px] bg-card ${q ? 'opacity-50' : ''}`}
          title={q ? 'Searching every environment' : undefined}
        >
          {(['all', ...envs] as const).map((e) => {
            const on = current === e;
            return (
              <button
                key={e}
                role="tab"
                aria-selected={on}
                onClick={() => setEnv(e)}
                // Raised rather than tinted, so the on state is one look
                // whatever the environment — except prod, which is the one
                // tab that should look different when you are in it.
                className={`flex-auto min-w-0 h-[22px] px-1.5 rounded-[5px] flex items-center justify-center gap-[5px] text-[11px] whitespace-nowrap transition-colors ${
                  on
                    ? e === 'prod'
                      ? 'font-semibold bg-bad/10 text-bad-strong'
                      : 'font-semibold bg-surface-elevated text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
                    : 'font-medium text-ink-muted hover:text-ink'
                }`}
              >
                {e !== 'all' && <span aria-hidden="true" className={`shrink-0 w-1.5 h-1.5 rounded-full ${ENV_DOT[e]}`} />}
                {e === 'all' ? 'All' : ENV_NAME[e]}
              </button>
            );
          })}
        </div>
      )}

      {current === 'prod' && !q && (
        <div className="mx-2.5 mb-1.5 shrink-0 flex items-center gap-1.5 px-2 py-[5px] rounded-md bg-bad/10 text-[10.5px] leading-[13px] text-bad-strong">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
            <path d="M6 1.2 10 2.8v3c0 2.4-1.7 4.2-4 5-2.3-.8-4-2.6-4-5v-3L6 1.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          Production — take care what you run.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Only while something is open: with nothing selected the main
            pane shows the same suggestion, and twice on one screen is
            nagging. */}
        {!q && selection && <EnvSetSuggestion compact className="mx-2.5 mb-2" />}

        {nothingMatched && (
          <Empty>
            {starred && !q ? 'Nothing starred here yet. Star a connection or set from its row.' : `Nothing matches “${query}”. Search names, hosts, databases and engines.`}
          </Empty>
        )}
        {nothingHere && <Empty>No {current === 'all' ? '' : `${ENV_NAME[current]} `}connections yet.</Empty>}

        {orphans && (current === 'all' || current === 'local') && (
          <div className="py-1">
            <Branches sourceConnectionId={null} query={q} folded={isFolded('branches:orphans')} onToggle={() => toggle('branches:orphans')} />
          </div>
        )}

        {groups.map((g) => {
          const items = connections.filter((c) => g.connectionIds.includes(c.id) && matchIds.has(c.id));
          if (items.length === 0) return null;
          return (
            <Section
              key={g.id}
              label={g.name}
              count={items.length}
              collapsed={isFolded(`group:${g.id}`)}
              onToggle={() => toggle(`group:${g.id}`)}
            >
              {items.map((c) => withBranches(c, { showEnv: true }))}
            </Section>
          );
        })}

        {connections.length === 0 ? (
          <Section label="Connections">
            <Empty>No connections yet. Add one below, or import from a tool you already use.</Empty>
          </Section>
        ) : (
          looseByEnv.map(({ env: e, items }) => (
            <Section
              key={e}
              // Under one environment's tab the tab already says which, and
              // a heading repeating it is the third time on the screen.
              bare={!q && current !== 'all'}
              label={ENV_NAME[e]}
              lead={<span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${ENV_DOT[e]}`} />}
              count={items.length}
              collapsed={isFolded(`env:${e}`)}
              onToggle={() => toggle(`env:${e}`)}
            >
              {items.map((c) => withBranches(c, { showEnv: false }))}
            </Section>
          ))
        )}
      </div>

      {connections.length > 1 && (sets.length > 0 || (!q && !starred)) && (
        <SetDock
          sets={sets}
          env={q ? 'all' : current}
          folded={Boolean(collapsed['dock:sets'])}
          onToggle={() => toggle('dock:sets')}
        />
      )}
    </div>
  );
}

const ENV_DOT: Record<EnvKind, string> = {
  local: 'bg-good',
  dev: 'bg-good',
  sandbox: 'bg-accent',
  staging: 'bg-warn',
  prod: 'bg-bad',
  other: 'bg-ink-faint',
};

/// The sets, below the list and always in view: one row each, the
/// environments it spans as dots, and Compare. Under an environment tab the
/// sets that have nothing there step back rather than disappear — they are
/// still one click away, and a set that vanishes reads as deleted.
function SetDock({
  sets,
  env,
  folded,
  onToggle,
}: {
  sets: EnvSet[];
  env: EnvKind | 'all';
  folded: boolean;
  onToggle(): void;
}): JSX.Element {
  const selection = useStore((s) => s.selection);
  const setSheet = useStore((s) => s.setSheet);
  return (
    <div className="shrink-0 max-h-[40%] flex flex-col border-t border-card pb-1.5">
      <div className="flex items-center gap-1.5 pl-3.5 pr-2 pt-1.5 pb-1">
        <button
          onClick={onToggle}
          aria-expanded={!folded}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-muted hover:text-ink"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className={`transition-transform ${folded ? '' : 'rotate-90'}`}>
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
          Compare
        </button>
        {sets.length > 0 && <span className="text-[10px] tabular-nums text-ink-muted">{sets.length}</span>}
        <div className="flex-1" />
        <IconButton label="New set" onClick={() => setSheet({ kind: 'newEnvSet' })}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>
      {!folded && (
        <div className="min-h-0 overflow-y-auto flex flex-col gap-px">
          {sets.length === 0 ? (
            <Empty>Make a set to compare the same database across local, staging and prod.</Empty>
          ) : (
            sets.map((s) => (
              <SetRow key={s.id} envSet={s} env={env} selected={selection?.kind === 'envSet' && selection.id === s.id} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SetRow({ envSet, env, selected }: { envSet: EnvSet; env: EnvKind | 'all'; selected: boolean }): JSX.Element {
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const removeEnvSet = useStore((s) => s.removeEnvSet);
  const togglePin = useStore((s) => s.togglePin);
  const connections = useStore((s) => s.connections);
  const members = envSet.memberIds.map((id) => connections.find((c) => c.id === id)).filter((c): c is Connection => !!c);
  const envs = ENV_ORDER.filter((e) => members.some((c) => c.env === e));
  const away = env !== 'all' && !envs.includes(env);
  const open = () => select({ kind: 'envSet', id: envSet.id });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const remove = () =>
    askConfirm({
      title: `Delete ${envSet.name}?`,
      body: 'This removes the set only. The connections in it are untouched.',
      confirmLabel: 'Delete set',
      destructive: true,
      onConfirm: () => void removeEnvSet(envSet.id),
    });

  return (
    <>
      <Row
        label={envSet.name}
        title={members.length ? `${envSet.name}: ${members.map((c) => c.name).join(', ')}` : `${envSet.name} has no connections yet`}
        detail={envs.length ? envs.map((e) => ENV_NAME[e].toLowerCase()).join(' · ') : 'empty'}
        // Where a connection's tile names its engine, a set's shows the
        // environments it spans — the thing that makes it a set.
        lead={
          <span aria-hidden="true" className="shrink-0 w-5 h-5 rounded-[5px] bg-card flex items-center justify-center gap-0.5">
            {envs.map((e) => (
              <span key={e} className={`w-1 h-1 rounded-full ${ENV_DOT[e]}`} />
            ))}
          </span>
        }
        chip={
          <span
            title={`Open ${envSet.name} across every environment: drift, and queries on all of them`}
            className="px-1.5 py-0.5 rounded bg-accent/15 text-[10.5px] font-medium text-accent-strong"
          >
            Compare
          </span>
        }
        rest={envSet.pinned ? <StarMark /> : null}
        moreLabel={`More for ${envSet.name}`}
        onMore={setMenu}
        dimmed={away && !selected}
        selected={selected}
        onClick={open}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <Dropdown open={!!menu} at={menu ?? undefined} onClose={() => setMenu(null)} label={envSet.name} width={230}>
        <MenuItem label="Compare" detail="Drift, and queries on every member" onSelect={() => { setMenu(null); open(); }} />
        <MenuDivider />
        <MenuItem label={envSet.pinned ? 'Unstar' : 'Star'} onSelect={() => { setMenu(null); void togglePin('envSet', envSet.id); }} />
        <MenuItem label="Edit…" onSelect={() => { setMenu(null); setSheet({ kind: 'editEnvSet', id: envSet.id }); }} />
        <MenuDivider />
        <MenuItem label="Delete…" onSelect={() => { setMenu(null); remove(); }} />
      </Dropdown>
    </>
  );
}

/// What the second line says. The env is deliberately absent — the section
/// heading above already carries it — and this is empty when the name
/// already tells you everything, rather than repeating it.
function detailFor(conn: Connection): string {
  const parts: string[] = [];
  if (conn.engine === 'sqlite') return conn.file ?? '';
  if (conn.engine === 'dynamodb') return conn.region ?? '';
  if (conn.database) parts.push(conn.database);
  // The host earns a place only when the name is not already it.
  if (conn.host && conn.host !== conn.name && !conn.name.includes(conn.host)) {
    parts.push(conn.host);
  }
  return parts.join(' · ');
}

/// Shown only when something other than you can read the connection, so
/// its presence is the news — see `agentReach`.
function AgentMark({ connection }: { connection: Connection }): JSX.Element | null {
  const reach = agentReach(connection);
  if (!reach) return null;
  return (
    <span title={reach} aria-label={reach} role="img" className="shrink-0 w-[18px] flex justify-center text-accent">
      <Agent className="w-3 h-3" />
    </span>
  );
}

/// Connected, or the last attempt failed, as a pip on the engine tile's
/// corner — status reads with the thing it is the status of, and the row's
/// end is left to the row's actions. Not connected is the common case and
/// gets no mark at all.
function StatusPip({ state }: { state?: 'open' | 'closed' | 'error' }): JSX.Element | null {
  if (state !== 'open' && state !== 'error') return null;
  const title = state === 'open' ? 'Connected' : 'Last attempt failed';
  return <span role="img" aria-label={title} title={title} className={`status-pip ${state === 'open' ? 'bg-good' : 'bg-bad'}`} />;
}

function EngineTile({ connection, state }: { connection: Connection; state?: 'open' | 'closed' | 'error' }): JSX.Element {
  const variant: Variant = connection.variant ?? connection.engine;
  return (
    <span title={variantLabel(connection.variant, connection.engine)} className={`engine-tile ${TAG_TEXT[variant]}`}>
      {TAG_MONO[variant]}
      <StatusPip state={state} />
    </span>
  );
}

function StarIcon({ filled, size = 11 }: { filled: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path d="M6 1.2 7.4 4.3l3.4.4-2.5 2.3.7 3.3L6 8.7l-3 1.6.7-3.3L1.2 4.7l3.4-.4L6 1.2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function StarMark(): JSX.Element {
  return (
    <span role="img" aria-label="Starred" className="shrink-0 w-[22px] flex justify-center text-accent">
      <StarIcon filled />
    </span>
  );
}

function IconButton({
  label,
  onClick,
  on,
  children,
}: {
  label: string;
  onClick(e: React.MouseEvent<HTMLButtonElement>): void;
  on?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-[5px] hover:bg-card ${on ? 'text-accent' : 'text-ink-muted hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function ConnectionRow({
  connection,
  showEnv = true,
}: {
  connection: Connection;
  /// Suppressed when the section heading already says it.
  showEnv?: boolean;
}): JSX.Element {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const askConfirm = useStore((s) => s.askConfirm);
  const removeConnection = useStore((s) => s.removeConnection);
  const togglePin = useStore((s) => s.togglePin);
  const state = useStore((s) => s.connState[connection.id]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const requestDelete = () =>
    askConfirm({
      title: `Delete ${connection.name}?`,
      body:
        'This removes the connection from overdb and deletes its stored password. ' +
        'The database itself is untouched — nothing is dropped, and no data is deleted.',
      confirmLabel: 'Delete connection',
      destructive: true,
      onConfirm: () => removeConnection(connection.id),
    });

  const reach = agentReach(connection);

  return (
    <>
      <Row
        label={connection.name}
        detail={showEnv ? [ENV_NAME[connection.env], detailFor(connection)].filter(Boolean).join(' · ') : detailFor(connection)}
        lead={<EngineTile connection={connection} state={state} />}
        rest={
          connection.pinned || reach ? (
            <>
              <AgentMark connection={connection} />
              {connection.pinned && <StarMark />}
            </>
          ) : null
        }
        pinned={connection.pinned}
        onPin={() => void togglePin('connection', connection.id)}
        moreLabel={`More for ${connection.name}`}
        onMore={setMenu}
        // No PROD chip: the second line names the environment wherever the
        // tab does not, and a chip on every row under the Prod tab teaches you
        // to stop seeing it.
        tone={connection.env === 'prod' ? 'warn' : 'normal'}
        selected={selection?.kind === 'connection' && selection.id === connection.id}
        onClick={() => select({ kind: 'connection', id: connection.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <ConnectionMenu connection={connection} at={menu} onClose={() => setMenu(null)} onDelete={requestDelete} />
    </>
  );
}

/// Everything you can do to a connection, on a right click: open it, the
/// work that starts from it, and managing it. Each item is offered only
/// where it applies, so the menu never lists something that would refuse.
function ConnectionMenu({
  connection: c,
  at,
  onClose,
  onDelete,
}: {
  connection: Connection;
  at: { x: number; y: number } | null;
  onClose(): void;
  onDelete(): void;
}): JSX.Element {
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const newBuffer = useStore((s) => s.newBuffer);
  const togglePin = useStore((s) => s.togglePin);
  const duplicateConnection = useStore((s) => s.duplicateConnection);
  const baselines = useTickets((s) => s.baselines);
  const hasBase = baselines.some((b) => b.sourceConnectionId === c.id);
  const canBase = devInstanceRefusal(c) === null && c.engine !== 'dynamodb';
  const canSeed = c.env === 'local' && c.engine !== 'dynamodb';
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Dropdown open={!!at} at={at ?? undefined} onClose={onClose} label={c.name} width={260}>
      <MenuItem label="Open" onSelect={go(() => select({ kind: 'connection', id: c.id }))} />
      <MenuItem
        label="New tab"
        kbd="⌘T"
        onSelect={go(() => {
          select({ kind: 'connection', id: c.id });
          newBuffer(c.id);
        })}
      />
      {(canSeed || canBase || hasBase) && <MenuDivider />}
      {canSeed && <MenuItem tone="ai" label="Seed for a ticket…" onSelect={go(() => setSheet({ kind: 'seed', connectionId: c.id }))} />}
      {canBase && (
        <MenuItem
          label={c.env === 'local' ? (hasBase ? 'Rebuild its base…' : 'Create a base…') : hasBase ? 'Copy to this machine again…' : 'Copy to this machine…'}
          detail={c.env === 'local' ? 'A small copy to branch from' : 'A small copy you can write to and branch from'}
          onSelect={go(() => setSheet({ kind: 'baseline', connectionId: c.id }))}
        />
      )}
      {hasBase && <MenuItem label="Branches…" onSelect={go(() => setSheet({ kind: 'tickets' }))} />}
      {c.engine !== 'dynamodb' && (
        <MenuItem
          label="Map"
          detail="What the code says about each table"
          onSelect={go(() => openPane(c.id, MAP_TAB))}
        />
      )}
      <MenuDivider />
      <MenuItem label={c.pinned ? 'Unstar' : 'Star'} onSelect={go(() => void togglePin('connection', c.id))} />
      <MenuItem label="Edit…" onSelect={go(() => setSheet({ kind: 'editConnection', id: c.id }))} />
      <MenuItem
        label="Duplicate"
        onSelect={go(() => {
          void duplicateConnection(c.id).then((id) => id && setSheet({ kind: 'editConnection', id }));
        })}
      />
      <MenuDivider />
      <MenuItem label="Delete…" onSelect={go(onDelete)} />
    </Dropdown>
  );
}

function Section({
  label,
  lead,
  action,
  count,
  collapsed,
  onToggle,
  bare,
  children,
}: {
  label: string;
  /// The rows with no heading above them.
  bare?: boolean;
  /// A mark before the label: an environment's colour.
  lead?: React.ReactNode;
  action?: { title: string; onClick: () => void };
  /// Shown only when the section can be folded — a count on a section you
  /// can always see is telling you something you can count.
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const foldable = Boolean(onToggle);
  if (bare) return <div className="pt-0.5 pb-1 flex flex-col gap-px">{children}</div>;
  return (
    <div className="pb-1">
      <div className="flex items-center gap-1.5 pl-3.5 pr-2 pt-2.5 pb-1">
        {foldable ? (
          <button
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-muted hover:text-ink"
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"
              className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
            >
              <path d="M2 1l4 3-4 3z" fill="currentColor" />
            </svg>
            {lead}
            {label}
          </button>
        ) : (
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
            {lead}
            {label}
          </span>
        )}
        {foldable && count !== undefined && (
          <span className="text-[10px] tabular-nums text-ink-muted">{count}</span>
        )}
        <div className="flex-1" />
        {action && (
          <button
            onClick={action.onClick}
            title={action.title}
            aria-label={action.title}
            className="text-ink-faint hover:text-ink w-4 h-4 leading-none text-sm"
          >
            +
          </button>
        )}
      </div>
      {!collapsed && <div className="flex flex-col gap-px">{children}</div>}
    </div>
  );
}

function Row({
  label,
  title,
  detail,
  lead,
  chip,
  rest,
  selected,
  dimmed,
  tone = 'normal',
  onClick,
  pinned,
  onPin,
  moreLabel = 'More',
  onMore,
  onContextMenu,
}: {
  label: string;
  /// The tooltip, when it should say more than the full name.
  title?: string;
  /// Second line: host and database, the thing that actually tells five
  /// connections called "localhost" apart. Omitted when there is nothing
  /// to add.
  detail?: string;
  /// The 20px tile the row starts with.
  lead: React.ReactNode;
  /// Shown on hover, before the actions: what clicking the row will do.
  chip?: React.ReactNode;
  /// The row's end at rest — a star, an agent — swapped for the actions on
  /// hover.
  rest?: React.ReactNode;
  selected: boolean;
  /// Present but not here: a set with nothing under the current tab.
  dimmed?: boolean;
  tone?: 'normal' | 'warn';
  pinned?: boolean;
  onPin?: () => void;
  moreLabel?: string;
  /// Opens the row's menu under the ⋯ button.
  onMore?: (at: { x: number; y: number }) => void;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}): JSX.Element {
  const width = useStore((s) => s.settings.sidebarWidth);
  // Cut out of the MIDDLE. `Redshift - @PROD [EU]` and
  // `Redshift - @PROD [RW]` are different servers that a tail ellipsis
  // renders as the same row.
  const shown = middleTruncate(label, nameBudget(width, 20, rest ? 22 : 0));

  return (
    // A div rather than a button: a button nested inside a button is
    // invalid HTML and behaves unpredictably when activated by keyboard.
    <div
      role="button"
      tabIndex={0}
      title={title ?? (shown === label ? undefined : label)}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        // Only the row's own keys: Enter on the ⋯ inside it is that
        // button's, and taking it here would open the row instead.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group sidebar-row mx-1.5 rounded-md pl-[7px] pr-1 py-1.5 flex items-center gap-[9px] cursor-default outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
        selected ? 'sidebar-row-selected' : ''
      } ${dimmed ? 'opacity-40 hover:opacity-100 focus-within:opacity-100' : ''}`}
    >
      {lead}
      <div className="flex-1 min-w-0 flex flex-col gap-px">
        <span className={`text-xs leading-[15px] text-ink truncate ${selected ? 'font-semibold' : ''}`}>{shown}</span>
        {detail && <span className="text-[10.5px] leading-[13px] text-ink-muted truncate">{detail}</span>}
      </div>
      {chip && <span className="shrink-0 hidden group-hover:flex group-focus-within:flex">{chip}</span>}
      {/* At rest the row ends in one slot, and pointing at the row or tabbing
        * into it swaps that slot for its actions, so the end of the row never
        * shifts under the name. Edit and delete are not among them: they are
        * in the menu, a deliberate reach away, rather than a hover's width
        * from wherever the pointer happens to cross a prod row. */}
      {rest && <span className="shrink-0 flex items-center group-hover:hidden group-focus-within:hidden">{rest}</span>}
      {(onPin || onMore) && (
        <span className="shrink-0 hidden group-hover:flex group-focus-within:flex items-center" onClick={(e) => e.stopPropagation()}>
          {onPin && (
            <IconButton label={pinned ? `Unstar ${label}` : `Star ${label}`} on={pinned} onClick={onPin}>
              <StarIcon filled={!!pinned} />
            </IconButton>
          )}
          {onMore && (
            <IconButton
              label={moreLabel}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onMore({ x: r.left, y: r.bottom + 2 });
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <circle cx="2.5" cy="6" r="1.1" />
                <circle cx="6" cy="6" r="1.1" />
                <circle cx="9.5" cy="6" r="1.1" />
              </svg>
            </IconButton>
          )}
        </span>
      )}
      {tone === 'warn' && <span className="sr-only">production</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="px-3.5 py-1 text-[11px] leading-snug text-ink-muted">{children}</p>;
}

