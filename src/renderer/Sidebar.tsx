import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, EnvKind, EnvSet } from '@shared/types';
import { variantLabel } from '@shared/engines';
import type { Variant } from '@shared/engines';
import { useStore } from './store';
import { EnvSetSuggestion } from './Welcome';
import { TAG_MONO, TAG_TEXT } from './engineTags';
import { middleTruncate, nameBudget } from '@shared/truncate';
import { useTickets } from './ticketsStore';
import { Branches, RoutedIcon, servicesView } from './TicketSection';
import { devInstanceRefusal, isProxyConnectionId } from '@shared/instances';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { MAP_TAB, openPane } from './queryStore';
import { agentReach } from '@shared/hostedConnection';
import { AgentMark, AgentWatch } from './AgentMark';

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
/// the name, because half of these are called "localhost". The environment
/// is in it, so typing "prod" is the quickest way to one environment.
function haystack(c: Connection): string {
  return [c.name, c.host, c.database, c.env, c.engine, c.variant, c.user]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// Environment order is deliberate and fixed: it reads the way work flows,
// and it puts prod last, where it is hardest to click by accident.
const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
const ENV_NAME: Record<EnvKind, string> = { local: 'Local', dev: 'Dev', sandbox: 'Sandbox', staging: 'Staging', prod: 'Prod', other: 'Other' };

const envKey = (e: EnvKind) => `env:${e}`;

/// Every connection, listed under its environment, one line each; branches
/// as rows under the connection they came from; environment sets (one
/// database, in each place) in a dock below. There is no environment
/// switch: each environment folds, and ⌥-click or a right click on its
/// heading shows only that one. Making things is the + beside the search.
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [plusAt, setPlusAt] = useState<{ x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // Losing fold state costs nothing; failing to render the nav does not.
    }
  }, [collapsed]);

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

  // Opening a connection from elsewhere (the palette, a shortcut, a branch)
  // that sits in a folded environment unfolds it, so the row you are on is
  // always one you can see.
  useEffect(() => {
    if (selection?.kind !== 'connection') return;
    const branch = ticketState.tickets.find((x) => x.connectionId === selection.id);
    const c = connections.find((x) => x.id === (branch ? branch.sourceConnectionId : selection.id));
    if (c && collapsed[envKey(c.env)]) setCollapsed((p) => ({ ...p, [envKey(c.env)]: false }));
  }, [selection]);

  const q = query.trim().toLowerCase();
  const active = envSets.filter((e) => !e.archived);
  const starredSet = (c: Connection) => c.pinned || active.some((e) => e.pinned && e.memberIds.includes(c.id));
  // A connection matches on its own details, or on a branch made from it —
  // then it shows with just the branches that matched.
  const branchHits = useMemo(
    () =>
      q
        ? new Set(ticketState.tickets.filter((t) => `${t.name} ${t.note}`.toLowerCase().includes(q)).map((t) => t.sourceConnectionId))
        : new Set<string>(),
    [ticketState.tickets, q],
  );
  const selfHit = (c: Connection) => !q || haystack(c).includes(q);
  const matches = useMemo(
    () => connections.filter((c) => (!starred || starredSet(c)) && (selfHit(c) || branchHits.has(c.id))),
    [connections, q, starred, active, branchHits],
  );
  const matchIds = new Set(matches.map((c) => c.id));
  const byPin = (a: { pinned?: boolean }, b: { pinned?: boolean }) => Number(!!b.pinned) - Number(!!a.pinned);

  // A row is one line; the host and database come back as a second line
  // only for a name that is not enough on its own — two connections called
  // the same thing.
  const sharedNames = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of connections) n.set(c.name, (n.get(c.name) ?? 0) + 1);
    return new Set([...n].filter(([, k]) => k > 1).map(([name]) => name));
  }, [connections]);

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
  // Only watch what agents do while there is a connection — or a branch —
  // they can reach.
  const agentsReach = allConnections.some((c) => c.mcpExposed);

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  // A filter that hides its results inside a folded section is broken, so
  // searching overrides the fold rather than fighting it.
  const isFolded = (key: string) => !q && Boolean(collapsed[key]);
  // One environment on its own: fold the rest. Asked again of the one
  // already alone, it brings the others back.
  const alone = (e: EnvKind, from: Record<string, boolean>) => !from[envKey(e)] && envs.every((x) => x === e || from[envKey(x)]);
  const solo = (e: EnvKind) =>
    setCollapsed((prev) => {
      const back = alone(e, prev);
      const next = { ...prev };
      for (const x of envs) next[envKey(x)] = back ? false : x !== e;
      return next;
    });
  const withBranches = (c: Connection, opts: { showEnv: boolean }) => (
    <div key={c.id}>
      <ConnectionRow connection={c} showEnv={opts.showEnv} showDetail={sharedNames.has(c.name)} />
      <Branches
        sourceConnectionId={c.id}
        query={selfHit(c) ? '' : q}
        showAll={Boolean(collapsed[`branches-all:${c.id}`])}
        onToggleAll={() => toggle(`branches-all:${c.id}`)}
      />
    </div>
  );

  const nothingMatched = (q.length > 0 || starred) && matches.length === 0 && sets.length === 0;
  const go = (fn: () => void) => () => {
    setPlusAt(null);
    fn();
  };

  return (
    <div className="h-full flex flex-col bg-surface-muted border-r border-card">
      {agentsReach && <AgentWatch />}
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
            aria-label="Find a connection, branch or set"
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
        <button
          // Its own toggle: kept from the menu's click-outside, which would
          // close it on mousedown only for this click to open it again.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (plusAt) return setPlusAt(null);
            const r = e.currentTarget.getBoundingClientRect();
            setPlusAt({ x: Math.max(8, r.right - 230), y: r.bottom + 4 });
          }}
          aria-haspopup="menu"
          aria-expanded={!!plusAt}
          title="New connection, set or branch"
          aria-label="New"
          className="shrink-0 w-[26px] h-[26px] rounded-md border border-transparent bg-card text-ink-muted hover:text-ink flex items-center justify-center"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <Dropdown open={!!plusAt} at={plusAt ?? undefined} onClose={() => setPlusAt(null)} label="New" width={230}>
          <MenuItem label="New connection…" onSelect={go(() => setSheet({ kind: 'newConnection' }))} />
          <MenuItem label="New environment set…" detail="One database, in each environment" onSelect={go(() => setSheet({ kind: 'newEnvSet' }))} />
          {ticketState.baselines.length > 0 && (
            <MenuItem label="New branch…" detail="A writable copy, made from a base" onSelect={go(() => setSheet({ kind: 'tickets' }))} />
          )}
          <MenuDivider />
          <MenuItem
            label="Import connections…"
            detail="DataGrip, DataSpell, IntelliJ, DBeaver or ~/.pgpass"
            onSelect={go(() => setSheet({ kind: 'importConnections' }))}
          />
        </Dropdown>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Only while something is open: with nothing selected the main
            pane shows the same suggestion, and twice on one screen is
            nagging. */}
        {!q && selection && <EnvSetSuggestion compact className="mx-2.5 mb-2" />}

        {nothingMatched && (
          <Empty>
            {starred && !q ? 'Nothing starred here yet. Star a connection or set from its row.' : `Nothing matches “${query}”. Search names, hosts, databases, environments and branches.`}
          </Empty>
        )}

        {orphans && (
          <Section label="Branches without a connection" collapsed={isFolded('branches:orphans')} onToggle={() => toggle('branches:orphans')}>
            <Branches sourceConnectionId={null} query={q} showAll onToggleAll={() => undefined} />
          </Section>
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
            <Empty>No connections yet. Add one with +, or import from a tool you already use.</Empty>
          </Section>
        ) : (
          looseByEnv.map(({ env: e, items }) => (
            <Section
              key={e}
              label={ENV_NAME[e]}
              lead={<span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${ENV_DOT[e]}`} />}
              count={items.length}
              tone={e === 'prod' ? 'prod' : undefined}
              collapsed={isFolded(envKey(e))}
              onToggle={() => toggle(envKey(e))}
              solo={
                envs.length > 1 && !q
                  ? { label: alone(e, collapsed) ? 'Show every environment' : `Show only ${ENV_NAME[e]}`, run: () => solo(e) }
                  : undefined
              }
            >
              {items.map((c) => withBranches(c, { showEnv: false }))}
            </Section>
          ))
        )}
      </div>

      {connections.length > 1 && (sets.length > 0 || (!q && !starred)) && (
        <SetDock sets={sets} folded={Boolean(collapsed['dock:sets'])} onToggle={() => toggle('dock:sets')} />
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
/// environments it spans as dots on its tile. Clicking one compares it.
function SetDock({
  sets,
  folded,
  onToggle,
}: {
  sets: EnvSet[];
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
          Environment sets
        </button>
        {sets.length > 0 && <span className="text-[10px] tabular-nums text-ink-muted">{sets.length}</span>}
        <div className="flex-1" />
        <IconButton label="New environment set" onClick={() => setSheet({ kind: 'newEnvSet' })}>
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
            sets.map((s) => <SetRow key={s.id} envSet={s} selected={selection?.kind === 'envSet' && selection.id === s.id} />)
          )}
        </div>
      )}
    </div>
  );
}

function SetRow({ envSet, selected }: { envSet: EnvSet; selected: boolean }): JSX.Element {
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const removeEnvSet = useStore((s) => s.removeEnvSet);
  const togglePin = useStore((s) => s.togglePin);
  const connections = useStore((s) => s.connections);
  const members = envSet.memberIds.map((id) => connections.find((c) => c.id === id)).filter((c): c is Connection => !!c);
  const envs = ENV_ORDER.filter((e) => members.some((c) => c.env === e));
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
        title={
          members.length
            ? `${envSet.name} — compare across ${envs.map((e) => ENV_NAME[e].toLowerCase()).join(', ')}\n${members.map((c) => c.name).join(', ')}`
            : `${envSet.name} has no connections yet`
        }
        // Where a connection's tile names its engine, a set's shows the
        // environments it spans — the thing that makes it a set.
        lead={
          <span aria-hidden="true" className="shrink-0 w-5 h-5 rounded-[5px] bg-card flex items-center justify-center gap-0.5">
            {envs.map((e) => (
              <span key={e} className={`w-1 h-1 rounded-full ${ENV_DOT[e]}`} />
            ))}
          </span>
        }
        rest={envSet.pinned ? <StarMark /> : null}
        moreLabel={`More for ${envSet.name}`}
        onMore={setMenu}
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

/// Where a connection points: the database, and the host when the name is
/// not already it. On hover always; as a second line only when two
/// connections share a name.
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
      // 20px tall, the engine tile's height: any taller and a one-line row
      // grows when its actions appear, and the whole list below it jumps.
      className={`shrink-0 w-[22px] h-5 flex items-center justify-center rounded-[5px] hover:bg-card ${on ? 'text-accent' : 'text-ink-muted hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function ConnectionRow({
  connection,
  showEnv = true,
  showDetail = false,
}: {
  connection: Connection;
  /// In a group of your own, where no heading says the environment.
  showEnv?: boolean;
  /// Another connection has the same name: say where this one points.
  showDetail?: boolean;
}): JSX.Element {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const askConfirm = useStore((s) => s.askConfirm);
  const removeConnection = useStore((s) => s.removeConnection);
  const togglePin = useStore((s) => s.togglePin);
  const state = useStore((s) => s.connState[connection.id]);
  const tickets = useTickets((s) => s.tickets);
  const proxies = useTickets((s) => s.proxies);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // One of its branches is open: the connection it came from says so, so
  // you can see whose branch you are in without reading the title bar.
  const branchOpen =
    selection?.kind === 'connection' && tickets.some((t) => t.connectionId === selection.id && t.sourceConnectionId === connection.id);
  // The ⇄ marks whichever row services reach, one per proxy: here when they
  // reach the server itself, on the branch when they are switched to one.
  const proxy = proxies.find((p) => p.source === connection.id);
  const servicesHere = !!proxy?.running && proxy.config.target.kind === 'server';

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
  const where = detailFor(connection);
  const detail = [showEnv ? ENV_NAME[connection.env] : null, showDetail ? where : null].filter(Boolean).join(' · ');

  return (
    <>
      <Row
        label={connection.name}
        title={[connection.name, [ENV_NAME[connection.env], where].filter(Boolean).join(' · ')].join('\n')}
        detail={detail || undefined}
        lead={<EngineTile connection={connection} state={state} />}
        // The agent mark stays put on hover: whether agents can reach a
        // connection is not something to lose the moment you point at it.
        keep={
          reach || servicesHere ? (
            <>
              {reach && <AgentMark connection={connection} />}
              {servicesHere && (
                <span
                  role="img"
                  aria-label="Your services reach this server"
                  title="Your services reach this server itself, not a branch"
                  className="shrink-0 w-[18px] flex justify-center text-accent-strong"
                >
                  <RoutedIcon />
                </span>
              )}
            </>
          ) : null
        }
        keepWidth={(reach ? 20 : 0) + (servicesHere ? 18 : 0)}
        rest={connection.pinned ? <StarMark /> : null}
        ancestor={branchOpen}
        pinned={connection.pinned}
        onPin={() => void togglePin('connection', connection.id)}
        moreLabel={`More for ${connection.name}`}
        onMore={setMenu}
        // No PROD chip: the heading says it, in red, and a chip on every
        // row teaches you to stop seeing it.
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
/// work that starts from it — its base, branches and what services see —
/// and managing it. Each item is offered only where it applies, so the menu
/// never lists something that would refuse.
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
  const connections = useStore((s) => s.connections);
  const baselines = useTickets((s) => s.baselines);
  const proxies = useTickets((s) => s.proxies);
  const hasBase = baselines.some((b) => b.sourceConnectionId === c.id);
  const canBase = devInstanceRefusal(c) === null && c.engine !== 'dynamodb';
  const canSeed = c.env === 'local' && c.engine !== 'dynamodb';
  const see = servicesView({ proxies }, connections, c.id);
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
      {(canSeed || canBase || hasBase || see) && <MenuDivider />}
      {canSeed && <MenuItem tone="ai" label="Seed for a ticket…" onSelect={go(() => setSheet({ kind: 'seed', connectionId: c.id }))} />}
      {hasBase && <MenuItem label="New branch…" detail="A writable copy, made from its base" onSelect={go(() => setSheet({ kind: 'tickets' }))} />}
      {canBase && (
        <MenuItem
          label={c.env === 'local' ? (hasBase ? 'Rebuild its base…' : 'Create a base…') : hasBase ? 'Copy to this machine again…' : 'Copy to this machine…'}
          detail={c.env === 'local' ? 'A small copy to branch from' : 'A small copy you can write to and branch from'}
          onSelect={go(() => setSheet({ kind: 'baseline', connectionId: c.id }))}
        />
      )}
      {see && (
        <MenuItem
          label="What services see"
          detail="Read-only, through the proxy"
          onSelect={go(() => select({ kind: 'connection', id: see }))}
        />
      )}
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
  count,
  collapsed,
  onToggle,
  tone,
  solo,
  children,
}: {
  label: string;
  /// A mark before the label: an environment's colour.
  lead?: React.ReactNode;
  /// Shown only when the section can be folded — a count on a section you
  /// can always see is telling you something you can count.
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  /// Prod's heading is the one that should look different.
  tone?: 'prod';
  /// Show only this section: on ⌥-click, and on a right click as a menu.
  solo?: { label: string; run: () => void };
  children: React.ReactNode;
}): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const foldable = Boolean(onToggle);
  const color = tone === 'prod' ? 'text-bad-strong' : 'text-ink-muted hover:text-ink';
  const hint = [tone === 'prod' ? 'Production — take care what you run' : null, solo ? '⌥-click to show only this' : null].filter(Boolean).join('\n');
  return (
    <div className="pb-1">
      <div className="flex items-center gap-1.5 pl-3.5 pr-2 pt-2.5 pb-1">
        {foldable ? (
          <button
            onClick={(e) => {
              if (e.altKey && solo) return solo.run();
              onToggle?.();
            }}
            onContextMenu={
              solo
                ? (e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY });
                  }
                : undefined
            }
            aria-expanded={!collapsed}
            title={hint || undefined}
            className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${color}`}
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
          <span className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${color}`}>
            {lead}
            {label}
          </span>
        )}
        {foldable && count !== undefined && (
          <span className="text-[10px] tabular-nums text-ink-muted">{count}</span>
        )}
      </div>
      {solo && (
        <Dropdown open={!!menu} at={menu ?? undefined} onClose={() => setMenu(null)} label={label} width={210}>
          <MenuItem label={solo.label} kbd="⌥-click" onSelect={() => { setMenu(null); solo.run(); }} />
        </Dropdown>
      )}
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
  keep,
  keepWidth = 20,
  rest,
  selected,
  ancestor,
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
  /// A second line, only where the name alone does not tell rows apart.
  detail?: string;
  /// The 20px tile the row starts with.
  lead: React.ReactNode;
  /// Shown on hover, before the actions: what clicking the row will do.
  chip?: React.ReactNode;
  /// The row's end at rest — a star, an agent — swapped for the actions on
  /// hover.
  rest?: React.ReactNode;
  /// Marks that show at rest and on hover alike, before the swapping slot.
  keep?: React.ReactNode;
  /// Room the kept marks take, for the name's budget.
  keepWidth?: number;
  selected: boolean;
  /// Something under this row is the one open — a branch of it.
  ancestor?: boolean;
  /// Present but stepped back.
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
  // renders as the same row. Budgeted for the hover actions, not the resting
  // slot: a name that is cut again the moment you point at it moves.
  const actionsWidth = (onPin ? 22 : 0) + (onMore ? 22 : 0);
  const shown = middleTruncate(label, nameBudget(width, 20, Math.max(actionsWidth, rest ? 22 : 0) + (keep ? keepWidth : 0)));

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
      className={`group sidebar-row mx-1.5 rounded-md pl-[7px] pr-1 py-1 flex items-center gap-[9px] cursor-default outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
        selected ? 'sidebar-row-selected' : ancestor ? 'sidebar-row-ancestor' : ''
      } ${dimmed ? 'opacity-40 hover:opacity-100 focus-within:opacity-100' : ''}`}
    >
      {lead}
      <div className="flex-1 min-w-0 flex flex-col gap-px">
        <span className={`text-xs leading-[15px] text-ink truncate ${selected || ancestor ? 'font-semibold' : ''}`}>{shown}</span>
        {detail && <span className="text-[10.5px] leading-[13px] text-ink-muted truncate">{detail}</span>}
      </div>
      {chip && <span className="shrink-0 hidden group-hover:flex group-focus-within:flex">{chip}</span>}
      {keep}
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
