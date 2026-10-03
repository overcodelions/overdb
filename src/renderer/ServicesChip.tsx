import { useState } from 'react';
import { useStore } from './store';
import { Dropdown, MenuDivider, MenuItem } from './Menu';
import { isTarget, routeTo, targetItems, useTickets } from './ticketsStore';

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

/// The switch for your services, in the window's title bar: it is about the
/// whole machine, not the connection you are looking at, and it never
/// changes what a tab queries.
export function ServicesChip(): JSX.Element | null {
  const t = useTickets();
  const setSheet = useStore((s) => s.setSheet);
  const [open, setOpen] = useState(false);

  // Nothing to switch between until there is a baseline.
  if (!t.loaded || (t.baselines.length === 0 && t.tickets.length === 0)) return null;

  const p = t.proxy;
  const items = targetItems(t);
  const current = items.find((i) => isTarget(t, i.target));
  const onTicket = p?.running && p.config.target.kind === 'ticket';
  const starting = onTicket && current && !current.running;
  const helperDown = !!t.helper?.installed && !t.helper.running;
  const background = !!t.helper?.installed && !!t.helper.running;

  const tone = !p?.running
    ? 'border-dashed border-ink-faint/50 text-ink-muted hover:text-ink'
    : starting || helperDown
      ? 'border-warn/50 bg-warn/10 text-warn-strong'
      : onTicket
        ? 'border-accent/60 bg-accent/15 text-ink'
        : 'border-card text-ink hover:bg-wash-strong';

  return (
    <div className="relative no-drag mr-2">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        title="Which database your services reach through overdb"
        onClick={() => setOpen(!open)}
        className={`h-6 px-2 rounded-md border text-[11.5px] flex items-center gap-1.5 ${tone}`}
      >
        {background && p?.running && <span className="w-1.5 h-1.5 rounded-full bg-good" aria-label="Runs in the background" />}
        <span className="opacity-80"><SwitchIcon /></span>
        <span className="text-ink-muted">Services</span>
        <span className="font-semibold">
          {!p?.running ? 'not routed' : current?.target.kind === 'server' ? 'your server' : current?.label ?? 'a branch'}
        </span>
        {starting && <span className="text-warn-strong">· starting</span>}
        <span className="text-ink-muted" aria-hidden="true">▾</span>
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} label="What your services connect to" width={340}>
        {p?.running ? (
          <>
            <div className="px-2.5 pt-1.5 pb-2 border-b border-card mb-1">
              <div className="text-[12px] font-semibold text-ink">Your services connect to</div>
              <div className="text-[11px] text-ink-muted">
                <span className="font-mono text-ink">127.0.0.1:{p.config.port}</span>
                {p.config.socket ? <> and <span className="font-mono">{p.config.socket}</span></> : null} · {p.connections} open
              </div>
            </div>
            {items.map((i) => {
              const on = isTarget(t, i.target);
              return (
                <button
                  key={i.target.kind === 'server' ? 'server' : i.target.id}
                  role="menuitemradio"
                  aria-checked={on}
                  disabled={!!t.busy.proxy}
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
            <MenuDivider />
            <MenuItem icon={<span className="text-accent-strong"><TicketsIcon /></span>} label="Branches…" detail="Branches, bases, the proxy and running in the background" onSelect={() => { setOpen(false); setSheet({ kind: 'tickets' }); }} />
            <MenuItem icon={<span className="text-bad"><PowerIcon /></span>} label="Turn the proxy off" detail={`Stops listening on :${p.config.port} — your services can't connect`} onSelect={() => { setOpen(false); void t.configure({ enabled: false }); }} />
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
            <MenuItem icon={<span className="text-accent-strong"><PowerIcon /></span>} label="Set up the proxy…" detail="A spare port such as 3310 — your server stays where it is" onSelect={() => { setOpen(false); setSheet({ kind: 'tickets' }); }} />
          </>
        )}
      </Dropdown>
    </div>
  );
}
