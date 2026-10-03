import { useState } from 'react';
import type { TicketState } from '@shared/instances';
import { addressLine, connectSnippets } from '@shared/ticketConnect';
import { useStore } from './store';
import { useTickets } from './ticketsStore';

// How to use a ticket copy: in overdb, from one service, from all of them
// through the proxy, and how to go back. Every address and string is this
// copy's own — its port, the source connection's user and database.

const SMALL = 'h-6 px-2 rounded-[5px] border border-card text-[11px] text-ink hover:bg-wash-strong disabled:opacity-40';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5">
      <span className="w-[20px] h-[20px] rounded-full bg-accent/15 text-accent-strong text-[11px] font-bold flex items-center justify-center">{n}</span>
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="font-semibold">{title}</div>
        {children}
      </div>
    </li>
  );
}

export function TicketGuide({ ticket, inTicketsSheet = false }: { ticket: TicketState; inTicketsSheet?: boolean }): JSX.Element {
  const conn = useStore((s) => s.connections.find((c) => c.id === ticket.connectionId));
  const source = useStore((s) => s.connections.find((c) => c.id === ticket.sourceConnectionId));
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const t = useTickets();
  const live = t.tickets.find((x) => x.id === ticket.id) ?? ticket;
  const proxy = t.proxy;
  const [tab, setTab] = useState('env');
  const [copied, setCopied] = useState<string | null>(null);

  const address = {
    engine: conn?.engine ?? 'mysql',
    host: '127.0.0.1',
    port: live.port,
    user: conn?.user ?? source?.user ?? 'root',
    database: conn?.database || conn?.defaultSchema || null,
  } as const;
  const snippets = connectSnippets(address);
  const shown = snippets.find((x) => x.id === tab) ?? snippets[0];
  const serving = proxy?.running && proxy.config.target.kind === 'ticket' && proxy.config.target.id === ticket.id;
  const copy = (id: string, text: string) => {
    void window.overdb.invoke('app:copyText', text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      {!live.running && (
        <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 flex items-center gap-2">
          <span className="flex-1">{ticket.name} is stopped. Start it to connect — its data is as you left it.</span>
          <button className={SMALL} disabled={!!t.busy[ticket.id]} onClick={() => void t.start(ticket.id)}>Start</button>
        </div>
      )}
      <ol className="flex flex-col gap-4">
        <Step n={1} title="Use it in overdb">
          <p className="text-ink-muted">It is in your connections as <b className="text-ink">{conn?.name ?? `${ticket.name} · branch`}</b>, with writes on. Seed it for the ticket, run anything — the base is never touched.</p>
          <div className="flex gap-1.5">
            <button className={SMALL} onClick={() => { select({ kind: 'connection', id: ticket.connectionId }); setSheet(null); }}>Open it</button>
            <button className={`${SMALL} text-ai`} onClick={() => setSheet({ kind: 'seed', connectionId: ticket.connectionId })}>Seed it</button>
          </div>
        </Step>

        <Step n={2} title="Point one service at it">
          <p className="text-ink-muted">
            It listens at <span className="font-mono text-ink">{addressLine(address)}</span>. The password is the same as your local server’s. Change the service’s database settings, then restart it so its pool reconnects.
          </p>
          <div className="rounded-md border border-card overflow-hidden">
            <div className="flex items-center gap-1 px-1.5 pt-1.5 border-b border-card bg-surface-muted/60" role="tablist">
              {snippets.map((x) => (
                <button
                  key={x.id}
                  role="tab"
                  aria-selected={x.id === shown.id}
                  className={`h-6 px-2 rounded-t-[4px] text-[11px] ${x.id === shown.id ? 'bg-surface-elevated text-ink font-semibold' : 'text-ink-muted hover:text-ink'}`}
                  onClick={() => setTab(x.id)}
                >
                  {x.label}
                </button>
              ))}
              <span className="flex-1" />
              <button className={`${SMALL} mb-1`} onClick={() => copy(shown.id, shown.text)}>{copied === shown.id ? 'Copied' : 'Copy'}</button>
            </div>
            <pre className="font-mono text-[11px] leading-[17px] whitespace-pre-wrap break-all px-3 py-2 bg-surface-elevated">{shown.text}</pre>
          </div>
        </Step>

        <Step n={3} title="Or switch services with one click, through the proxy">
          {!proxy?.running ? (
            <>
              <p className="text-ink-muted">
                Turn on the proxy and point each service at it once — a spare port such as <span className="font-mono text-ink">127.0.0.1:3310</span>. After that,
                which database they see is a click in overdb: your own server, {ticket.name}, or any other branch.
              </p>
              {inTicketsSheet ? (
                <p className="text-ink-muted">Set it up in <b className="text-ink">What your services connect to</b>, on the right.</p>
              ) : (
                <button className={`${SMALL} self-start`} onClick={() => setSheet({ kind: 'tickets' })}>Set up the proxy…</button>
              )}
            </>
          ) : (
            <>
              <p className="text-ink-muted">
                Services pointed at <span className="font-mono text-ink">127.0.0.1:{proxy.config.port}</span>
                {proxy.config.socket ? <> (or <span className="font-mono text-ink">{proxy.config.socket}</span>)</> : null} reach whichever database you pick.
              </p>
              {serving ? (
                <p><b>They see {ticket.name} now.</b> <span className="text-ink-muted">Each one reaches it on its next query — no restarts.</span></p>
              ) : (
                <button className={`${SMALL} self-start`} disabled={!!t.busy.proxy} onClick={() => void t.route({ kind: 'ticket', id: ticket.id })}>
                  Services use {ticket.name}
                </button>
              )}
            </>
          )}
        </Step>

        <Step n={4} title="When you’re done">
          <p className="text-ink-muted">
            {serving
              ? <>Send your services back to your own server, then stop or delete the branch. </>
              : <>Point any service you changed back at your own server (port {proxy?.running && proxy.config.socket ? proxy.config.server.port : source?.port ?? 3306}). </>}
            <b className="text-ink">Stop</b> keeps its data for later; <b className="text-ink">Delete</b> throws it away. The base stays either way.
          </p>
          {serving && (
            <button className={`${SMALL} self-start`} disabled={!!t.busy.proxy} onClick={() => void t.route({ kind: 'server' })}>Back to your own server</button>
          )}
        </Step>
      </ol>
    </div>
  );
}
