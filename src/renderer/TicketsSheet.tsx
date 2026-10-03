import { useEffect, useState } from 'react';
import { formatBytes } from '@shared/baseline';
import { SPARE_PROXY_PORT, type ProxyTarget, type TicketState } from '@shared/instances';
import { useStore } from './store';
import { useTickets } from './ticketsStore';
import { TicketGuide } from './TicketGuide';
import { BaselineName } from './TicketSection';

// Ticket databases: the baselines, the copies made from them, and the
// proxy that decides which one your services see. The flow lives in
// ticketsStore.ts; see docs/design/baselines.md.

const BTN = 'h-7 px-3 rounded-[5px] border border-card text-[12px] text-ink hover:bg-wash-strong disabled:opacity-40';
const SMALL = 'h-6 px-2 rounded-[5px] border border-card text-[11px] text-ink hover:bg-wash-strong disabled:opacity-40';
const PRIMARY =
  'h-7 px-3.5 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-[12px] font-semibold disabled:opacity-40 flex items-center gap-2';
const FIELD = 'field h-7 px-2.5 text-[12px]';

function Spinner(): JSX.Element {
  return <span className="w-3 h-3 shrink-0 rounded-full border-2 border-ink-muted/30 border-t-ink-muted animate-spin" aria-label="Working" />;
}

function since(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export function TicketsSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const t = useTickets();

  useEffect(() => {
    void useTickets.getState().refresh();
  }, []);

  return (
    <div className="flex flex-col min-h-0 h-full text-[12px] text-ink">
      <div className="shrink-0 flex items-center gap-3 px-5 pt-4 pb-3 border-b border-card">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Branches</h2>
          <p className="text-[11px] text-ink-muted mt-0.5">
            A branch of your base per ticket, and which one your services connect to.
          </p>
        </div>
        <button aria-label="Close" onClick={() => setSheet(null)} className="w-[26px] h-[26px] rounded-[5px] text-ink-muted hover:text-ink hover:bg-wash-strong flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {t.error && <div role="alert" className="mx-5 mt-3 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-bad-strong">{t.error}</div>}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-6">
          {!t.loaded ? (
            <div className="flex items-center gap-2 text-ink-muted"><Spinner /> Loading</div>
          ) : t.baselines.length === 0 ? (
            <NoBaseline />
          ) : (
            <>
              <Copies />
              <Baselines />
            </>
          )}
        </div>
        <Proxy />
      </div>
    </div>
  );
}

function NoBaseline(): JSX.Element {
  return (
    <div className="max-w-[520px] flex flex-col gap-2">
      <div className="text-[14px] font-semibold">No base yet</div>
      <p className="text-ink-muted">
        A branch is cloned from a base: a small copy of your local database that is still enough to log in.
        Open a local connection, then choose <b>Create a base…</b> from the ⋯ menu or ⌘K.
      </p>
    </div>
  );
}

function Copies(): JSX.Element {
  const t = useTickets();
  const [baselineId, setBaselineId] = useState(t.baselines[0]?.id ?? '');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const chosen = t.baselines.find((b) => b.id === baselineId) ?? t.baselines[0];

  return (
    <section className="flex flex-col gap-3">
      <div className="font-semibold text-[13px]">Branches</div>
      <form
        className="flex gap-2 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen) return;
          void t.create(chosen.id, name, note).then((made) => {
            if (made) {
              setName('');
              setNote('');
            }
          });
        }}
      >
        <input autoFocus className={`${FIELD} w-[140px]`} placeholder="PROJ-123" aria-label="Ticket" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${FIELD} flex-1`} placeholder="What it is for (optional)" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        {t.baselines.length > 1 && (
          <select className="field h-7 px-2 text-[12px]" aria-label="From base" value={chosen?.id} onChange={(e) => setBaselineId(e.target.value)}>
            {t.baselines.map((b) => <option key={b.id} value={b.id}>{b.label} · {b.sourceName}</option>)}
          </select>
        )}
        <button type="submit" className={PRIMARY} disabled={!name.trim() || !!t.busy.new}>
          {t.busy.new ? <><Spinner /> Cloning</> : 'New branch'}
        </button>
      </form>
      {t.tickets.length === 0 ? (
        <p className="text-ink-muted">None yet. Each branch starts as the base and runs on its own port.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...t.tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => <CopyRow key={x.id} ticket={x} />)}
        </ul>
      )}
    </section>
  );
}

function CopyRow({ ticket }: { ticket: TicketState }): JSX.Element {
  const t = useTickets();
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);
  const askConfirm = useStore((s) => s.askConfirm);
  const busy = t.busy[ticket.id];
  const [guide, setGuide] = useState(false);
  const serving = t.proxy?.running && t.proxy.config.target.kind === 'ticket' && t.proxy.config.target.id === ticket.id;

  return (
    <li className={`rounded-md border ${serving ? 'border-accent/40 bg-accent/5' : 'border-card'}`}>
    <div className="px-3.5 py-2.5 flex items-center gap-3">
      <span className={`w-2 h-2 rounded-full shrink-0 ${ticket.running ? 'bg-good' : 'bg-ink-faint/50'}`} aria-label={ticket.running ? 'Running' : 'Stopped'} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-[13px]">{ticket.name}</span>
          {ticket.note && <span className="text-ink-muted truncate">{ticket.note}</span>}
        </div>
        <div className="text-[11px] text-ink-muted">
          {busy ?? (ticket.running ? <>running on <span className="font-mono">127.0.0.1:{ticket.port}</span></> : 'stopped')} · made {since(ticket.createdAt)}
          {serving && <span className="text-accent-strong"> · your services see this one</span>}
        </div>
      </div>
      <div className="flex gap-1.5 shrink-0">
        {ticket.running ? (
          <button className={SMALL} disabled={!!busy} onClick={() => void t.stop(ticket.id)}>Stop</button>
        ) : (
          <button className={SMALL} disabled={!!busy} onClick={() => void t.start(ticket.id)}>Start</button>
        )}
        <button className={SMALL} aria-expanded={guide} onClick={() => setGuide(!guide)}>How to connect</button>
        <button className={SMALL} onClick={() => { select({ kind: 'connection', id: ticket.connectionId }); setSheet(null); }}>Open</button>
        <button className={`${SMALL} text-ai`} onClick={() => setSheet({ kind: 'seed', connectionId: ticket.connectionId })}>Seed</button>
        {t.proxy?.running && !serving && (
          <button className={SMALL} disabled={!!t.busy.proxy} onClick={() => void t.route({ kind: 'ticket', id: ticket.id })}>Services use this</button>
        )}
        <button
          className={`${SMALL} text-bad-strong`}
          disabled={!!busy}
          onClick={() =>
            askConfirm({
              title: `Delete ${ticket.name}?`,
              body: 'This stops the branch and deletes its data and its connection. The base is not touched.',
              confirmLabel: 'Delete branch',
              destructive: true,
              onConfirm: () => void t.remove(ticket.id),
            })
          }
        >
          Delete
        </button>
      </div>
    </div>
    {guide && (
      <div className="px-4 pb-4 pt-1 border-t border-card">
        <TicketGuide ticket={ticket} inTicketsSheet />
      </div>
    )}
    </li>
  );
}

function Baselines(): JSX.Element {
  const t = useTickets();
  const setSheet = useStore((s) => s.setSheet);
  return (
    <section className="flex flex-col gap-2">
      <div className="font-semibold text-[13px]">Bases</div>
      {t.baselines.map((b) => (
        <div key={b.id} className="rounded-md border border-card px-3.5 py-2.5 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0"><BaselineName baseline={b} className="font-semibold" /> <span className="text-ink-muted shrink-0">from {b.sourceName}</span></div>
            <div className="text-[11px] text-ink-muted">
              {b.report.tables} tables · {b.report.rows.toLocaleString()} rows · {formatBytes(b.bytes)} · MySQL {b.version} · built {since(b.builtAt)}
            </div>
          </div>
          <button className={SMALL} onClick={() => setSheet({ kind: 'baseline', connectionId: b.sourceConnectionId })}>Rebuild…</button>
        </div>
      ))}
    </section>
  );
}

// ---- the proxy --------------------------------------------------------------

type ProxyMode = 'spare' | 'takeover';

function Proxy(): JSX.Element {
  const t = useTickets();
  const p = t.proxy;
  const connections = useStore((st) => st.connections);
  // Where your own server is today: the connection the baselines came from.
  const source = connections.find((c) => c.id === t.baselines[0]?.sourceConnectionId);
  const own = { host: source?.host || '127.0.0.1', port: source?.port || 3306 };

  const [mode, setMode] = useState<ProxyMode>('spare');
  const [port, setPort] = useState('');
  const [server, setServer] = useState('');

  useEffect(() => {
    if (!p) return;
    const takeover = p.configured && p.config.socket !== null;
    setMode(takeover ? 'takeover' : 'spare');
    setPort(String(p.configured ? p.config.port : SPARE_PROXY_PORT));
    setServer(p.configured ? `${p.config.server.host}:${p.config.server.port}` : `${own.host}:${own.port}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.configured, p?.config.port, p?.config.socket, p?.config.server.port]);

  useEffect(() => {
    if (!p?.running) return;
    void t.loadClients();
    const timer = setInterval(() => void useTickets.getState().loadClients(), 3_000);
    return () => clearInterval(timer);
  }, [p?.running]);

  if (!p) return <div className="bg-surface-muted/60 border-l border-card" />;

  const choose = (m: ProxyMode) => {
    setMode(m);
    if (m === 'spare') {
      setPort(String(SPARE_PROXY_PORT));
      setServer(`${own.host}:${own.port}`);
    } else {
      setPort(String(own.port === 3306 ? 3306 : own.port));
      setServer(`${own.host}:${own.port === 3306 ? 3307 : own.port}`);
    }
  };
  const parsedServer = (() => {
    const m = server.trim().match(/^([^:\s]+):(\d{1,5})$/);
    return m ? { host: m[1], port: Number(m[2]) } : null;
  })();
  const listenPort = Number(port) || (mode === 'spare' ? SPARE_PROXY_PORT : 3306);
  const config = {
    port: listenPort,
    socket: mode === 'takeover' ? '/tmp/mysql.sock' : null,
    server: parsedServer ?? p.config.server,
  };
  const loop = parsedServer && parsedServer.port === listenPort && ['127.0.0.1', 'localhost'].includes(parsedServer.host);
  const busy = t.busy.proxy;
  const targets: Array<{ target: ProxyTarget; label: string; detail: string }> = [
    { target: { kind: 'server' }, label: 'Your own server', detail: `${p.config.server.host}:${p.config.server.port}` },
    ...t.tickets.map((x) => ({
      target: { kind: 'ticket', id: x.id } as ProxyTarget,
      label: x.name,
      detail: x.running ? `branch · :${x.port}` : 'branch · starts when chosen',
    })),
  ];
  const isTarget = (target: ProxyTarget) =>
    target.kind === p.config.target.kind && (target.kind === 'server' || (p.config.target.kind === 'ticket' && target.id === p.config.target.id));
  const ownServerHolds = p.conflict && /mysqld|mariadbd|mysql/i.test(p.conflict.process ?? '');

  return (
    <div className="min-h-0 overflow-y-auto flex flex-col gap-4 px-4 py-5 bg-surface-muted/60 border-l border-card">
      <div>
        <div className="font-semibold text-[13px]">What your services connect to</div>
        <p className="text-ink-muted mt-0.5">
          overdb listens on one address and forwards to the database you pick — your own server or any branch — so switching never needs another change.
        </p>
      </div>

      <Background />

      {p.running ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-good" />
            <span className="flex-1">
              Listening on <span className="font-mono">127.0.0.1:{p.config.port}</span>
              {p.config.socket && <> and <span className="font-mono">{p.config.socket}</span></>} · {p.connections} open
            </span>
            <button className={SMALL} disabled={!!busy} onClick={() => void t.configure({ enabled: false })}>Turn off</button>
          </div>
          {!p.config.socket && (
            <p className="text-ink-muted">
              Point each service at <span className="font-mono text-ink">127.0.0.1:{p.config.port}</span> once — same user and password as your own server.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="How services reach overdb">
          <ModeCard
            on={mode === 'spare'}
            onPick={() => choose('spare')}
            title="Use a spare port"
            badge="recommended"
          >
            Point each service at <span className="font-mono">127.0.0.1:{mode === 'spare' ? listenPort : SPARE_PROXY_PORT}</span> once. Your own server stays where it is, and quitting overdb only affects the services you pointed here.
          </ModeCard>
          <ModeCard on={mode === 'takeover'} onPick={() => choose('takeover')} title={`Take over ${own.port === 3306 ? 3306 : own.port} and /tmp/mysql.sock`}>
            No service changes at all. Your own server moves to another port once, and the proxy runs in the background so services reach a database whether overdb is open or not.
          </ModeCard>

          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 items-center mt-1">
            <label htmlFor="proxy-port" className="text-ink-muted">Listen on port</label>
            <input id="proxy-port" className={FIELD} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            <label htmlFor="proxy-server" className="text-ink-muted">{mode === 'takeover' ? 'Your server moves to' : 'Your server is at'}</label>
            <input id="proxy-server" className={`${FIELD} font-mono ${parsedServer && !loop ? '' : 'border-bad/50'}`} value={server} onChange={(e) => setServer(e.target.value)} />
          </div>
          {loop && <p className="text-bad-strong">The proxy can’t listen on the port it forwards to.</p>}
          {mode === 'takeover' && !t.helper?.installed && (
            <p className="text-ink-muted">
              Taking over your server’s port needs <b className="text-ink">Keep running when overdb is closed</b>, above — otherwise quitting overdb leaves your services with no database.
            </p>
          )}
          <button
            className={`${PRIMARY} self-start`}
            disabled={!!busy || !parsedServer || !!loop || (mode === 'takeover' && !t.helper?.installed)}
            onClick={() => void t.configure({ ...config, enabled: true })}
          >
            {busy ? <Spinner /> : null} Turn on
          </button>
        </div>
      )}

      {p.error && !p.running && (
        <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5 flex flex-col gap-2">
          {ownServerHolds ? (
            <p>
              <b>Port {p.conflict!.port} is held by {p.conflict!.process} — your own MySQL.</b>{' '}
              {mode === 'spare'
                ? 'Pick a port nothing uses, like 3310.'
                : 'To take it over, move your server first:'}
            </p>
          ) : p.conflict ? (
            <p><b>Port {p.conflict.port} is held by {p.conflict.process ?? 'another program'}.</b> Pick another port.</p>
          ) : (
            <p className="text-warn-strong">{p.error}</p>
          )}
          {ownServerHolds && mode === 'takeover' && parsedServer && <MoveServer server={parsedServer} />}
        </div>
      )}

      {p.running && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="font-semibold">Send them to</div>
            {targets.map((x) => {
              const on = isTarget(x.target);
              return (
                <button
                  key={x.target.kind === 'server' ? 'server' : x.target.id}
                  className={`text-left rounded-md border px-3 py-2 flex items-center gap-2.5 ${on ? 'border-accent/50 bg-accent/10' : 'border-card bg-surface-elevated hover:bg-wash'}`}
                  aria-pressed={on}
                  disabled={!!busy}
                  onClick={() => !on && void t.route(x.target).then((n) => n !== null && useStore.getState().toast(n > 0 ? `Closed ${n} open connection${n === 1 ? '' : 's'}; they reconnect to ${x.label}.` : `Services now reach ${x.label}.`))}
                >
                  <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${on ? 'border-accent-strong border-[4px]' : 'border-ink-faint/60'}`} />
                  <span className="min-w-0">
                    <span className="block font-medium truncate">{x.label}</span>
                    <span className="block text-[11px] text-ink-muted">{x.detail}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-col gap-1">
            <div className="font-semibold">Connected now</div>
            {t.clients.length === 0 ? (
              <p className="text-ink-muted">No process has a TCP connection open through overdb.</p>
            ) : (
              t.clients.map((c) => (
                <div key={c.pid} className="flex justify-between gap-2">
                  <span className="font-mono text-[11px] truncate">{c.process} <span className="text-ink-muted">{c.pid}</span></span>
                  <span className="text-ink-muted shrink-0">{c.connections} connection{c.connections === 1 ? '' : 's'}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}

    </div>
  );
}

/// Keep the proxy and the copies running while overdb is closed: a small
/// helper macOS starts at login. Off unless a person turns it on.
function Background(): JSX.Element {
  const t = useTickets();
  const h = t.helper;
  const busy = t.busy.helper;
  const on = !!h?.installed;
  const healthy = on && !!h?.running;
  return (
    <section
      aria-label="Keep running when overdb is closed"
      className={`rounded-md border px-3.5 py-3 flex flex-col gap-2.5 ${
        healthy ? 'border-good/40 bg-good/5' : on ? 'border-warn/40 bg-warn/5' : 'border-accent/40 bg-accent/5'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${healthy ? 'bg-good' : on ? 'bg-warn' : 'bg-ink-faint/60'}`}
          aria-hidden="true"
        />
        <span className="font-semibold text-[13px] flex-1">Keep running when overdb is closed</span>
        <span className={`text-[11px] font-semibold ${healthy ? 'text-good' : on ? 'text-warn-strong' : 'text-ink-muted'}`}>
          {healthy ? 'On' : on ? 'Not answering' : 'Off'}
        </span>
      </div>
      {on ? (
        <p className="text-ink-muted">
          {healthy
            ? <>The proxy and your branches run in a background helper (pid <span className="font-mono">{h!.pid}</span>) that macOS starts at login. Quitting overdb leaves them running.</>
            : <span className="text-warn-strong">The helper is installed but not answering{h!.error ? `: ${h!.error}` : '.'} macOS restarts it on its own; if it stays down, stop it and turn it on again.</span>}
        </p>
      ) : (
        <p className="text-ink-muted">
          Right now the proxy and branches run inside overdb, and stop when it quits. Turn this on and a small background helper keeps them running —
          macOS starts it at login, and you can turn it off here any time.
        </p>
      )}
      {on ? (
        <button className={`${BTN} self-start`} disabled={!!busy} onClick={() => void t.setBackground(false)}>
          {busy ? <><Spinner /> {busy}</> : 'Stop running in the background'}
        </button>
      ) : (
        <button className={`${PRIMARY} self-start`} disabled={!!busy} onClick={() => void t.setBackground(true)}>
          {busy ? <><Spinner /> {busy}</> : 'Run in the background'}
        </button>
      )}
    </section>
  );
}

function ModeCard(props: { on: boolean; onPick(): void; title: string; badge?: string; children: React.ReactNode }): JSX.Element {
  return (
    <button
      role="radio"
      aria-checked={props.on}
      onClick={props.onPick}
      className={`text-left rounded-md border px-3 py-2.5 flex gap-2.5 ${props.on ? 'border-accent/50 bg-accent/10' : 'border-card bg-surface-elevated hover:bg-wash'}`}
    >
      <span className={`mt-0.5 w-3 h-3 rounded-full border-2 shrink-0 ${props.on ? 'border-accent-strong border-[4px]' : 'border-ink-faint/60'}`} />
      <span className="min-w-0">
        <span className="block font-semibold">
          {props.title}
          {props.badge && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-px rounded-[3px] bg-good/10 text-good">{props.badge}</span>}
        </span>
        <span className="block text-ink-muted mt-0.5">{props.children}</span>
      </span>
    </button>
  );
}

/// The one-time move, said as the exact lines to add — overdb does not edit
/// another program's config or restart it.
function MoveServer({ server }: { server: { host: string; port: number } }): JSX.Element {
  const steps = [
    '# In /opt/homebrew/etc/my.cnf (Intel Macs: /usr/local/etc/my.cnf)',
    '[mysqld]',
    `port = ${server.port}`,
    'socket = /tmp/mysql-own.sock',
    'mysqlx = OFF',
    '',
    '# then',
    'brew services restart mysql',
  ].join('\n');
  return (
    <>
      <pre className="font-mono text-[11px] whitespace-pre-wrap rounded-[5px] bg-surface-elevated border border-card px-2.5 py-2">{steps}</pre>
      <p className="text-ink-muted">Then point your overdb connection to your server at port {server.port}, and turn the proxy on. To undo, remove those lines and restart again.</p>
      <button className={`${SMALL} self-start`} onClick={() => void window.overdb.invoke('app:copyText', steps)}>Copy</button>
    </>
  );
}
