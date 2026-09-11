import { useEffect, useState } from 'react';
import type { Connection, EnvSet } from '@shared/types';
import { variantLabel } from '@shared/engines';
import { useStore } from './store';

/// Are the members of this set actually reachable?
///
/// Shown before anything has been run, because that is when it answers a
/// question you have: a set spanning four environments is four chances for
/// a VPN to be down, and finding that out from four failed rows of a
/// fan-out is a worse way to learn it than being told up front.

export function MemberHealth({ envSet }: { envSet: EnvSet }): JSX.Element {
  const connections = useStore((s) => s.connections);
  const select = useStore((s) => s.select);
  const setSheet = useStore((s) => s.setSheet);

  const members = envSet.memberIds
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is Connection => Boolean(c));
  const missing = envSet.memberIds.length - members.length;

  if (members.length === 0) {
    return (
      <p className="text-xs text-ink-muted">
        This set has no connections yet.{' '}
        <button
          onClick={() => setSheet({ kind: 'editEnvSet', id: envSet.id })}
          className="text-accent hover:underline"
        >
          Edit it
        </button>{' '}
        to add some.
      </p>
    );
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="flex flex-col gap-px rounded border border-card overflow-hidden">
        {members.map((c) => (
          <MemberRow
            key={c.id}
            connection={c}
            baseline={c.id === envSet.baselineId}
            onOpen={() => select({ kind: 'connection', id: c.id })}
          />
        ))}
      </div>

      {missing > 0 && (
        <p className="mt-2 text-[11px] text-warn/90">
          {missing} connection{missing === 1 ? '' : 's'} in this set no longer exist.
          Edit the set to clean it up.
        </p>
      )}
    </div>
  );
}

/// Reachability is checked on mount rather than claimed. A row that says
/// "connected" because we saved a host once would be worse than saying
/// nothing at all.
function MemberRow({
  connection,
  baseline,
  onOpen,
}: {
  connection: Connection;
  baseline: boolean;
  onOpen(): void;
}): JSX.Element {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');
  const [detail, setDetail] = useState<string>('');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const open = await window.overdb.invoke('conn:isOpen', connection.id);
        if (!live) return;
        if (open) {
          setState('up');
          return;
        }
        const res = await window.overdb.invoke('conn:open', connection.id);
        if (!live) return;
        setState(res.ok ? 'up' : 'down');
        setDetail(res.ok ? (res.serverVersion ?? '') : (res.error ?? ''));
      } catch (err) {
        if (!live) return;
        setState('down');
        setDetail(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [connection.id]);

  return (
    <button
      onClick={onOpen}
      className="text-left px-3 py-2 bg-surface hover:bg-card flex items-center gap-2.5"
    >
      <span
        aria-hidden="true"
        className={`shrink-0 w-1.5 h-1.5 rounded-full ${
          state === 'up' ? 'bg-good' : state === 'down' ? 'bg-bad' : 'bg-ink-faint'
        }`}
      />
      <span className="text-xs text-ink truncate">{connection.name}</span>
      {baseline && (
        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded border border-accent/40 text-accent">
          baseline
        </span>
      )}
      {connection.env === 'prod' && (
        <span className="shrink-0 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-warn/10 text-warn/90 border border-warn/25">
          prod
        </span>
      )}
      <div className="flex-1" />
      <span className="text-[10px] text-ink-faint truncate max-w-[45%] text-right">
        {state === 'checking'
          ? 'Checking…'
          : state === 'down'
            ? detail || 'Not reachable'
            : `${variantLabel(connection.variant, connection.engine)}${
                connection.database ? ` · ${connection.database}` : ''
              }`}
      </span>
    </button>
  );
}
