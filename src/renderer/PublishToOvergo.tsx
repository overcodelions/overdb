import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { hostedCredentialNote, type HostedConnection } from '@shared/hostedConnection';
import { useStore } from './store';
import { useOvercliTakesConnections } from './overcli';

/// Publishing a connection to the org's server, through overcli, for its
/// hosted agents. See src/shared/hostedConnection.ts.
///
/// The record is shown in full before it is sent, because it is leaving
/// the machine and the person should be able to read every field of it —
/// including that no password is among them. It is the record main
/// builds from the saved connection, not one put together here, and main
/// builds it again on publish rather than taking this one back.
///
/// Hidden unless overcli can take it, like the Send to overcli button.
/// The record as it reads best: a map is hundreds of lines, so it is
/// summed up here. It is sent whole.
function forReading(h: HostedConnection): unknown {
  const m = h.context?.map;
  if (!m) return h;
  const tables = Object.keys(m.tables).length;
  return { ...h, context: { ...h.context, map: `${tables} table${tables === 1 ? '' : 's'} and ${m.links.length} link${m.links.length === 1 ? '' : 's'} from the code, made ${m.builtAt.slice(0, 10)}. No rows.` } };
}

export function PublishToOvergo({ conn }: { conn: Connection }): JSX.Element | null {
  const available = useOvercliTakesConnections();
  const toast = useStore((s) => s.toast);
  const markPublished = useStore((s) => s.markPublished);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(conn.user ?? '');
  const [host, setHost] = useState(conn.host ?? '');
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<{ ok: true; value: HostedConnection } | { ok: false; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<HostedConnection | null>(null);

  // A different connection starts over: a half-typed prod name must not
  // carry to the next one.
  useEffect(() => {
    setOpen(false);
    setUser(conn.user ?? '');
    setHost(conn.host ?? '');
    setTyped('');
    setError(null);
    setSent(null);
  }, [conn.id, conn.user, conn.host]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, conn.id, user, host]);

  if (!available) return null;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start text-[11px] text-accent hover:underline">
        Publish to your org’s server…
      </button>
    );
  }

  const prod = conn.env === 'prod';
  const publish = async () => {
    setError(null);
    const res = await window.overdb.invoke('conn:publishHosted', {
      connectionId: conn.id,
      user,
      host,
      ...(prod ? { confirm: typed } : {}),
    });
    if (!res.ok) return setError(res.error);
    markPublished(conn.id, res.publishedAt);
    setSent(res.value);
    toast(`${conn.name} is with overcli, on its way to your org’s server.`);
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-1.5 text-[11px]">
        <div className="font-semibold text-[12px]">Handed to overcli</div>
        <p className="text-ink-muted leading-relaxed">
          overcli will publish {sent.name} to your org’s server. Hosted agents can use it once an admin sets it up there.{' '}
          {hostedCredentialNote(sent)}
        </p>
        <button onClick={() => setOpen(false)} className="self-start text-accent hover:underline">
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <div className="font-semibold text-[12px]">Publish to your org’s server</div>
      <p className="text-ink-muted leading-relaxed">
        For hosted agents, such as overgo workers. Read-only there too. Only what’s below is sent, and it holds no
        password.
      </p>
      {conn.engine !== 'dynamodb' && (
        <label className="flex items-center gap-2" title="Where the server finds the database, if not where this machine does: host.docker.internal for a container on this Mac, or the endpoint behind a VPN-only name.">
          <span className="text-ink-muted shrink-0 w-[88px]">Server reaches it at</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="db.internal.example.com"
            className="field px-1.5 py-0.5 text-[11px] flex-1 min-w-0"
          />
        </label>
      )}
      <label className="flex items-center gap-2">
        <span className="text-ink-muted shrink-0 w-[88px]">Sign in as</span>
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="a read-only user made for agents"
          className="field px-1.5 py-0.5 text-[11px] flex-1 min-w-0"
        />
      </label>
      {preview && !preview.ok && <p className="text-warn-strong leading-relaxed">{preview.error}</p>}
      {preview?.ok && (
        <>
          <pre className="font-mono text-[10px] leading-snug bg-wash-strong rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(forReading(preview.value), null, 2)}
          </pre>
          <p className="text-ink-muted leading-relaxed">{hostedCredentialNote(preview.value)}</p>
        </>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {prod && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${conn.name}`}
            className="field px-1.5 py-0.5 text-[10px] w-40"
          />
        )}
        <button
          onClick={() => void publish()}
          disabled={!preview?.ok || (prod && typed !== conn.name)}
          className="text-[11px] px-2 py-0.5 rounded bg-accent/20 border border-accent/30 disabled:opacity-40"
        >
          Publish
        </button>
        <button onClick={() => setOpen(false)} className="text-[11px] text-ink-muted hover:text-ink px-1">
          Cancel
        </button>
      </div>
      {error && <p className="text-warn-strong leading-relaxed">{error}</p>}
    </div>
  );
}
