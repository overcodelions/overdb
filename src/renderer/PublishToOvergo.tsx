import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Connection } from '@shared/types';
import { hostedCredentialNote, orgLabel, type HostedConnection, type OvercliOrg, type PushState } from '@shared/hostedConnection';
import { useStore } from './store';
import { refreshOvercliStatus, useOvercliOrg, useOvercliTakesConnections } from './overcli';

/// Publishing a connection to the org's server, through overcli, for its
/// hosted agents. See src/shared/hostedConnection.ts.
///
/// A row in the Agents popover says whether it has been, and opens a modal
/// that walks through it: overcli signed in to an org, how the server signs
/// in to the database, the record, then where the push has got to and what
/// an admin still has to do. A modal, not the popover, because the step
/// people miss is made in overcli — the modal stays open while they go and
/// do it, and ticks when they have.
///
/// The record is one click from being read in full before it is sent —
/// open already for a prod connection — because it is leaving the machine
/// and the person should be able to read every field of it, including
/// that no password is among them. It is the record main builds from the
/// saved connection, not one put together here, and main builds it again
/// on publish rather than taking this one back.
///
/// Hidden unless overcli can take it, like the Send to overcli button.
const SIGN_IN_WHERE = 'Open overcli, go to Settings → Your orgs and sign in.';
/// How often to look again while the modal is open: overcli's sign-in,
/// then the push landing, are both a file away.
const POLL_MS = 1500;

/// The record as it reads best: a map is hundreds of lines, so it is
/// summed up here. It is sent whole.
function forReading(h: HostedConnection): unknown {
  const m = h.context?.map;
  if (!m) return h;
  const tables = Object.keys(m.tables).length;
  return { ...h, context: { ...h.context, map: `${tables} table${tables === 1 ? '' : 's'} and ${m.links.length} link${m.links.length === 1 ? '' : 's'} from the code, made ${m.builtAt.slice(0, 10)}. No rows.` } };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/// The org by name, or "your org" when overcli doesn't say.
function orgName(org: OvercliOrg | null): string {
  return org?.signedIn ? orgLabel(org) : 'your org';
}

// ---- the popover row ------------------------------------------------------

/// In the Agents popover: whether this connection is on the org's server,
/// and the way into the modal.
export function PublishToOrgRow({ conn, onOpen }: { conn: Connection; onOpen: () => void }): JSX.Element | null {
  const available = useOvercliTakesConnections();
  const org = useOvercliOrg();
  if (!available) return null;
  const published = conn.orgPublishedAt;
  return (
    <>
      <div className="h-px bg-rule" />
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="font-semibold flex-1 flex items-center gap-1.5">
            {published && <span className="w-1.5 h-1.5 rounded-full bg-good" aria-hidden="true" />}
            {published ? `On ${org?.signedIn ? `${orgLabel(org)}’s` : 'your org’s'} server` : 'Your org’s server'}
          </div>
          <button onClick={onOpen} className="text-[11px] text-accent hover:underline">
            {published ? 'Publish again…' : `Publish to ${orgName(org)}…`}
          </button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          {published
            ? `Sent ${published.slice(0, 10)}. Publish again to change its login or host.`
            : 'Hosted agents, such as overgo workers, can’t use it yet.'}
          {org && !org.signedIn && <span className="text-warn"> overcli isn’t signed in to an org.</span>}
        </p>
      </div>
    </>
  );
}

// ---- the modal ------------------------------------------------------------

type Mark = 'done' | 'active' | 'todo' | 'warn' | 'bad' | 'busy';

function StepMark({ mark, n }: { mark: Mark; n: number }): JSX.Element {
  const base = 'w-[22px] h-[22px] rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold';
  switch (mark) {
    case 'done':
      return (
        <span className={`${base} bg-good/15 text-good`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" />
          </svg>
        </span>
      );
    case 'busy':
      return (
        <span className={`${base} bg-accent/15 text-accent`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="animate-spin" role="img" aria-label="In progress">
            <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
          </svg>
        </span>
      );
    case 'active':
      return <span className={`${base} bg-accent text-white`}>{n}</span>;
    case 'warn':
      return <span className={`${base} bg-warn/20 text-warn-strong`}>{n}</span>;
    case 'bad':
      return <span className={`${base} bg-bad/20 text-bad-strong`}>!</span>;
    case 'todo':
      return <span className={`${base} border border-card text-ink-muted`}>{n}</span>;
  }
}

function Step({ n, mark, title, last, children }: { n: number; mark: Mark; title?: ReactNode; last?: boolean; children?: ReactNode }): JSX.Element {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <StepMark mark={mark} n={n} />
        {!last && <span className="flex-1 w-px bg-rule my-1" />}
      </div>
      <div className={`flex-1 min-w-0 flex flex-col gap-1.5 ${last ? 'pb-1' : 'pb-4'}`}>
        {title && <div className="text-[13px] font-semibold leading-[22px]">{title}</div>}
        {children}
      </div>
    </li>
  );
}

function Shell({ title, subtitle, onClose, footer, children }: { title: ReactNode; subtitle: ReactNode; onClose: () => void; footer: ReactNode; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-org-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-120px)] flex flex-col rounded-xl border border-card bg-surface-elevated shadow-2xl text-ink"
      >
        <div className="px-5 pt-5 pb-1 flex items-start gap-3">
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <h2 id="publish-org-title" className="m-0 text-[15px] font-semibold flex items-center gap-2 min-w-0">
              {title}
            </h2>
            <p className="m-0 text-[12px] text-ink-muted">{subtitle}</p>
          </div>
          <button aria-label="Close" onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-wash-strong">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>
        <div className="px-5 pt-4 pb-2 overflow-auto text-[12px]">{children}</div>
        <div className="mt-2 px-5 py-3.5 border-t border-rule flex items-center gap-2">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}

function EnvTag({ env }: { env: Connection['env'] }): JSX.Element | null {
  if (!env) return null;
  const prod = env === 'prod';
  return (
    <span className={`shrink-0 text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded ${prod ? 'bg-bad/20 text-bad-strong' : 'bg-accent/15 text-accent'}`}>
      {env}
    </span>
  );
}

const primaryBtn = 'h-8 px-3.5 rounded-md bg-accent hover:bg-accent-strong text-white text-[12px] font-semibold disabled:opacity-40 disabled:hover:bg-accent';
const quietBtn = 'h-8 px-3.5 rounded-md border border-card text-[12px] text-ink-muted hover:text-ink hover:bg-wash-strong';
const field = 'field h-[30px] px-2 text-[12px] min-w-0';

export function PublishToOrgModal({ conn, onClose }: { conn: Connection; onClose: () => void }): JSX.Element {
  const org = useOvercliOrg();
  const markPublished = useStore((s) => s.markPublished);
  const [user, setUser] = useState(conn.user ?? '');
  const [host, setHost] = useState(conn.host ?? '');
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<{ ok: true; value: HostedConnection } | { ok: false; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ value: HostedConnection; file: string; at: string } | null>(null);
  const [pushState, setPushState] = useState<PushState>({ state: 'waiting' });

  // Keep asking overcli: before Publish for its sign-in, after it for where
  // the push has got to. Stops once the push has landed or been turned down.
  const settled = pushState.state === 'sent' || pushState.state === 'rejected';
  useEffect(() => {
    if (settled) return;
    const look = () => {
      void refreshOvercliStatus();
      if (sent) void window.overdb.invoke('overcli:pushState', { file: sent.file }).then(setPushState).catch(() => {});
    };
    look();
    const id = setInterval(look, POLL_MS);
    return () => clearInterval(id);
  }, [sent, settled]);

  useEffect(() => {
    if (sent) return;
    let stale = false;
    const id = setTimeout(() => {
      void window.overdb
        .invoke('conn:hostedPreview', { connectionId: conn.id, user, host })
        .then((p) => !stale && setPreview(p));
    }, 150);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [conn.id, user, host, sent]);

  const prod = conn.env === 'prod';
  const where = orgName(org);

  if (sent) return <SentView conn={conn} sent={sent} org={org} state={pushState} onClose={onClose} />;

  const publish = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.overdb.invoke('conn:publishHosted', {
        connectionId: conn.id,
        user,
        host,
        ...(prod ? { confirm: typed } : {}),
      });
      if (!res.ok) return setError(res.error);
      markPublished(conn.id, res.publishedAt);
      setPushState({ state: 'waiting' });
      setSent({ value: res.value, file: res.pushFile, at: res.publishedAt });
    } finally {
      setBusy(false);
    }
  };

  const signedIn = org?.signedIn === true;
  const notSignedIn = org !== null && !signedIn;
  const loginDone = preview?.ok === true && user.trim() !== '';
  const canPublish = preview?.ok === true && (!prod || typed === conn.name) && !busy;

  return (
    <Shell
      onClose={onClose}
      title={
        <>
          <span className="truncate">Publish {conn.name} to {where}</span>
          <EnvTag env={conn.env} />
        </>
      }
      subtitle="Read-only, for hosted agents such as overgo workers."
      footer={
        <>
          <div className="flex-1 text-[11px] text-ink-muted">{notSignedIn && 'Publish now and it waits in overcli until you sign in.'}</div>
          <button onClick={onClose} className={quietBtn}>
            Cancel
          </button>
          <button
            onClick={() => void publish()}
            disabled={!canPublish}
            className={notSignedIn ? 'h-8 px-3.5 rounded-md border border-accent/60 bg-accent/15 text-accent text-[12px] font-semibold disabled:opacity-40' : primaryBtn}
          >
            {busy ? 'Publishing…' : notSignedIn ? 'Publish when signed in' : `Publish to ${where}`}
          </button>
        </>
      }
    >
      <ol className="list-none m-0 p-0 flex flex-col">
        {notSignedIn ? (
          <Step n={1} mark="warn">
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 flex flex-col gap-1.5">
              <div className="text-[13px] font-semibold text-warn-strong">Sign overcli in to your org</div>
              <div className="leading-relaxed text-ink-muted">overcli is what sends this to your org’s server. {SIGN_IN_WHERE}</div>
              <div className="text-[11px] text-ink-muted flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="animate-spin" aria-hidden="true">
                  <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
                </svg>
                Watching for the sign-in. This ticks itself when you do.
              </div>
            </div>
          </Step>
        ) : (
          <Step n={1} mark={signedIn ? 'done' : 'todo'} title={signedIn ? 'overcli is signed in' : 'overcli sends it'}>
            {org?.signedIn ? (
              <>
                <div className="text-ink">
                  Goes to <b className="font-semibold">{orgLabel(org)}</b>
                  {org.org && <span className="text-ink-muted"> · {safeHost(org.url)}</span>}
                </div>
                <div className="text-[11px] text-ink-muted">A different org? Change it in overcli, under Settings → Your orgs.</div>
              </>
            ) : (
              <div className="text-ink-muted leading-relaxed">
                To the org overcli is signed in to. If it isn’t yet: {SIGN_IN_WHERE}
              </div>
            )}
          </Step>
        )}

        <Step n={2} mark={loginDone ? 'done' : 'active'} title="How the server signs in">
          <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-x-2.5 gap-y-2 items-center mt-1">
            {conn.engine !== 'dynamodb' && (
              <>
                <label
                  htmlFor="publish-host"
                  className="text-ink-muted"
                  title="Where the server finds the database, if not where this machine does: host.docker.internal for a container on this Mac, or the endpoint behind a VPN-only name."
                >
                  Server reaches it at
                </label>
                <input id="publish-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.internal.example.com" className={field} />
              </>
            )}
            <label htmlFor="publish-user" className="text-ink-muted">
              Sign in as
            </label>
            <input id="publish-user" value={user} onChange={(e) => setUser(e.target.value)} placeholder="a read-only user made for agents" className={field} />
          </div>
          {preview && !preview.ok && <p className="m-0 text-warn-strong leading-relaxed">{preview.error}</p>}
          {preview?.ok && <p className="m-0 text-[11px] text-ink-muted leading-relaxed">{hostedCredentialNote(preview.value)}</p>}
        </Step>

        <Step n={3} mark={loginDone ? 'active' : 'todo'} title="Review what’s sent" last>
          {preview?.ok && (
            <details open={prod} className="group">
              <summary className="list-none cursor-pointer select-none text-ink-muted hover:text-ink flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="transition-transform group-open:rotate-90">
                  <path d="M3.5 2l3 3-3 3" />
                </svg>
                <span className="group-open:hidden">Show the record</span>
                <span className="hidden group-open:inline">Hide the record</span>
                <span className="text-ink-faint">· no password in it</span>
              </summary>
              <pre className="mt-2 mb-0 font-mono text-[10.5px] leading-snug bg-wash-strong border border-rule rounded-lg p-2.5 max-h-52 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(forReading(preview.value), null, 2)}
              </pre>
            </details>
          )}
          {prod && (
            <div className="flex flex-col gap-1.5 mt-1">
              <label htmlFor="publish-confirm" className="text-ink-muted">
                Type <b className="font-semibold text-ink">{conn.name}</b> to publish a production connection
              </label>
              <input id="publish-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={conn.name} className={`${field} border-bad/40`} />
            </div>
          )}
          {error && <p className="m-0 text-warn-strong leading-relaxed">{error}</p>}
        </Step>
      </ol>
    </Shell>
  );
}

function SentView({
  conn,
  sent,
  org,
  state,
  onClose,
}: {
  conn: Connection;
  sent: { value: HostedConnection; file: string; at: string };
  org: OvercliOrg | null;
  state: PushState;
  onClose: () => void;
}): JSX.Element {
  const where = orgName(org);
  const whose = org?.signedIn ? `${orgLabel(org)}’s` : 'your org’s';
  const time = new Date(sent.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const consoleUrl = org?.signedIn ? `${org.url.replace(/\/+$/, '')}/#setup/databases` : null;

  const steps = [
    `An admin sets it up in ${whose} console, under Setup → Databases.`,
    hostedCredentialNote(sent.value),
    ...(sent.value.user ? [`Check that ${sent.value.user} is read-only by grant, not just by session.`] : []),
  ];
  const copySteps = () =>
    void window.overdb
      .invoke('app:copyText', `${sent.value.name} was published to ${whose} server from overdb. To finish it:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
      .then(() => useStore.getState().toast('Copied the steps.'));

  let landing: JSX.Element;
  switch (state.state) {
    case 'sent':
      landing = (
        <Step n={2} mark="done" title={`${whose[0].toUpperCase()}${whose.slice(1)} server has it`} last>
          <div className="text-[11px] text-ink-muted">Waiting for an admin to set it up there.</div>
        </Step>
      );
      break;
    case 'rejected':
      landing = (
        <Step n={2} mark="bad" title={`${whose[0].toUpperCase()}${whose.slice(1)} server didn’t take it`} last>
          <div className="text-ink-muted leading-relaxed">{state.reason}</div>
        </Step>
      );
      break;
    case 'waiting':
      landing =
        org && !org.signedIn ? (
          <Step n={2} mark="warn" title="Waiting for overcli to sign in" last>
            <div className="text-ink-muted leading-relaxed">It goes as soon as overcli is signed in. {SIGN_IN_WHERE}</div>
          </Step>
        ) : (
          <Step n={2} mark="busy" title={`On its way to ${where}`} last>
            <div className="text-[11px] text-ink-muted leading-relaxed">
              {org?.waiting ? `overcli is holding it: ${org.waiting}` : 'Is overcli running? It sends once it is.'}
            </div>
          </Step>
        );
      break;
    case 'unknown':
      landing = (
        <Step n={2} mark="todo" title={`overcli sends it to ${where}`} last>
          <div className="text-[11px] text-ink-muted">This overcli doesn’t say when it lands.</div>
        </Step>
      );
      break;
  }

  return (
    <Shell
      onClose={onClose}
      title={<span className="truncate">{state.state === 'sent' ? `${conn.name} is with ${where}` : `Publishing ${conn.name}`}</span>}
      subtitle={`${org?.signedIn ? `${safeHost(org.url)} · ` : ''}handed over at ${time}`}
      footer={
        <>
          <div className="flex-1" />
          <button autoFocus onClick={onClose} className={primaryBtn}>
            Done
          </button>
        </>
      }
    >
      <ol className="list-none m-0 p-0 flex flex-col">
        <Step n={1} mark="done" title="Handed to overcli" />
        {landing}
      </ol>
      {state.state !== 'rejected' && (
        <div className="mt-3 rounded-lg border border-rule bg-wash-strong/50 px-4 py-3 flex flex-col gap-2.5">
          <div className="font-semibold text-ink">Before workers can use it</div>
          <ol className="m-0 pl-4 flex flex-col gap-1.5 leading-relaxed text-ink-muted list-decimal">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="flex gap-4">
            {consoleUrl && (
              <button onClick={() => void window.overdb.invoke('app:openExternal', consoleUrl)} className="text-accent hover:underline">
                Open {where}’s console
              </button>
            )}
            <button onClick={copySteps} className="text-accent hover:underline">
              Copy these steps for an admin
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}
