import { useState } from 'react';
import { useStore } from './store';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { isTarget, routeTo, targetItems, useTickets } from './ticketsStore';
import type { ProxyState } from '@shared/instances';

// "Services → PROJ-123": which database your running services reach through
// overdb, and the place to change it. In the title bar, the same spot always. See docs/design/baselines.md.

function SwitchIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h11" /><path d="M12 3l4 4-4 4" /><path d="M20 17H9" /><path d="M12 13l-4 4 4 4" />
    </svg>
  );
}

function TicketsIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}

function PowerIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v9" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
    </svg>
  );
}

/// A connection's name cut to fit the title bar: "redshift - @sbox" → "redshift".
function shortName(name: string): string {
  return name.split(/\s+[-–·@]\s*|\s+\(/)[0].slice(0, 18);
}

/// The switch for your services, in the window's title bar: it is about the
/// whole machine, not the connection you are looking at, and it never
/// changes what a tab queries. One section per base — each has its own
/// proxy, so a service using two databases is switched in two places.
export function ServicesChip(): JSX.Element | null {
  const t = useTickets();
  const setSheet = useStore((s) => s.setSheet);
  const connections = useStore((s) => s.connections);
  const [open, setOpen] = useState(false);

  // Nothing to switch between until there is a baseline.
  if (!t.loaded || (t.baselines.length === 0 && t.tickets.length === 0)) return null;

  const live = t.proxies.filter((p) => p.running);
  const nameOf = (source: string) =>
    connections.find((c) => c.id === source)?.name ?? t.baselines.find((b) => b.sourceConnectionId === source)?.sourceName ?? 'a base';
  const currentOf = (p: ProxyState) => targetItems(t, p.source).find((i) => isTarget(t, p.source, i.target));
  const onBranch = live.filter((p) => p.config.target.kind === 'ticket');
  // A branch the proxy points at that is not running. It starts at a
  // service's first connection, or here with Start — "starting" is said only
  // while it actually is.
  const stopped = onBranch.filter((p) => !currentOf(p)?.running);
  const idOf = (p: ProxyState) => (p.config.target.kind === 'ticket' ? p.config.target.id : '');
  const starting = stopped.some((p) => !!t.busy[idOf(p)]);
  const helperDown = !!t.helper?.installed && !t.helper.running;
  const background = !!t.helper?.installed && !!t.helper.running;

  const tone = live.length === 0
    ? 'border-dashed border-ink-faint/50 text-ink-muted hover:text-ink'
    : stopped.length > 0 || helperDown
      ? 'border-warn/50 bg-warn/10 text-warn-strong'
      : onBranch.length > 0
        ? 'border-accent/60 bg-accent/15 text-ink'
        : 'border-card text-ink hover:bg-wash-strong';
  // One name when every proxy on a branch is on the same one, the usual
  // case — a ticket switches all its databases together.
  const branchNames = [...new Set(onBranch.map((p) => currentOf(p)?.label ?? 'a branch'))];
  const label =
    live.length === 0
      ? 'not routed'
      : onBranch.length === 0
        ? live.length === 1 ? (connections.find((c) => c.id === live[0].source)?.env === 'local' ? 'your server' : nameOf(live[0].source)) : 'their own servers'
        : branchNames.length === 1 ? branchNames[0] : `${onBranch.length} branches`;

  return (
    <div className="relative no-drag mr-2">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        title="Which database your services reach through overdb"
        onClick={() => setOpen(!open)}
        className={`h-6 px-2 rounded-md border text-[11.5px] flex items-center gap-1.5 ${tone}`}
      >
        {background && live.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-good" aria-label="Runs in the background" />}
        <span className="opacity-80"><SwitchIcon /></span>
        <span className="text-ink-muted">Services</span>
        {live.length > 1 ? (
          // One segment per base, so a second proxy is never hidden behind
          // the first: a branch by name, a base on its own server dimmed.
          live.map((p, n) => {
            const on = p.config.target.kind === 'ticket';
            return (
              <span key={p.source} className="flex items-center gap-1.5" title={`${nameOf(p.source)} → ${on ? currentOf(p)?.label ?? 'a branch' : 'its own server'}`}>
                {n > 0 && <span className="w-px h-3 bg-ink-faint/40" aria-hidden="true" />}
                <span className={on ? 'font-semibold' : 'text-ink-muted'}>{on ? currentOf(p)?.label ?? 'a branch' : shortName(nameOf(p.source))}</span>
              </span>
            );
          })
        ) : (
          <span className="font-semibold">{label}</span>
        )}
        {stopped.length > 0 && <span className="text-warn-strong">· {starting ? 'starting' : 'stopped'}</span>}
        <span className="text-ink-muted" aria-hidden="true">▾</span>
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} label="What your services connect to" width={360}>
        {live.length > 0 ? (
          <>
            {stopped.length > 0 && (
              <>
                <MenuItem
                  icon={<span className="text-warn-strong"><PowerIcon /></span>}
                  label={starting ? 'Starting…' : `Start ${stopped.length === 1 ? currentOf(stopped[0])?.label ?? 'the branch' : `${stopped.length} branches`}`}
                  detail="Your services reach it straight away, rather than waiting on their first connection"
                  disabled={starting}
                  onSelect={() => {
                    setOpen(false);
                    for (const p of stopped) void t.start(idOf(p));
                  }}
                />
                <MenuDivider />
              </>
            )}
            {live.map((p, n) => (
              <div key={p.source} className={n > 0 ? 'mt-1 pt-1 border-t border-card' : ''}>
                <div className="px-2.5 pt-1.5 pb-1.5">
                  <div className="text-[12px] font-semibold text-ink truncate">{nameOf(p.source)}</div>
                  <div className="text-[11px] text-ink-muted">
                    Services connect to <span className="font-mono text-ink">127.0.0.1:{p.config.port}</span>
                    {p.config.socket ? <> and <span className="font-mono">{p.config.socket}</span></> : null} · {p.connections} open
                  </div>
                </div>
                {targetItems(t, p.source).map((x) => {
                  const local = connections.find((c) => c.id === p.source)?.env === 'local';
                  const i = x.target.kind === 'server' ? { ...x, label: local ? 'Your own server' : nameOf(p.source) } : x;
                  const on = isTarget(t, p.source, i.target);
                  return (
                    <button
                      key={i.target.kind === 'server' ? 'server' : i.target.id}
                      role="menuitemradio"
                      aria-checked={on}
                      disabled={!!t.busy[`proxy:${p.source}`]}
                      onClick={() => {
                        setOpen(false);
                        if (!on) void routeTo(i);
                      }}
                      className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[12px] focus:outline-none ${on ? 'bg-accent/20' : 'hover:bg-wash-strong focus:bg-wash-strong'}`}
                    >
                      <span className={`w-3 h-3 rounded-full shrink-0 ${on ? 'border-[4px] border-accent-strong' : 'border-2 border-ink-faint/60'}`} />
                      <span className="flex-1 min-w-0">
                        <span className={`block truncate ${on ? 'font-semibold' : ''} ${i.running ? 'text-ink' : 'text-ink-muted'}`}>{i.label}</span>
                        <span className="block text-[11px] text-ink-muted truncate">{i.detail}</span>
                      </span>
                      {i.digit !== null && <kbd className="font-mono text-[10px] text-ink-faint">⌥⌘{i.digit}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))}
            <MenuDivider />
            <MenuItem
              icon={<span className="text-accent-strong"><TicketsIcon /></span>}
              label="Branches and proxies…"
              detail={onBranch.length ? 'Branches, bases, each base’s proxy · ⌥⌘0 sends all back' : 'Branches, bases, each base’s proxy and running in the background'}
              onSelect={() => { setOpen(false); setSheet({ kind: 'tickets' }); }}
            />
            <div className="mt-1 -mx-1 -mb-1 px-3.5 py-2 border-t border-card rounded-b-lg bg-wash flex items-center gap-2.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${background ? 'bg-good' : helperDown ? 'bg-warn' : 'bg-ink-faint'}`} />
              <span className="text-ink">{background ? 'Runs in the background' : helperDown ? 'Background helper not answering' : 'Runs inside overdb'}</span>
              <span className="text-ink-muted">· {background ? 'keeps going when overdb is closed' : 'stops when overdb quits'}</span>
            </div>
          </>
        ) : (
          <>
            <div className="px-2.5 pt-1.5 pb-2 text-[12px] text-ink-muted">
              Point your services at overdb once, and choosing which database they reach is a click here.
            </div>
            <MenuItem icon={<span className="text-accent-strong"><PowerIcon /></span>} label="Set up a proxy…" detail="One per base, each on a spare port such as 3310 — the server stays where it is" onSelect={() => { setOpen(false); setSheet({ kind: 'tickets' }); }} />
          </>
        )}
      </Dropdown>
    </div>
  );
}
