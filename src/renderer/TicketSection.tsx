import { useState } from 'react';
import type { BaselineRecord, TicketState } from '@shared/instances';
import { baseIsNewer, baseOf, proxyConnectionId } from '@shared/instances';
import { useStore } from './store';
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
  if (!t.loaded) return null;
  const known = new Set(connections.map((c) => c.id));
  const mine = (sourceId: string) => (sourceConnectionId === null ? !known.has(sourceId) : sourceId === sourceConnectionId);
  const base = sourceConnectionId === null ? undefined : t.baselines.find((b) => b.sourceConnectionId === sourceConnectionId);
  const all = [...t.tickets].filter((x) => mine(x.sourceConnectionId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!base && all.length === 0) return null;
  const branches = all.filter((x) => !query || `${x.name} ${x.note}`.toLowerCase().includes(query));

  // Each base has its own proxy; its read-only window sits with that base's
  // branches.
  const proxy = proxyFor(t, sourceConnectionId ?? undefined);
  const proxyId = sourceConnectionId ? proxyConnectionId(sourceConnectionId) : '';
  const target = proxy?.config.target;
  const routed = target?.kind === 'ticket' ? t.tickets.find((x) => x.id === target.id) : undefined;
  // A shared server's proxy pointed at the server itself has no window of its
  // own: services see that server, which is already a connection — the row
  // opens it rather than a second copy holding its password.
  const throughSource = !!proxy?.running && target?.kind === 'server' && !connections.some((c) => c.id === proxyId);
  const seeId = throughSource && sourceConnectionId ? sourceConnectionId : proxyId;
  const showProxy = !!proxy?.running && connections.some((c) => c.id === seeId);
  const proxySelected = selection?.kind === 'connection' && selection.id === proxyId;
  const seeing = routed?.name ?? (target?.kind === 'ticket' ? 'a branch' : 'its own server');
  const serving = routed && all.some((x) => x.id === routed.id) ? routed : undefined;
  const newBranch = () => setSheet({ kind: 'tickets' });
  const remoteSource = !!sourceConnectionId && connections.find((c) => c.id === sourceConnectionId)?.env !== 'local';

  if (folded) {
    return (
      <button
        onClick={onToggle}
        aria-expanded={false}
        className="ml-9 mr-2 mb-1 w-[calc(100%-44px)] flex items-center gap-1.5 px-2 py-1 rounded-[6px] bg-accent/10 hover:bg-accent/15 text-left text-[11px]"
      >
        <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" className="text-ink-faint"><path d="M2 1l4 3-4 3z" fill="currentColor" /></svg>
        <span className="flex-1 truncate text-ink">{all.length === 1 ? '1 branch' : `${all.length} branches`}{remoteSource && <span className="text-ink-muted"> · local</span>}</span>
        {serving && <span className="shrink-0 text-[9.5px] font-semibold px-1.5 rounded-[4px] border border-accent/45 text-accent-strong">{serving.name}</span>}
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
        <BranchesInfo />
        {remoteSource && (
          // Under a shared server, say plainly that these are not on it.
          <span className="flex items-center gap-1 text-[10px] text-ink-muted" title="Branches run on this machine, made from a copy of this server — writing to one never touches it">
            <span className="w-1.5 h-1.5 rounded-full bg-good" aria-hidden="true" />
            local
          </span>
        )}
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
          onClick={() => select({ kind: 'connection', id: seeId })}
          className={`group/see mx-1 flex items-center gap-2 pl-2 pr-1 py-1 rounded-[6px] text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            proxySelected ? 'bg-accent/25' : 'hover:bg-wash-strong'
          }`}
          title={throughSource ? 'Services reach the server itself: this opens its connection' : 'A read-only connection through the proxy: it queries whatever the Services switch points at'}
        >
          <span className="w-2 shrink-0 flex justify-center text-accent-strong" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </span>
          <span className="flex-1 min-w-0 flex flex-col">
            <span className={`text-[12px] truncate ${proxySelected ? 'font-semibold text-ink' : 'text-ink'}`}>What services see</span>
            <span className="text-[10.5px] text-ink-muted truncate">{throughSource ? 'its own server · opens it' : `${seeing} · read-only`}</span>
          </span>
        </button>
      )}
      {all.length === 0 ? (
        <p className="px-1.5 py-1 text-[11px] leading-relaxed text-ink-muted">
          {BRANCH_IS} <button className="text-accent-strong hover:underline" onClick={newBranch}>Make one</button> for a ticket, or just to try something.
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

const BRANCH_IS = 'A branch is your own writable copy of this database — for a ticket, an experiment, anything — made in seconds from the base. It runs on this machine; nothing you do in it touches the server.';

/// What a branch is, where the question comes up: three lines, and the
/// picture in How overdb works for more.
function BranchesInfo(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  // Placed on the window, not in the sidebar: the list scrolls and clips,
  // and the panel is wider than the room either side of the button.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = at !== null;
  const setOpen = (v: boolean) => { if (!v) setAt(null); };
  return (
    <span className="relative flex">
      <button
        // Its own toggle: kept from the panel's click-outside, which would
        // close it on mousedown only for this click to open it again.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (open) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left - 8, y: r.bottom + 4 });
        }}
        aria-label="What are branches?"
        aria-expanded={open}
        className="w-4 h-4 rounded-full text-[9.5px] font-semibold leading-none border border-ink-faint/50 text-ink-muted hover:text-ink hover:border-ink-muted"
      >
        i
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} label="What are branches?" width={280} at={at ?? undefined} role="dialog">
        <div className="px-2.5 py-2 flex flex-col gap-2 text-[11.5px] leading-relaxed text-ink-muted">
          <p><b className="text-ink">Branch</b> — {BRANCH_IS.replace(/^A branch is /, '')}</p>
          <p><b className="text-ink">Proxy</b> — your services keep one address, and you pick which branch they reach from Services, top right. No config change.</p>
          <p><b className="text-ink">Base</b> — the small copy of the server every branch starts from, with only the clients you picked. Rebuild it for fresher data.</p>
          <button
            className="self-start text-accent-strong hover:underline"
            onClick={() => { setOpen(false); setSheet({ kind: 'basics', section: 'branches' }); }}
          >
            More in How overdb works →
          </button>
        </div>
      </Dropdown>
    </span>
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
  const proxy = proxyFor(t, ticket.sourceConnectionId);
  const serving = !!proxy?.running && isTarget(t, ticket.sourceConnectionId, { kind: 'ticket', id: ticket.id });
  const busy = t.busy[ticket.id];
  const item = targetItems(t, ticket.sourceConnectionId).find((i) => i.target.kind === 'ticket' && i.target.id === ticket.id);
  const newer = baseIsNewer(ticket, baseOf(ticket, t.baselines));

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
            {!busy && newer && <span className="text-accent-strong"> · base is newer</span>}
          </span>
        </span>
      </button>
      {serving && (
        <span className="shrink-0 text-[9.5px] font-semibold px-1.5 rounded-[4px] border border-accent/45 text-accent-strong group-hover:hidden" title="Your services reach this branch">
          services
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
