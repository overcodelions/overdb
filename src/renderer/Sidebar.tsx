import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, EnvKind, EnvSet } from '@shared/types';
import { variantLabel, variantTag } from '@shared/engines';
import type { Variant } from '@shared/engines';
import { useStore } from './store';
import { EnvSetSuggestion } from './Welcome';
import { middleTruncate, nameBudget } from '@shared/truncate';

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

export function Sidebar(): JSX.Element {
  const connections = useStore((s) => s.connections);
  const groups = useStore((s) => s.groups);
  const envSets = useStore((s) => s.envSets);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
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

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? connections.filter((c) => haystack(c).includes(q)) : connections),
    [connections, q],
  );
  const matchIds = useMemo(() => new Set(matches.map((c) => c.id)), [matches]);

  const ungrouped = matches.filter((c) => !groups.some((g) => g.connectionIds.includes(c.id)));
  const active = envSets.filter((e) => !e.archived);

  // What you are working with, in a fixed place. Pinned rather than
  // most-recent on purpose: a list that reorders itself defeats the muscle
  // memory that makes it fast.
  const pinnedSets = active.filter((e) => e.pinned);
  const pinnedConns = matches.filter((c) => c.pinned);
  const pinnedCount = pinnedSets.length + pinnedConns.length;
  // While filtering, a set earns its place by containing a match — otherwise
  // the filter would say "3 of 20" and still show every set.
  const visibleSets = q
    ? active.filter(
        (e) =>
          e.name.toLowerCase().includes(q) || e.memberIds.some((id) => matchIds.has(id)),
      )
    : active;

  // Environment order is deliberate and fixed: it reads the way work flows,
  // and it puts prod at the bottom where it is hardest to click by accident.
  const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
  const byEnv = ENV_ORDER.map((env) => ({
    env,
    items: ungrouped.filter((c) => c.env === env),
  })).filter((bucket) => bucket.items.length > 0);
  // One environment is not a grouping, it is a list — don't add a heading
  // that tells the user something they can already see.
  const showEnvHeadings = byEnv.length > 1;

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  // A filter that hides its results inside a folded section is broken, so
  // searching overrides the fold rather than fighting it.
  const isFolded = (key: string) => !q && Boolean(collapsed[key]);

  const nothingMatched = q.length > 0 && matches.length === 0 && visibleSets.length === 0;

  return (
    <div className="h-full flex flex-col bg-surface-muted border-r border-card">
      <div className="px-3 pt-2.5 pb-2 shrink-0">
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
          aria-label="Find a connection"
          className="field w-full px-2 py-1 text-[11px]"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Only while something is open: with nothing selected the main
            pane shows the same suggestion, and twice on one screen is
            nagging. */}
        {!q && selection && <EnvSetSuggestion compact className="mx-3 mb-2" />}

        {nothingMatched && (
          <Empty>
            Nothing matches “{query}”. Search names, hosts, databases and engines.
          </Empty>
        )}

        {pinnedCount > 0 && (
          <Section
            label="Pinned"
            count={pinnedCount}
            collapsed={isFolded('pinned')}
            onToggle={() => toggle('pinned')}
          >
            {pinnedSets.map((e) => (
              <EnvSetRow
                key={e.id}
                envSet={e}
                connections={connections}
                selected={selection?.kind === 'envSet' && selection.id === e.id}
              />
            ))}
            {pinnedConns.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </Section>
        )}

        <Section
          label="Environment sets"
          count={visibleSets.length || undefined}
          collapsed={isFolded('envsets')}
          onToggle={() => toggle('envsets')}
          action={{ title: 'New environment set', onClick: () => setSheet({ kind: 'newEnvSet' }) }}
        >
          {visibleSets.length === 0 ? (
            q ? null : (
              <Empty>
                Group the same database across local, staging and prod to query them together.
              </Empty>
            )
          ) : (
            visibleSets.map((e) => (
              <EnvSetRow
                key={e.id}
                envSet={e}
                connections={connections}
                selected={selection?.kind === 'envSet' && selection.id === e.id}
              />
            ))
          )}
        </Section>

        {groups.map((g) => {
          const items = connections.filter(
            (c) => g.connectionIds.includes(c.id) && matchIds.has(c.id),
          );
          if (q && items.length === 0) return null;
          return (
            <Section
              key={g.id}
              label={g.name}
              count={items.length}
              collapsed={isFolded(`group:${g.id}`)}
              onToggle={() => toggle(`group:${g.id}`)}
            >
              {items.map((c) => (
                <ConnectionRow key={c.id} connection={c} />
              ))}
            </Section>
          );
        })}

        {ungrouped.length === 0 && !q ? (
          <Section label="Connections">
            <Empty>No connections yet. Add one below, or import from a tool you already use.</Empty>
          </Section>
        ) : showEnvHeadings ? (
          byEnv.map(({ env, items }) => (
            <Section
              key={env}
              label={env}
              count={items.length}
              collapsed={isFolded(`env:${env}`)}
              onToggle={() => toggle(`env:${env}`)}
            >
              {items.map((c) => (
                <ConnectionRow key={c.id} connection={c} showEnv={false} />
              ))}
            </Section>
          ))
        ) : ungrouped.length > 0 ? (
          <Section
            label="Connections"
            count={ungrouped.length}
            collapsed={isFolded('connections')}
            onToggle={() => toggle('connections')}
          >
            {ungrouped.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </Section>
        ) : null}
      </div>

    </div>
  );
}

/// A set is its members, so the row says which environments it spans
/// rather than a count — "local · staging · prod" is the thing you needed
/// to know, and "3 envs" is not.
function EnvSetRow({
  envSet,
  connections,
  selected,
}: {
  envSet: EnvSet;
  connections: Connection[];
  selected: boolean;
}): JSX.Element {
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const removeEnvSet = useStore((s) => s.removeEnvSet);
  const togglePin = useStore((s) => s.togglePin);
  const width = useStore((s) => s.settings.sidebarWidth);

  const members = envSet.memberIds
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is Connection => Boolean(c));
  const hasProd = members.some((c) => c.env === 'prod');
  const spelled = width >= NAME_BADGE_MIN_WIDTH;

  const glyph = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2L14 5.2 8 8.4 2 5.2 8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2 8.4l6 3.2 6-3.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2 11.4l6 3.2 6-3.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" opacity="0.45" />
    </svg>
  );

  return (
    <Row
      label={envSet.name}
      detail={
        members.length
          ? [...new Set(members.map((c) => c.env))].join(' · ')
          : 'No connections yet — edit to add some'
      }
      badge={
        spelled ? (
          <span
            className="shrink-0 flex items-center gap-1 text-accent"
            style={{ width: BADGE_WIDTH }}
            title="Environment set"
          >
            {glyph}
            <span className="text-[9.5px] font-semibold leading-none opacity-80">Set</span>
          </span>
        ) : (
          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent" title="Environment set" />
        )
      }
      badgeWidth={spelled ? BADGE_WIDTH : 6}
      selected={selected}
      onClick={() => select({ kind: 'envSet', id: envSet.id })}
      onEdit={() => setSheet({ kind: 'editEnvSet', id: envSet.id })}
      editTitle={`Edit ${envSet.name}`}
      onDelete={() =>
        askConfirm({
          title: `Delete ${envSet.name}?`,
          body: 'This removes the set only. The connections in it are untouched.',
          confirmLabel: 'Delete set',
          destructive: true,
          onConfirm: () => void removeEnvSet(envSet.id),
        })
      }
      deleteTitle={`Delete ${envSet.name}`}
      pinned={envSet.pinned}
      onPin={() => void togglePin('envSet', envSet.id)}
      tone={hasProd ? 'warn' : 'normal'}
    />
  );
}

/// Written out as whole class strings, never interpolated. Tailwind scans
/// source text for class names, so `text-${colour}-300/70` emits no CSS at
/// all — the badge would render in the inherited colour and look broken.
///
/// The muting that keeps the badge below the connection's own name lives
/// in the token, not in an opacity modifier here: how far a hue has to be
/// pulled back to sit under the name is not the same on both grounds.
const TAG_TEXT: Record<Variant, string> = {
  postgres: 'text-tag-sky',
  redshift: 'text-tag-rose',
  'aurora-postgres': 'text-tag-cyan',
  cockroach: 'text-tag-violet',
  timescale: 'text-tag-indigo',
  mysql: 'text-tag-amber',
  mariadb: 'text-tag-orange',
  'aurora-mysql': 'text-tag-cyan',
  sqlite: 'text-tag-emerald',
  dynamodb: 'text-tag-blue',
};

/// The same colours as a dot, for widths too narrow to spell the name.
const TAG_DOT: Record<Variant, string> = {
  postgres: 'bg-tag-sky',
  redshift: 'bg-tag-rose',
  'aurora-postgres': 'bg-tag-cyan',
  cockroach: 'bg-tag-violet',
  timescale: 'bg-tag-indigo',
  mysql: 'bg-tag-amber',
  mariadb: 'bg-tag-orange',
  'aurora-mysql': 'bg-tag-cyan',
  sqlite: 'bg-tag-emerald',
  dynamodb: 'bg-tag-blue',
};

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
    <Row
      label={connection.name}
      detail={detailFor(connection)}
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
      // A prod connection is worth spotting at a glance, before you run
      // anything — but only where the section heading is not already saying
      // it. Six identical chips under a heading that reads PROD teaches you
      // to stop seeing amber.
      tone={connection.env === 'prod' ? 'warn' : 'normal'}
      mark={connection.env === 'prod' && showEnv ? 'prod' : undefined}
      selected={selection?.kind === 'connection' && selection.id === connection.id}
      onClick={() => select({ kind: 'connection', id: connection.id })}
    />
  );
}

function Section({
  label,
  action,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
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
            {label}
          </button>
        ) : (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
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

