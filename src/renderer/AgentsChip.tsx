import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { useStore } from './store';
import { Dropdown } from './Menu';
import { Agent, Chevron } from './Icons';
import { ProdConfirm, useAgentToggle } from './WriteControls';
import { AgentContextEditor } from './AgentContextEditor';
import { PublishToOvergo } from './PublishToOvergo';
import { activityOutcome, activityText, clientLabel, clockTime, shortPath, startOfToday, useAgentActivity } from './agentActivity';

/// The header's answer to "can an agent see this, and is one looking".
///
/// Beside Writes, not under it: agents never write, whatever Writes says,
/// so the two are separate facts and each gets its own chip. Off, it is a
/// quiet "Agents" — the way in for someone who has never set one up. On, it
/// says how many calls agents made on this connection today, with a dot
/// while one is connected.
///
/// The panel is the short version of the Agents sheet for this connection:
/// the switch, who is connected, the last few calls, what agents are told.
/// Everything longer — setting a client up, the full log, editing what they
/// are told with a preview — opens the sheet.
export function AgentsChip({ conn }: { conn: Connection }): JSX.Element {
  const agents = useAgentToggle(conn);
  const setSheet = useStore((s) => s.setSheet);
  const [panel, setPanel] = useState(false);
  // Faster while open: the panel shows calls as they happen. Exposed, the
  // chip's count is worth keeping fresh; hidden, it only needs to know
  // whether anything is connected.
  const { clients, activity } = useAgentActivity(panel ? 3000 : conn.mcpExposed ? 10_000 : 30_000);

  useEffect(() => setPanel(false), [conn.id]);

  const mine = activity.filter((a) => a.connection === conn.name);
  const today = startOfToday();
  const todayCount = mine.filter((a) => a.at >= today).length;
  const connected = clients.length > 0;

  const toggle = async () => {
    if (agents.exposed) return void agents.disable();
    if (conn.env === 'prod') return agents.begin();
    await agents.enable();
  };
  const openSheet = (tab: 'overview' | 'briefing') => {
    setPanel(false);
    setSheet({ kind: 'agents', connectionId: conn.id, tab });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setPanel((v) => !v)}
        aria-expanded={panel}
        aria-haspopup="dialog"
        title={
          agents.exposed
            ? `Agents can read ${conn.name}, never write. ${todayCount} call${todayCount === 1 ? '' : 's'} today.`
            : `Agents can’t see ${conn.name}.`
        }
        className={`h-[26px] px-2.5 rounded-md flex items-center gap-1.5 text-[12px] border ${
          agents.exposed
            ? `text-ink border-accent/40 ${panel ? 'bg-accent/20' : 'bg-accent/[0.07] hover:bg-accent/15'}`
            : `text-ink-muted border-transparent ${panel ? 'bg-wash-strong text-ink' : 'hover:bg-wash-strong hover:text-ink'}`
        }`}
      >
        <Agent className={`w-3 h-3 ${agents.exposed ? 'text-accent' : ''}`} />
        {agents.exposed ? (
          <>
            Agents read{todayCount > 0 && <span className="text-ink-muted tabular-nums">· {todayCount} today</span>}
          </>
        ) : (
          'Agents'
        )}
        {agents.exposed && connected && <span className="w-1.5 h-1.5 rounded-full bg-good" aria-label="An agent is connected" />}
        <Chevron up={panel} className="w-2.5 h-2.5 text-ink-muted" />
      </button>

      <Dropdown
        open={panel}
        onClose={() => {
          setPanel(false);
          agents.cancel();
        }}
        label="Agents"
        align="left"
        width={380}
        role="dialog"
      >
        <div className="flex flex-col gap-3.5 text-[12px] text-ink">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="font-semibold">{agents.exposed ? `Agents can read ${conn.name}` : 'Agents'}</div>
              <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                {agents.exposed
                  ? 'Always read-only, whatever Writes says. 30 s per statement, at most 1,000 rows.'
                  : 'Hidden from agents. They can’t see this connection exists.'}
                {conn.env === 'prod' && !agents.exposed ? ' Turning this on asks you to type the connection’s name.' : ''}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={agents.exposed}
              aria-label={`Agents can read ${conn.name}`}
              onClick={() => void toggle()}
              className={`shrink-0 mt-0.5 w-9 h-5 rounded-full relative transition-colors ${agents.exposed ? 'bg-accent' : 'bg-wash-strong border border-card'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${agents.exposed ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          </div>
          {agents.confirming && <ProdConfirm conn={conn} gate={agents} />}

          <div className="h-px bg-rule" />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center">
              <div className="font-semibold flex-1">Connected now</div>
              {!connected && (
                <button onClick={() => openSheet('overview')} className="text-[11px] text-accent hover:underline">
                  Connect an agent…
                </button>
              )}
            </div>
            {connected ? (
              clients.map((c) => (
                <div key={c.pid} className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-good shrink-0" />
                  <span className="flex-1 min-w-0 truncate">
                    {clientLabel(c)} <span className="text-ink-muted">· {shortPath(c.cwd)}</span>
                  </span>
                  <span className="text-ink-faint text-[11px]">since {clockTime(c.since)}</span>
                </div>
              ))
            ) : (
              <p className="text-[11px] text-ink-muted">No agent is connected to overdb.</p>
            )}
          </div>

          {agents.exposed && (
            <>
              <div className="h-px bg-rule" />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center">
                  <div className="font-semibold flex-1">Last calls</div>
                  <button onClick={() => openSheet('overview')} className="text-[11px] text-accent hover:underline">
                    All activity…
                  </button>
                </div>
                {mine.length === 0 ? (
                  <p className="text-[11px] text-ink-muted">Nothing yet on {conn.name}.</p>
                ) : (
                  mine.slice(0, 3).map((a, i) => (
                    <div key={`${a.at}-${i}`} className="flex items-baseline gap-2 text-[11px]">
                      <span className="text-ink-faint w-10 shrink-0 tabular-nums">{clockTime(a.at)}</span>
                      <code className={`flex-1 min-w-0 truncate font-mono text-[10.5px] ${a.ok ? '' : 'text-bad-strong'}`} title={activityText(a)}>
                        {activityText(a)}
                      </code>
                      <span className={`shrink-0 ${a.ok ? 'text-ink-faint' : 'text-bad-strong'}`}>{activityOutcome(a)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          <div className="h-px bg-rule" />
          <AgentContextEditor conn={conn} onEdit={() => openSheet('briefing')} />
          <PublishToOvergo conn={conn} />
        </div>
      </Dropdown>
    </div>
  );
}

