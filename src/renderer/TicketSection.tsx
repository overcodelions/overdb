import { useState } from 'react';
import type { BaselineRecord, TicketState } from '@shared/instances';
import { useStore } from './store';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { isTarget, routeTo, targetItems, useTickets } from './ticketsStore';

// Branches in the sidebar: the small databases you make per ticket from a
// base, nested under the connection they were made from.
// See docs/design/baselines.md.

export const PROXY_CONNECTION_ID = 'overdb-proxy';

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

function since(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/// The branches made from one connection, nested under it in the sidebar:
/// "What services see" while the proxy runs, each branch, and the base they
/// are made from. `sourceConnectionId` null gathers branches whose source
/// connection is gone, so none goes missing.
export function Branches({
  sourceConnectionId,
  query,
  folded,
  onToggle,
}: {
  sourceConnectionId: string | null;
  query: string;
  folded: boolean;
  onToggle(): void;
}): JSX.Element | null {
  const t = useTickets();
  const setSheet = useStore((s) => s.setSheet);
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const connections = useStore((s) => s.connections);
  const hasProxyConn = connections.some((c) => c.id === PROXY_CONNECTION_ID);

  if (!t.loaded) return null;
  const known = new Set(connections.map((c) => c.id));
  const mine = (sourceId: string) => (sourceConnectionId === null ? !known.has(sourceId) : sourceId === sourceConnectionId);
  const base = sourceConnectionId === null ? undefined : t.baselines.find((b) => b.sourceConnectionId === sourceConnectionId);
  const all = [...t.tickets].filter((x) => mine(x.sourceConnectionId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!base && all.length === 0) return null;
  const branches = all.filter((x) => !query || `${x.name} ${x.note}`.toLowerCase().includes(query));

  // The proxy's server is your own; its read-only window sits with the
  // branches of the connection that has a base, the first if several do.
  const target = t.proxy?.config.target;
  const routed = target?.kind === 'ticket' ? t.tickets.find((x) => x.id === target.id) : undefined;
  const proxyHome = routed?.sourceConnectionId ?? t.baselines[0]?.sourceConnectionId;
  const showProxy = !!t.proxy?.running && hasProxyConn && proxyHome === sourceConnectionId;
  const proxySelected = selection?.kind === 'connection' && selection.id === PROXY_CONNECTION_ID;
  const seeing = routed?.name ?? (target?.kind === 'ticket' ? 'a branch' : 'your own server');
  const serving = routed && all.some((x) => x.id === routed.id) ? routed : undefined;
  const newBranch = () => setSheet({ kind: 'tickets' });

  if (folded) {
    return (
      <button
        onClick={onToggle}
        aria-expanded={false}
        className="ml-9 mr-2 mb-1 w-[calc(100%-44px)] flex items-center gap-1.5 px-2 py-1 rounded-[6px] bg-accent/10 hover:bg-accent/15 text-left text-[11px]"
      >
        <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" className="text-ink-faint"><path d="M2 1l4 3-4 3z" fill="currentColor" /></svg>
        <span className="flex-1 truncate text-ink">{all.length === 1 ? '1 branch' : `${all.length} branches`}</span>
        {serving && <span className="shrink-0 text-[9px] font-bold px-1.5 py-px rounded-[4px] bg-accent-strong text-white">{serving.name}</span>}
      </button>
    );
  }

  return (
    <div className="ml-[34px] mr-2 mb-1.5 pl-2 border-l border-accent/35 flex flex-col gap-px">
      <div className="flex items-center gap-1.5 pt-1 pb-0.5 pr-0.5">
        <button
          onClick={onToggle}
          aria-expanded={true}
          className="flex-1 flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-wider text-accent-strong hover:text-ink text-left"
        >
          <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" className="rotate-90"><path d="M2 1l4 3-4 3z" fill="currentColor" /></svg>
          <BranchIcon />
          Branches{all.length ? ` · ${all.length}` : ''}
        </button>
        {base && (
          <button
            onClick={newBranch}
            title="New branch from the base"
            className="h-5 px-1.5 rounded-[5px] bg-accent/15 hover:bg-accent/25 text-[10.5px] text-ink"
          >
            + New
          </button>
        )}
      </div>
      {showProxy && (
        <button
          onClick={() => select({ kind: 'connection', id: PROXY_CONNECTION_ID })}
          className={`group/see flex items-center gap-2 px-1.5 py-1 rounded-[6px] border text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            proxySelected ? 'bg-accent/25 border-accent/60' : 'bg-accent/10 border-accent/25 hover:bg-accent/20 hover:border-accent/50'
          }`}
          title="A read-only connection through the proxy: it queries whatever the Services switch points at"
        >
          <span className="text-accent-strong shrink-0" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </span>
          <span className="flex-1 min-w-0 flex flex-col">
            <span className={`text-[11.5px] truncate text-ink ${proxySelected ? 'font-semibold' : 'font-medium'}`}>What services see</span>
            <span className="text-[10px] text-ink-muted truncate">{seeing} · read-only</span>
          </span>
          <span className={`shrink-0 text-[10.5px] text-accent-strong ${proxySelected ? 'hidden' : 'opacity-0 group-hover/see:opacity-100'}`} aria-hidden="true">Open →</span>
        </button>
      )}
      {all.length === 0 ? (
        <p className="px-1.5 py-1 text-[11px] text-ink-muted">
          No branches yet. <button className="text-accent-strong hover:underline" onClick={newBranch}>Make one</button> for the ticket you are on.
        </p>
      ) : (
        branches.map((x) => <CopyRow key={x.id} ticket={x} />)
      )}
      {base && (
        <div className="flex items-center gap-2 px-1.5 pt-1 text-[10.5px] text-ink-muted">
          <span className="flex-1 min-w-0 flex items-center gap-1" title={`The base every branch starts from: a small copy of ${base.sourceName}, built ${since(base.builtAt)}`}>
            <span className="shrink-0">Base ·</span>
            <BaselineName baseline={base} />
          </span>
          <button className="text-accent-strong hover:underline" onClick={() => setSheet({ kind: 'baseline', connectionId: base.sourceConnectionId })}>
            Rebuild
          </button>
        </div>
      )}
    </div>
  );
}

function BranchIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="7" r="2.5" /><path d="M6 7.5v9" /><path d="M18 9.5c0 4-6 3.5-11 7" />
    </svg>
  );
}

function CopyRow({ ticket }: { ticket: TicketState }): JSX.Element {
  const t = useTickets();
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const selection = useStore((s) => s.selection);
  const [menu, setMenu] = useState(false);
  const selected = selection?.kind === 'connection' && selection.id === ticket.connectionId;
  const serving = !!t.proxy?.running && isTarget(t, { kind: 'ticket', id: ticket.id });
  const busy = t.busy[ticket.id];
  const item = targetItems(t).find((i) => i.target.kind === 'ticket' && i.target.id === ticket.id);

  return (
    <div
      className={`group relative mx-1 flex items-center gap-2 pl-2 pr-1 py-1 rounded-[6px] ${selected ? 'bg-accent/25' : 'hover:bg-wash-strong'}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <button
        onClick={() => select({ kind: 'connection', id: ticket.connectionId })}
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
        title={ticket.note || ticket.name}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${ticket.running ? 'bg-good' : 'border-[1.5px] border-ink-faint'}`}
          aria-label={ticket.running ? 'Running' : 'Stopped'}
        />
        <span className="min-w-0 flex flex-col">
          <span className={`text-[12px] truncate ${selected ? 'font-semibold text-ink' : ticket.running ? 'text-ink' : 'text-ink-muted'}`}>{ticket.name}</span>
          <span className="text-[10.5px] text-ink-muted truncate">
            {busy ?? (ticket.running ? `${ticket.note ? `${ticket.note} · ` : ''}:${ticket.port}` : `stopped · ${since(ticket.createdAt)}`)}
          </span>
        </span>
      </button>
      {serving && (
        <span className="shrink-0 text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded-[4px] bg-accent-strong text-white group-hover:hidden" title="Your services reach this branch">
          SERVICES
        </span>
      )}
      <span className={`shrink-0 items-center gap-1 ${menu ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'}`}>
        <button
          onClick={() => setSheet({ kind: 'seed', connectionId: ticket.connectionId })}
          className="h-[22px] px-1.5 rounded-[5px] border border-ai/40 text-ai text-[10.5px] hover:bg-ai/10"
          aria-label={`Seed ${ticket.name}`}
        >
          Seed
        </button>
        <button
          onClick={() => setMenu(!menu)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`More for ${ticket.name}`}
          className="w-[22px] h-[22px] rounded-[5px] bg-wash-strong text-ink hover:bg-accent/20"
        >
          ⋯
        </button>
      </span>
      <Dropdown open={menu} onClose={() => setMenu(false)} label={ticket.name} width={250}>
        {t.proxy?.running && item && !serving && (
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
