import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, EnvKind, EnvSet } from '@shared/types';
import { variantLabel, variantTag } from '@shared/engines';
import type { Variant } from '@shared/engines';
import { useStore } from './store';
import { EnvSetSuggestion } from './Welcome';
import { TAG_DOT, TAG_TEXT } from './engineTags';
import { middleTruncate, nameBudget } from '@shared/truncate';
import { useTickets } from './ticketsStore';
import { Branches } from './TicketSection';
import { devInstanceRefusal, isProxyConnectionId } from '@shared/instances';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { MAP_TAB, openPane } from './queryStore';

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
const ENV_ON: Record<EnvKind, string> = {
  local: 'bg-good/15 text-good',
  dev: 'bg-good/15 text-good',
  sandbox: 'bg-accent/15 text-accent-strong',
  staging: 'bg-warn/15 text-warn-strong',
  prod: 'bg-bad/15 text-bad-strong',
  other: 'bg-wash-strong text-ink',
};

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
      <div className="px-3 pt-2.5 pb-2 shrink-0 flex gap-1.5">
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
          placeholder="Find a connection or set"
          aria-label="Find a connection or set"
          className="field flex-1 min-w-0 px-2 py-1 text-[11px]"
        />
        <button
          onClick={() => setStarred(!starred)}
          aria-pressed={starred}
          title={starred ? 'Show everything' : 'Only starred'}
          aria-label="Only starred"
          className={`shrink-0 w-[26px] rounded-md border flex items-center justify-center ${starred ? 'border-accent/60 bg-accent/15 text-accent' : 'border-card text-ink-faint hover:text-ink'}`}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill={starred ? 'currentColor' : 'none'} aria-hidden="true">
            <path d="M6 1.2 7.4 4.3l3.4.4-2.5 2.3.7 3.3L6 8.7l-3 1.6.7-3.3L1.2 4.7l3.4-.4L6 1.2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {showTabs && (
        <div
          role="tablist"
          aria-label="Environment"
          className={`mx-3 mb-2 shrink-0 flex gap-px p-[2px] rounded-md bg-surface border border-card ${q ? 'opacity-50' : ''}`}
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
                className={`flex-auto min-w-0 h-[22px] px-1.5 rounded-[4px] text-[10.5px] whitespace-nowrap ${
                  on ? `font-semibold ${e === 'all' ? 'bg-wash-strong text-ink' : ENV_ON[e]}` : 'text-ink-muted hover:text-ink'
                }`}
              >
                {e === 'all' ? 'All' : ENV_NAME[e]}
              </button>
            );
          })}
        </div>
      )}

      {current === 'prod' && !q && (
        <div className="mx-3 mb-2 shrink-0 px-2 py-1 rounded-md border border-bad/25 bg-bad/10 text-[10.5px] text-bad-strong">
          Production — take care what you run.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Only while something is open: with nothing selected the main
            pane shows the same suggestion, and twice on one screen is
            nagging. */}
        {!q && selection && <EnvSetSuggestion compact className="mx-3 mb-2" />}

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
    <div className="shrink-0 max-h-[40%] flex flex-col border-t border-card bg-surface/40">
      <div className="flex items-center px-3 pt-2 pb-1">
        <button
          onClick={onToggle}
          aria-expanded={!folded}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint hover:text-ink-muted"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className={`transition-transform ${folded ? '' : 'rotate-90'}`}>
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
          Sets · compare
        </button>
        {sets.length > 0 && <span className="ml-1.5 text-[10px] tabular-nums text-ink-faint/70">{sets.length}</span>}
        <div className="flex-1" />
        <button onClick={() => setSheet({ kind: 'newEnvSet' })} className="text-[10.5px] text-accent hover:underline">
          New set
        </button>
      </div>
      {!folded && (
        <div className="min-h-0 overflow-y-auto pb-1.5">
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
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      title={members.length ? `${envSet.name}: ${members.map((c) => c.name).join(', ')}` : `${envSet.name} has no connections yet`}
      className={`group sidebar-row h-[26px] px-3 flex items-center gap-2 cursor-default ${selected ? 'sidebar-row-selected' : 'hover:bg-card'} ${
        away && !selected ? 'opacity-40 hover:opacity-100' : ''
      }`}
    >
      <span className="shrink-0 max-w-[55%] text-[11.5px] font-semibold text-ink truncate">{envSet.name}</span>
      <span className="shrink-0 flex gap-[3px]" aria-hidden="true">
        {envs.map((e) => (
          <span key={e} className={`w-1.5 h-1.5 rounded-full ${ENV_DOT[e]}`} />
        ))}
      </span>
      <span className="flex-1 min-w-0 text-[10px] text-ink-faint truncate">
        {envs.length ? envs.map((e) => ENV_NAME[e].toLowerCase()).join(' · ') : 'empty'}
      </span>
      {envSet.pinned && <span className="shrink-0 text-accent text-[10px] group-hover:hidden" aria-label="Starred">★</span>}
      <span className="shrink-0 hidden group-hover:flex group-focus-within:flex items-center" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => void togglePin('envSet', envSet.id)}
            title={envSet.pinned ? `Unstar ${envSet.name}` : `Star ${envSet.name}`}
            aria-label={envSet.pinned ? `Unstar ${envSet.name}` : `Star ${envSet.name}`}
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill={envSet.pinned ? 'currentColor' : 'none'} aria-hidden="true">
              <path d="M6 1.2 7.4 4.3l3.4.4-2.5 2.3.7 3.3L6 8.7l-3 1.6.7-3.3L1.2 4.7l3.4-.4L6 1.2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => setSheet({ kind: 'editEnvSet', id: envSet.id })}
            title={`Edit ${envSet.name}`}
            aria-label={`Edit ${envSet.name}`}
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M8.2 1.8a1.1 1.1 0 0 1 1.6 1.6L4.4 8.8l-2.2.6.6-2.2 5.4-5.4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() =>
              askConfirm({
                title: `Delete ${envSet.name}?`,
                body: 'This removes the set only. The connections in it are untouched.',
                confirmLabel: 'Delete set',
                destructive: true,
                onConfirm: () => void removeEnvSet(envSet.id),
              })
            }
            title={`Delete ${envSet.name}`}
            aria-label={`Delete ${envSet.name}`}
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-bad hover:bg-card"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
      </span>
      <span
        title={`Open ${envSet.name} across every environment: drift, and queries on all of them`}
        className="shrink-0 text-[10.5px] text-accent"
      >
        Compare
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <Dropdown open={!!menu} at={menu ?? undefined} onClose={() => setMenu(null)} label={envSet.name} width={230}>
          <MenuItem label="Compare" detail="Drift, and queries on every member" onSelect={() => { setMenu(null); open(); }} />
          <MenuDivider />
          <MenuItem label={envSet.pinned ? 'Unstar' : 'Star'} onSelect={() => { setMenu(null); void togglePin('envSet', envSet.id); }} />
          <MenuItem label="Edit…" onSelect={() => { setMenu(null); setSheet({ kind: 'editEnvSet', id: envSet.id }); }} />
          <MenuDivider />
          <MenuItem label="Delete…" onSelect={() => { setMenu(null); remove(); }} />
        </Dropdown>
      </span>
    </div>
  );
}

/// Below this the badge drops its word and keeps its colour. Spelling
/// "DynamoDB" in a 180px row leaves nothing for the name, which is the
/// thing you were actually reading.
const NAME_BADGE_MIN_WIDTH = 220;
const BADGE_WIDTH = 54;

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

/// Open, not connected, or the last attempt failed. Absent state is the
/// common case and reads as the quietest mark.
function StatusDot({ state }: { state?: 'open' | 'closed' | 'error' }): JSX.Element {
  const title =
    state === 'open' ? 'Connected' : state === 'error' ? 'Last attempt failed' : 'Not connected';
  const look =
    state === 'open' ? 'bg-good'
    : state === 'error' ? 'bg-bad'
    : 'border border-card-border';
  return <span title={title} className={`shrink-0 w-[5px] h-[5px] rounded-full ${look}`} />;
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
  const setSheet = useStore((s) => s.setSheet);
  const removeConnection = useStore((s) => s.removeConnection);
  const togglePin = useStore((s) => s.togglePin);
  const state = useStore((s) => s.connState[connection.id]);
  const width = useStore((s) => s.settings.sidebarWidth);
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

  const variant: Variant = connection.variant ?? connection.engine;
  const spelled = width >= NAME_BADGE_MIN_WIDTH;

  return (
    <>
      <Row
        label={connection.name}
        detail={showEnv ? [ENV_NAME[connection.env], detailFor(connection)].filter(Boolean).join(' · ') : detailFor(connection)}
        badge={
          spelled ? (
            <span
              title={variantLabel(connection.variant, connection.engine)}
              style={{ width: BADGE_WIDTH }}
              className={`shrink-0 truncate text-[9.5px] font-semibold leading-none ${TAG_TEXT[variant]}`}
            >
              {variantTag(connection.variant, connection.engine)}
            </span>
          ) : (
            <span
              title={variantLabel(connection.variant, connection.engine)}
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${TAG_DOT[variant]}`}
            />
          )
        }
        badgeWidth={spelled ? BADGE_WIDTH : 6}
        trailing={<StatusDot state={state} />}
        onEdit={() => setSheet({ kind: 'editConnection', id: connection.id })}
        editTitle={`Edit ${connection.name}`}
        onDelete={requestDelete}
        deleteTitle={`Delete ${connection.name}`}
        pinned={connection.pinned}
        onPin={() => void togglePin('connection', connection.id)}
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
  children,
}: {
  label: string;
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
  return (
    <div className="py-2">
      <div className="flex items-center px-3 pb-1">
        {foldable ? (
          <button
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint hover:text-ink-muted"
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
          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {lead}
            {label}
          </span>
        )}
        {foldable && count !== undefined && (
          <span className="ml-1.5 text-[10px] tabular-nums text-ink-faint/70">{count}</span>
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
      {!collapsed && children}
    </div>
  );
}

function Row({
  label,
  detail,
  badge,
  badgeWidth = 0,
  trailing,
  below,
  selected,
  tone = 'normal',
  onClick,
  onEdit,
  editTitle,
  onDelete,
  deleteTitle,
  pinned,
  onPin,
  mark,
  onContextMenu,
}: {
  label: string;
  /// Second line: host and database, the thing that actually tells five
  /// connections called "localhost" apart. Omitted when there is nothing
  /// to add.
  detail?: string;
  badge?: React.ReactNode;
  badgeWidth?: number;
  trailing?: React.ReactNode;
  below?: React.ReactNode;
  selected: boolean;
  tone?: 'normal' | 'warn';
  mark?: string;
  pinned?: boolean;
  onPin?: () => void;
  onClick: () => void;
  onEdit?: () => void;
  editTitle?: string;
  onDelete?: () => void;
  deleteTitle?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}): JSX.Element {
  const width = useStore((s) => s.settings.sidebarWidth);
  // Cut out of the MIDDLE. `Redshift - @PROD [EU]` and
  // `Redshift - @PROD [RW]` are different servers that a tail ellipsis
  // renders as the same row.
  const shown = middleTruncate(label, nameBudget(width, badgeWidth));

  return (
    // A div rather than a button: a delete control nested inside a button is
    // invalid HTML and behaves unpredictably when activated by keyboard.
    <div
      role="button"
      tabIndex={0}
      title={shown === label ? undefined : label}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group sidebar-row w-full text-left px-3 py-[5px] flex items-center gap-2 cursor-default ${
        selected ? 'sidebar-row-selected' : 'hover:bg-card'
      }`}
    >
      {badge}
      <div className="flex-1 min-w-0 flex flex-col gap-px">
        <span className="text-xs leading-[15px] text-ink truncate">{shown}</span>
        {detail && (
          <span className="text-[10px] leading-[13px] text-ink-faint truncate">{detail}</span>
        )}
        {below}
      </div>
      {mark && (
        <span className="shrink-0 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-warn/10 text-warn/90 border border-warn/25">
          {mark}
        </span>
      )}
      {/* The trailing cluster carries its own spacing rather than riding the
        * row's `gap-2`. A flex gap applies between every pair of siblings
        * whatever their width, so a drawer that collapses to nothing would
        * still leave two 8px gaps behind it — the star would end up hovering
        * short of the row's edge, anchored to nothing. Here the gaps belong
        * to the items inside the drawer, so they collapse with it. */}
      <div className="shrink-0 flex items-center">
        {onPin && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPin();
            }}
            title={pinned ? `Unpin ${label}` : `Pin ${label}`}
            aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
            className={`shrink-0 w-5 h-5 flex items-center justify-center rounded transition-opacity hover:text-ink hover:bg-card ${
              pinned ? 'text-accent' : 'text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill={pinned ? 'currentColor' : 'none'} aria-hidden="true">
              <path
                d="M6 1.2 7.4 4.3l3.4.4-2.5 2.3.7 3.3L6 8.7l-3 1.6.7-3.3L1.2 4.7l3.4-.4L6 1.2Z"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        {(onEdit || onDelete) && (
          // Closed until you point at the row or tab into it. Hidden by WIDTH
          // and not only by opacity: buttons that keep their 20px while
          // invisible push everything before them out of the row's edge.
          <span className="row-actions">
            <span>
              {onEdit && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                  title={editTitle}
                  aria-label={editTitle}
                  className="shrink-0 ml-2 w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M8.2 1.8a1.1 1.1 0 0 1 1.6 1.6L4.4 8.8l-2.2.6.6-2.2 5.4-5.4Z"
                          stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              {onDelete && (
                <button
                  // Never hidden from assistive tech — the drawer opens on
                  // `:focus-within`, so tabbing here reveals it.
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  title={deleteTitle}
                  aria-label={deleteTitle}
                  className="shrink-0 ml-2 w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-bad hover:bg-card"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </span>
          </span>
        )}
        {trailing && <span className="shrink-0 ml-2 flex items-center">{trailing}</span>}
      </div>
      {tone === 'warn' && !mark && <span className="sr-only">production</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="px-3 py-1 text-[11px] leading-snug text-ink-faint">{children}</p>;
}

