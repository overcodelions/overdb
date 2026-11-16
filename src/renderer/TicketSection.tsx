import { useState } from 'react';
import type { BaselineRecord, ProxyState, TicketState } from '@shared/instances';
import { baseIsNewer, baseOf, proxyConnectionId } from '@shared/instances';
import { useStore } from './store';
import { AgentMark } from './AgentMark';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { isTarget, proxyFor, routeTo, targetItems, useTickets } from './ticketsStore';

// Branches in the sidebar: the small databases you make from a
// base, nested under the connection they were made from.
// See docs/design/baselines.md.

/// A base's name, renamed in place: click it (or the pencil), type,
/// Enter to keep, Escape to leave it as it was.
export function BaselineName({ baseline, className = '' }: { baseline: BaselineRecord; className?: string }): JSX.Element {
  const rename = useTickets((s) => s.renameBaseline);
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const done = (keep: boolean) => {
      const name = draft.trim();
      setDraft(null);
      if (keep && name && name !== baseline.label) void rename(baseline.id, name);
    };
    return (
      <input
        autoFocus
        aria-label="Base name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done(true);
          if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        }}
        className={`min-w-0 px-1 -mx-1 rounded-[4px] bg-surface border border-accent/60 text-ink outline-none ${className}`}
      />
    );
  }
  return (
    <button
      onClick={() => setDraft(baseline.label)}
      title="Rename this base"
      className={`group/name inline-flex items-center gap-1 min-w-0 rounded-[4px] hover:text-ink ${className}`}
    >
      <span className="truncate">{baseline.label}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 opacity-0 group-hover/name:opacity-70">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}

export function since(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/// The connection that shows what a base's services see, or null while its
/// proxy is not running. Usually the proxy's own read-only connection; when
/// the proxy points at a shared server it has no window of its own, so this
/// is the server's connection rather than a second copy holding its password.
export function servicesView(
  t: { proxies: ProxyState[] },
  connections: { id: string }[],
  sourceConnectionId: string,
): string | null {
  const proxy = proxyFor(t, sourceConnectionId);
  if (!proxy?.running) return null;
  const proxyId = proxyConnectionId(sourceConnectionId);
  const throughSource = proxy.config.target.kind === 'server' && !connections.some((c) => c.id === proxyId);
  const id = throughSource ? sourceConnectionId : proxyId;
  return connections.some((c) => c.id === id) ? id : null;
}

/// How many branches a connection shows before "+ N more". The one your
/// services reach and the one you are in always show, whatever the cap.
const BRANCHES_SHOWN = 2;

/// The branches made from one connection, as plain rows under it. Managing
/// them — a new one, the base, what services see — lives in the
/// connection's menu and the Services switch, not in the list.
/// `sourceConnectionId` null gathers branches whose source connection is
/// gone, so none goes missing.
export function Branches({
  sourceConnectionId,
  query,
  showAll,
  onToggleAll,
}: {
  sourceConnectionId: string | null;
  /// Set only when the connection itself did not match: its branches are
  /// then narrowed to the ones that did.
  query: string;
  showAll: boolean;
  onToggleAll(): void;
}): JSX.Element | null {
  const t = useTickets();
  const connections = useStore((s) => s.connections);
  const selection = useStore((s) => s.selection);
  if (!t.loaded) return null;
  const known = new Set(connections.map((c) => c.id));
  const mine = (id: string) => (sourceConnectionId === null ? !known.has(id) : id === sourceConnectionId);
  const all = t.tickets.filter((x) => mine(x.sourceConnectionId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const matching = query ? all.filter((x) => `${x.name} ${x.note}`.toLowerCase().includes(query)) : all;
  if (matching.length === 0) return null;
  const remote = !!sourceConnectionId && connections.find((c) => c.id === sourceConnectionId)?.env !== 'local';

  // Folding one row behind "+ 1 more" saves nothing, so the cap applies
  // only when it hides at least two.
  const canFold = !query && matching.length > BRANCHES_SHOWN + 1;
  let shown = matching;
  if (canFold && !showAll) {
    const always = new Set(
      matching
        .filter(
          (x) =>
            (selection?.kind === 'connection' && selection.id === x.connectionId) ||
            (!!proxyFor(t, x.sourceConnectionId)?.running && isTarget(t, x.sourceConnectionId, { kind: 'ticket', id: x.id })),
        )
        .map((x) => x.id),
    );
    const newest = [...matching]
      .reverse()
      .filter((x) => !always.has(x.id))
      .slice(0, Math.max(0, BRANCHES_SHOWN - always.size))
      .map((x) => x.id);
    const ids = new Set([...always, ...newest]);
    shown = matching.filter((x) => ids.has(x.id));
  }

  return (
    <div className="relative flex flex-col gap-px pb-0.5">
      {/* A guide down from the connection's tile, so the rows under it read
          as its branches rather than as more connections. */}
      {sourceConnectionId !== null && (
        <span aria-hidden="true" className="absolute left-[23px] -top-1 bottom-3 w-px bg-accent/35" />
      )}
      {shown.map((x) => (
        <CopyRow key={x.id} ticket={x} remote={remote} />
      ))}
      {canFold && (
        <button
          onClick={onToggleAll}
          aria-expanded={showAll}
          className="self-start ml-[42px] h-5 text-[11px] text-ink-muted hover:text-ink"
        >
          {showAll ? 'Show fewer' : `+ ${matching.length - shown.length} more`}
        </button>
      )}
    </div>
  );
}

/// Services reach this: the Services switch's own mark.
export function RoutedIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h11" /><path d="M12 3l4 4-4 4" /><path d="M20 17H9" /><path d="M12 13l-4 4 4 4" />
    </svg>
  );
}

function BranchIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="7" r="2.5" /><path d="M6 7.5v9" /><path d="M18 9.5c0 4-6 3.5-11 7" />
    </svg>
  );
}

/// One branch, on one line: its name, whether services reach it, and
/// whether it runs. The port, its note and anything else worth knowing are
/// on hover; what you can do with it is behind ⋯ or a right click.
function CopyRow({ ticket, remote }: { ticket: TicketState; remote: boolean }): JSX.Element {
  const t = useTickets();
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const selection = useStore((s) => s.selection);
  // The branch's own connection: agents reach a branch only when it is
  // exposed itself, never through the connection it was made from.
  const conn = useStore((s) => s.connections.find((c) => c.id === ticket.connectionId));
  const connState = useStore((s) => s.connState[ticket.connectionId]);
  const [menu, setMenu] = useState(false);
  const selected = selection?.kind === 'connection' && selection.id === ticket.connectionId;
  const proxy = proxyFor(t, ticket.sourceConnectionId);
  const serving = !!proxy?.running && isTarget(t, ticket.sourceConnectionId, { kind: 'ticket', id: ticket.id });
  const busy = t.busy[ticket.id];
  const item = targetItems(t, ticket.sourceConnectionId).find((i) => i.target.kind === 'ticket' && i.target.id === ticket.id);
  const newer = baseIsNewer(ticket, baseOf(ticket, t.baselines));
  const tip = [
    ticket.note ? `${ticket.name} — ${ticket.note}` : ticket.name,
    ticket.running ? `Running on port ${ticket.port}` : `Stopped · made ${since(ticket.createdAt)}`,
    serving ? 'Your services reach this branch' : null,
    newer ? 'Its base is newer — Reset to base takes the fresh data' : null,
    remote ? 'Runs on this machine, from a copy of the server: writing to it never touches the server' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className={`group sidebar-row relative mx-1.5 rounded-md pl-[36px] pr-1 h-6 flex items-center gap-2 ${selected ? 'sidebar-row-selected' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <button
        onClick={() => select({ kind: 'connection', id: ticket.connectionId })}
        title={tip}
        className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left rounded outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        {/* Green means connected, everywhere: the same pip on the same corner
            as a connection's engine tile. */}
        <span className="relative shrink-0 flex text-accent-strong">
          <BranchIcon />
          {(connState === 'open' || connState === 'error') && (
            <span
              role="img"
              aria-label={connState === 'open' ? 'Connected' : 'Last attempt failed'}
              title={connState === 'open' ? 'Connected' : 'Last attempt failed'}
              className={`status-pip ${connState === 'open' ? 'bg-good' : 'bg-bad'}`}
            />
          )}
        </span>
        <span className={`text-[12px] truncate ${selected ? 'font-semibold text-ink' : ticket.running ? 'text-ink' : 'text-ink-muted'}`}>{ticket.name}</span>
        {busy && <span className="shrink-0 text-[10.5px] text-ink-muted">{busy}</span>}
      </button>
      {/* Whether services reach it and whether it runs stay put on hover —
          state is not something to lose the moment you point at it. The ⋯
          appears beside them. */}
      <span className="shrink-0 flex items-center gap-1.5 pr-1.5">
        {conn && <AgentMark connection={conn} />}
        {serving && (
          <span role="img" aria-label="Your services reach this branch" title="Your services reach this branch" className="text-accent-strong flex">
            <RoutedIcon />
          </span>
        )}
        {/* Running is the usual state and carries no mark; stopped is the
            exception, so it is the one that shows. */}
        {!ticket.running && (
          <span
            role="img"
            aria-label="Stopped"
            title="Stopped — start it from its menu"
            className="w-[7px] h-[7px] rounded-full border-[1.5px] border-ink-faint"
          />
        )}
      </span>
      <span className={`shrink-0 items-center ${menu ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'}`}>
        <button
          onClick={() => setMenu(!menu)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`More for ${ticket.name}`}
          title={`More for ${ticket.name}`}
          className="w-[22px] h-5 flex items-center justify-center rounded-[5px] text-ink-muted hover:text-ink hover:bg-card"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <circle cx="2.5" cy="6" r="1.1" />
            <circle cx="6" cy="6" r="1.1" />
            <circle cx="9.5" cy="6" r="1.1" />
          </svg>
        </button>
      </span>
      <Dropdown open={menu} onClose={() => setMenu(false)} label={ticket.name} width={250}>
        {proxy?.running && item && !serving && (
          <MenuItem
            label={`Services use ${ticket.name}`}
            kbd={item.digit !== null ? `⌥⌘${item.digit}` : undefined}
            onSelect={() => {
              setMenu(false);
              void routeTo(item);
            }}
          />
        )}
        <MenuItem label="Open" onSelect={() => { setMenu(false); select({ kind: 'connection', id: ticket.connectionId }); }} />
        <MenuItem tone="ai" label="Seed for the ticket…" onSelect={() => { setMenu(false); setSheet({ kind: 'seed', connectionId: ticket.connectionId }); }} />
        <MenuItem label="How to connect…" onSelect={() => { setMenu(false); setSheet({ kind: 'tickets' }); }} />
        <MenuDivider />
        {ticket.running ? (
          <MenuItem label="Stop" detail="Keeps its data" onSelect={() => { setMenu(false); void t.stop(ticket.id); }} />
        ) : (
          <MenuItem label="Start" onSelect={() => { setMenu(false); void t.start(ticket.id); }} />
        )}
        <MenuItem
          label="Reset to base…"
          detail={newer ? 'The base is newer — takes its fresh data' : 'Throws away this branch’s changes'}
          onSelect={() => {
            setMenu(false);
            askConfirm({
              title: `Reset ${ticket.name} to its base?`,
              body: newer
                ? 'Its data is replaced with the base as rebuilt — the fresher data. Everything written to this branch since it was made is lost. Its name, port and connection stay, so nothing pointed at it changes.'
                : 'Its data goes back to the base as it is. Everything written to this branch since it was made is lost. Its name, port and connection stay, so nothing pointed at it changes.',
              confirmLabel: 'Reset branch',
              destructive: true,
              onConfirm: () => void t.reset(ticket.id),
            });
          }}
        />
        <MenuItem
          label="Delete…"
          onSelect={() => {
            setMenu(false);
            askConfirm({
              title: `Delete ${ticket.name}?`,
              body: 'This stops the branch and deletes its data and its connection. The base is not touched.',
              confirmLabel: 'Delete branch',
              destructive: true,
              onConfirm: () => void t.remove(ticket.id),
            });
          }}
        />
      </Dropdown>
    </div>
  );
}
