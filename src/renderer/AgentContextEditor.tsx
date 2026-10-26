import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { tenantOrigin, type AgentContext, type AgentContextSetting, type TenantRef } from '@shared/agentContext';

/// "What agents are told" — the notes, map and tenancy rule an agent gets
/// with this database (src/shared/agentContext.ts).
///
/// In the order most databases need them: notes apply to everything, the
/// map to anything mapped, tenancy to the few that have tenants — so it is
/// last, optional, and silent unless there is something to say. A tenant
/// overdb only detected is offered here to confirm; agents never hear it.
///
/// The summary reads only files. Detecting a tenant and listing candidates
/// connects to the database, so it waits for Change.

type Loaded = Extract<Awaited<ReturnType<typeof load>>, { ok: true }>;
type Candidate = TenantRef & { via?: string[] };

function load(connectionId: string, detect: boolean) {
  return window.overdb.invoke('agents:context', { connectionId, detect });
}

const key = (t: TenantRef) => `${t.schema}.${t.table}.${t.column}`;
/// By the column queries filter on when it is known: that is the useful name.
const label = (t: Candidate) => `${t.table}, by ${t.via?.length ? t.via.join(' / ') : t.column}`;

export function AgentContextEditor({ conn }: { conn: Connection }): JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ tenant: string; notes: string; map: boolean }>({ tenant: 'auto', notes: '', map: true });

  const refresh = async (detect: boolean) => {
    setLoading(true);
    const r = await load(conn.id, detect);
    setLoading(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setData(r);
    const t = r.setting?.tenant;
    setDraft({ tenant: t === 'none' ? 'none' : t ? key(t) : 'auto', notes: r.setting?.notes ?? '', map: r.setting?.map !== false });
  };

  useEffect(() => {
    setEditing(false);
    setData(null);
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id]);

  const ctx: AgentContext | undefined = data?.context;
  const candidates: Candidate[] = data?.candidates ?? [];
  const setTenant = data?.setting?.tenant && data.setting.tenant !== 'none' ? data.setting.tenant : null;

  const save = async (override?: Partial<typeof draft>) => {
    const d = { ...draft, ...override };
    const options: Candidate[] = [...candidates, ...(ctx?.suggestion ? [ctx.suggestion] : []), ...(setTenant ? [setTenant] : [])];
    const picked = options.find((t) => key(t) === d.tenant);
    const setting: AgentContextSetting = {
      ...(d.tenant === 'none' ? { tenant: 'none' as const } : picked ? { tenant: { schema: picked.schema, table: picked.table, column: picked.column } } : {}),
      ...(d.notes.trim() ? { notes: d.notes } : {}),
      ...(d.map ? {} : { map: false }),
    };
    const res = await window.overdb.invoke('agents:setContext', { connectionId: conn.id, setting });
    if (!res.ok) return setError(res.error ?? 'Could not save.');
    setEditing(false);
    void refresh(false);
  };

  const mapLine = !ctx ? '…' : !ctx.map.available ? 'None yet' : ctx.map.included ? `Included, made ${ctx.map.builtAt?.slice(0, 10)}` : 'Left out';
  const tenantLine = ctx?.tenant
    ? `${label(ctx.tenant)} (${tenantOrigin(ctx)})`
    : ctx?.noTenant
      ? `Not multi-tenant (${tenantOrigin(ctx)})`
      : null;

  if (!editing) {
    return (
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex items-center">
          <div className="font-semibold text-[12px] flex-1">What agents are told</div>
          <button
            onClick={() => {
              setEditing(true);
              void refresh(true);
            }}
            className="text-accent hover:underline"
          >
            Change…
          </button>
        </div>
        <div className="grid grid-cols-[52px_1fr] gap-x-2 gap-y-0.5 text-ink-muted">
          <span>Notes</span>
          <span className={`truncate ${ctx?.notes ? 'text-ink' : ''}`}>{ctx?.notes ?? 'None'}</span>
          <span>Map</span>
          <span className="text-ink">{mapLine}</span>
          {tenantLine && (
            <>
              <span>Tenant</span>
              <span className="text-ink truncate">{tenantLine}</span>
            </>
          )}
        </div>
        {error && <p className="text-warn-strong">{error}</p>}
      </div>
    );
  }

  // A detected tenant, nothing decided yet: one question, answered in a click.
  const suggestion = ctx?.suggestion && draft.tenant === 'auto' ? ctx.suggestion : null;
  const showsTenant = draft.tenant !== 'auto' && draft.tenant !== 'none';

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <div className="font-semibold text-[12px]">What agents are told</div>
      {data?.owner === 'envSet' && <p className="text-ink-muted leading-relaxed">For every environment in {data.ownerName}.</p>}

      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">Notes for agents</span>
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={3}
          placeholder="Anything an agent should know. Amounts are in cents; rows with is_test = true are fake."
          className="field px-1.5 py-1 text-[11px] resize-y"
        />
      </label>

      <label className={`flex items-center gap-1.5 ${ctx?.map.available ? '' : 'text-ink-muted'}`}>
        <input
          type="checkbox"
          checked={draft.map && Boolean(ctx?.map.available)}
          disabled={!ctx?.map.available}
          onChange={(e) => setDraft({ ...draft, map: e.target.checked })}
        />
        <span>{ctx?.map.available ? 'Give agents the database map' : 'No database map yet: make one from the Map tab'}</span>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-ink-muted">Tenants (only if each row belongs to one customer)</span>
        {suggestion ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex-1 min-w-0">Looks multi-tenant: {label(suggestion)}.</span>
            <button onClick={() => setDraft({ ...draft, tenant: key(suggestion) })} className="text-accent hover:underline">
              Tell agents
            </button>
            <button onClick={() => setDraft({ ...draft, tenant: 'none' })} className="text-ink-muted hover:text-ink">
              It isn’t
            </button>
          </div>
        ) : (
          <select
            value={draft.tenant}
            onChange={(e) => setDraft({ ...draft, tenant: e.target.value })}
            className="field px-1.5 py-0.5 text-[11px]"
          >
            <option value="auto">
              {loading
                ? 'Checking…'
                : ctx?.tenant?.source === 'recipe'
                  ? `From your base recipe: ${label(ctx.tenant)}`
                  : ctx?.noTenant?.source === 'recipe'
                    ? 'From your base recipe: not multi-tenant'
                    : 'Not set: agents aren’t told anything'}
            </option>
            {setTenant && !candidates.some((c) => key(c) === key(setTenant)) && <option value={key(setTenant)}>{label(setTenant)}</option>}
            {candidates.map((c) => (
              <option key={key(c)} value={key(c)}>
                {label(c)}
              </option>
            ))}
            <option value="none">Not multi-tenant</option>
          </select>
        )}
        {data && !data.detected && !loading && (
          <span className="text-ink-faint">Couldn’t read the catalog to suggest tables{data.detectError ? `: ${data.detectError}` : '.'}</span>
        )}
        {showsTenant && (
          <span className="text-ink-faint leading-relaxed">Agents are asked to stay within one tenant. To make sure, give them a login that can only see one.</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button onClick={() => void save()} className="text-[11px] px-2 py-0.5 rounded bg-accent/20 border border-accent/30">
          Save
        </button>
        <button
          onClick={() => {
            setEditing(false);
            void refresh(false);
          }}
          className="text-[11px] text-ink-muted hover:text-ink px-1"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-warn-strong">{error}</p>}
    </div>
  );
}
