import { useEffect } from 'react';
import type { Connection, EnvSet } from '@shared/types';
import { variantLabel } from '@shared/engines';
import { useStore } from './store';
import { useReach, whyDown } from './reachStore';
import { useTickets } from './ticketsStore';
import { devInstanceRefusal } from '@shared/instances';

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
  const based = useTickets((s) => s.baselines);
  // A shared member with no copy here yet: the set is where you notice your
  // own copy and the sandbox have drifted, and where getting one is natural.
  const copyable = members.filter(
    (c) => c.env !== 'local' && devInstanceRefusal(c) === null && !based.some((b) => b.sourceConnectionId === c.id),
  );

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

      {copyable.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
          <span>Work on a copy instead of the shared server:</span>
          {copyable.map((c) => (
            <button key={c.id} className="text-accent hover:underline" onClick={() => setSheet({ kind: 'baseline', connectionId: c.id })}>
              Copy {c.name} to this machine…
            </button>
          ))}
        </div>
      )}

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
/// nothing at all. The check is shared (reachStore.ts), so the Run button
/// and this row never disagree and never both open a connection.
function MemberRow({
  connection,
  baseline,
  onOpen,
}: {
  connection: Connection;
  baseline: boolean;
  onOpen(): void;
}): JSX.Element {
  const reach = useReach((s) => s.reach[connection.id]);
  const check = useReach((s) => s.check);
  useEffect(() => {
    void check(connection.id);
  }, [connection.id, check]);
  const state = reach?.status ?? 'checking';
  const detail = reach?.status === 'down' ? whyDown(connection, reach.error ?? '') : '';

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
            ? <span title={reach?.error}>{detail || 'Not reachable'}</span>
            : `${variantLabel(connection.variant, connection.engine)}${
                connection.database ? ` · ${connection.database}` : ''
              }`}
      </span>
    </button>
  );
}
