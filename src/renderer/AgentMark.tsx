import type { Connection } from '@shared/types';
import { agentReach } from '@shared/hostedConnection';
import { Agent } from './Icons';
import { clockTime, useAgentActivity, useAgentActivityStore } from './agentActivity';

/// Agent activity is polled only while this is mounted: the sidebar mounts
/// it while some connection (or branch) is open to agents, so a recent
/// query lights up that row's mark.
export function AgentWatch(): null {
  useAgentActivity(30_000);
  return null;
}

/// How recent an agent's query must be for the mark to say one is at work.
const AGENT_RECENT_MS = 10 * 60_000;

/// Shown only when something other than you can read the connection — see
/// `agentReach`. Muted while nothing is using it; in the accent colour,
/// with a pulse, while an agent has queried it in the last few minutes, so
/// the mark is news when there is news. A branch is a connection of its
/// own and is exposed on its own, so it gets a mark only when it is.
export function AgentMark({ connection }: { connection: Connection }): JSX.Element | null {
  const activity = useAgentActivityStore((s) => s.activity);
  const reach = agentReach(connection);
  if (!reach) return null;
  const cutoff = Date.now() - AGENT_RECENT_MS;
  const recent = activity.filter((a) => a.connection === connection.name && Date.parse(a.at) >= cutoff);
  const last = recent.reduce<string | null>((m, a) => (m === null || a.at > m ? a.at : m), null);
  const label = last
    ? `${reach} An agent ran ${recent.length} ${recent.length === 1 ? 'query' : 'queries'} here in the last 10 minutes, the last at ${clockTime(last)}.`
    : reach;
  return (
    <span title={label} aria-label={label} role="img" className={`relative shrink-0 w-[20px] flex justify-center ${last ? 'text-accent' : 'text-ink-muted'}`}>
      <Agent className="w-3.5 h-3.5" />
      {last && <span aria-hidden="true" className="absolute -top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent motion-safe:animate-pulse" />}
    </span>
  );
}
