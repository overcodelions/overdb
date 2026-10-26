import { useEffect, useState } from 'react';
import type { Connection } from '@shared/types';
import { tenantOrigin, type AgentContext, type AgentContextSetting, type TenancyCaveats, type TenantRef } from '@shared/agentContext';

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
///
/// A tenant can carry caveats, for where the plain rule is wrong about this
/// database: tables every tenant shares, tenants to leave out, levels inside
/// a tenant, more columns that mean it. The catalog suggests the first and
/// third; the others only a person knows.

type Loaded = Extract<Awaited<ReturnType<typeof load>>, { ok: true }>;
type Candidate = TenantRef & { via?: string[] };
type Level = TenantRef & { via: string[] };

interface Draft {
  tenant: string;
  notes: string;
  map: boolean;
  shared: string[];
  /// As typed: split on commas and spaces when saved.
  excluded: string;
  /// Keys of the levels ticked.
  levels: string[];
  also: string;
}

const split = (text: string) => text.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);

function load(connectionId: string, detect: boolean, tenant?: TenantRef) {
  return window.overdb.invoke('agents:context', { connectionId, detect, ...(tenant ? { tenant } : {}) });
}

const key = (t: TenantRef) => `${t.schema}.${t.table}.${t.column}`;
/// By the column queries filter on when it is known: that is the useful name.
/// Qualified, because the same table name in two schemas is common and
/// they are not interchangeable as the tenant.
const label = (t: Candidate) => `${t.schema}.${t.table}, by ${t.via?.length ? t.via.join(' / ') : t.column}`;
const OTHER = '__other';

function draftOf(setting: AgentContextSetting | null | undefined): Draft {
  const t = setting?.tenant;
  const c = setting?.caveats;
  return {
    tenant: t === 'none' ? 'none' : t ? key(t) : 'auto',
    notes: setting?.notes ?? '',
    map: setting?.map !== false,
    shared: c?.shared ?? [],
    excluded: (c?.excluded ?? []).join(', '),
    levels: (c?.levels ?? []).map(key),
    also: (c?.alsoFilterOn ?? []).join(', '),
  };
}

/// "3 shared tables · 1 level · 2 left out", or nothing.
function caveatSummary(c: AgentContext['tenant']): string {
  if (!c) return '';
  const { shared, levels, excluded, alsoFilterOn } = c.caveats;
  const n = (k: number, one: string, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : null);
  return [n(shared.length, 'shared table'), n(levels.length, 'level'), excluded.length ? `${excluded.length} left out` : null, n(alsoFilterOn.length, 'extra column')]
    .filter(Boolean)
    .join(' · ');
}

/// `onEdit` sends Change… somewhere else (the Agents sheet) rather than
/// editing in place; `alwaysEditing` is that somewhere else, and `onDraft`
/// hears each edit as the setting it would save — null once it matches
/// what is saved — so a preview can follow the form rather than the file.
export function AgentContextEditor({
  conn,
  onEdit,
  alwaysEditing = false,
  onSaved,
  onDraft,
}: {
  conn: Connection;
  onEdit?(): void;
  alwaysEditing?: boolean;
  onSaved?(): void;
  onDraft?(setting: AgentContextSetting | null): void;
}): JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNow, setEditing] = useState(false);
  const editing = alwaysEditing || editingNow;
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [saved, setSaved] = useState(draft);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState('');

  const refresh = async (detect: boolean) => {
    setLoading(true);
    const r = await load(conn.id, detect);
    setLoading(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setData(r);
    const loaded = draftOf(r.setting);
    setDraft(loaded);
    setSaved(loaded);
  };

  /// Offer one more table as the tenant: read again with it named, so its
  /// columns and caveat hints come too, and keep the form as it is.
  const offer = async (table: string) => {
    if (!data) return;
    const dot = table.indexOf('.');
    if (dot <= 0) return setError('Pick a table as schema.table.');
    const tenant = { schema: table.slice(0, dot), table: table.slice(dot + 1), column: data.keys[table] ?? 'id' };
    setLoading(true);
    const r = await load(conn.id, true, tenant);
    setLoading(false);
    if (!r.ok) return setError(r.error);
    setData(r);
    setPicking(false);
    setPicked('');
    setDraft((d) => ({ ...d, tenant: key(tenant), levels: [] }));
  };

  useEffect(() => {
    setEditing(false);
    setPicking(false);
    setData(null);
    void refresh(alwaysEditing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id]);

  const ctx: AgentContext | undefined = data?.context;
  const candidates: Candidate[] = data?.candidates ?? [];
  const setTenant = data?.setting?.tenant && data.setting.tenant !== 'none' ? data.setting.tenant : null;

  // The tenant the form is on: picked, or the recipe's while it says auto.
  const effective = (d: Draft): string | null =>
    d.tenant === 'none' ? null : d.tenant !== 'auto' ? d.tenant : ctx?.tenant ? key(ctx.tenant) : null;
  const hintsFor = (k: string | null) => (k ? data?.hints[k] : undefined);
  // Levels saved stay offered even when the catalog can't be read.
  const levelOptions = (k: string | null): Level[] => {
    const seen = new Map<string, Level>();
    for (const l of [...(hintsFor(k)?.levels ?? []), ...(data?.setting?.caveats?.levels ?? [])]) if (!seen.has(key(l))) seen.set(key(l), l);
    return [...seen.values()];
  };

  const settingOf = (d: Draft): AgentContextSetting => {
    const options: Candidate[] = [...candidates, ...(ctx?.suggestion ? [ctx.suggestion] : []), ...(setTenant ? [setTenant] : [])];
    const picked = options.find((t) => key(t) === d.tenant);
    const on = effective(d);
    const caveats: TenancyCaveats = on
      ? {
          ...(d.shared.length ? { shared: d.shared } : {}),
          ...(split(d.excluded).length ? { excluded: split(d.excluded) } : {}),
          ...(d.levels.length
            ? { levels: levelOptions(on).filter((l) => d.levels.includes(key(l))).map((l) => ({ schema: l.schema, table: l.table, column: l.column, via: l.via })) }
            : {}),
          ...(split(d.also).length ? { alsoFilterOn: split(d.also) } : {}),
        }
      : {};
    return {
      ...(d.tenant === 'none' ? { tenant: 'none' as const } : picked ? { tenant: { schema: picked.schema, table: picked.table, column: picked.column } } : {}),
      ...(Object.keys(caveats).length ? { caveats } : {}),
      ...(d.notes.trim() ? { notes: d.notes } : {}),
      ...(d.map ? {} : { map: false }),
    };
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!onDraft || !data) return;
    onDraft(dirty ? settingOf(draft) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, saved, data]);

  const save = async (override?: Partial<typeof draft>) => {
    const setting = settingOf({ ...draft, ...override });
    const res = await window.overdb.invoke('agents:setContext', { connectionId: conn.id, setting });
    if (!res.ok) return setError(res.error ?? 'Could not save.');
    setEditing(false);
    void refresh(alwaysEditing);
    onSaved?.();
  };

  const mapLine = !ctx ? '…' : !ctx.map.available ? 'None yet' : ctx.map.included ? `Included, made ${ctx.map.builtAt?.slice(0, 10)}` : 'Left out';
  const tenantLine = ctx?.tenant
    ? `${label(ctx.tenant)} (${tenantOrigin(ctx)})${caveatSummary(ctx.tenant) ? ` · ${caveatSummary(ctx.tenant)}` : ''}`
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
              if (onEdit) return onEdit();
              setEditing(true);
              void refresh(true);
            }}
            className="text-accent hover:underline"
          >
            {onEdit ? 'Edit & preview…' : 'Change…'}
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
          rows={alwaysEditing ? 6 : 3}
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
            value={picking ? OTHER : draft.tenant}
            onChange={(e) => {
              if (e.target.value === OTHER) return setPicking(true);
              setPicking(false);
              // Levels belong to the tenant they were found under.
              setDraft({ ...draft, tenant: e.target.value, levels: [] });
            }}
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
            {data?.detected && <option value={OTHER}>Another table…</option>}
            <option value="none">Not multi-tenant</option>
          </select>
        )}
        {picking && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void offer(picked);
            }}
          >
            <input
              autoFocus
              list={`agents-tables-${conn.id}`}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              placeholder="schema.table — the table each tenant is a row of"
              aria-label="Tenant table"
              className="field flex-1 min-w-0 px-1.5 py-0.5 text-[11px]"
            />
            <button type="submit" disabled={!data?.tables.includes(picked) || loading} className="text-[11px] px-2 py-0.5 rounded bg-accent/20 border border-accent/30 disabled:opacity-40">
              {loading ? 'Reading…' : 'Use'}
            </button>
            <button type="button" onClick={() => setPicking(false)} className="text-[11px] text-ink-muted hover:text-ink">
              Cancel
            </button>
          </form>
        )}
        {data && !data.detected && !loading && (
          <span className="text-ink-faint">Couldn’t read the catalog to suggest tables{data.detectError ? `: ${data.detectError}` : '.'}</span>
        )}
        {showsTenant && (
          <span className="text-ink-faint leading-relaxed">Agents are asked to stay within one tenant. To make sure, give them a login that can only see one.</span>
        )}
      </div>

      {effective(draft) && (
        <Caveats
          id={conn.id}
          draft={draft}
          setDraft={setDraft}
          levels={levelOptions(effective(draft))}
          suggested={hintsFor(effective(draft))?.shared ?? []}
          tables={data?.tables ?? []}
          detected={Boolean(data?.detected)}
          filterColumn={(() => {
            const k = effective(draft);
            const known: Candidate[] = [...candidates, ...(ctx?.tenant ? [ctx.tenant] : []), ...(setTenant ? [setTenant] : [])];
            const t = known.find((c) => key(c) === k);
            return t?.via?.[0] ?? t?.column ?? 'tenant';
          })()}
        />
      )}

      <div className="flex items-center gap-1.5">
        <button onClick={() => void save()} className="text-[11px] px-2 py-0.5 rounded bg-accent/20 border border-accent/30">
          Save
        </button>
        <button
          onClick={() => {
            setEditing(false);
            void refresh(alwaysEditing);
          }}
          className="text-[11px] text-ink-muted hover:text-ink px-1"
        >
          {alwaysEditing ? 'Discard' : 'Cancel'}
        </button>
      </div>
      {error && <p className="text-warn-strong">{error}</p>}
      <datalist id={`agents-tables-${conn.id}`}>
        {(data?.tables ?? []).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

/// Where the plain tenancy rule is wrong about this database. Each part says
/// what it changes in the rule, and the preview beside it shows the result.
function Caveats({
  id,
  draft,
  setDraft,
  levels,
  suggested,
  tables,
  detected,
  filterColumn,
}: {
  id: string;
  draft: Draft;
  setDraft(d: Draft): void;
  levels: Level[];
  suggested: string[];
  tables: string[];
  detected: boolean;
  filterColumn: string;
}): JSX.Element {
  const [adding, setAdding] = useState('');
  const listId = `agents-tables-${id}`;
  const add = (t: string) => {
    const v = t.trim();
    if (v && !draft.shared.includes(v)) setDraft({ ...draft, shared: [...draft.shared, v] });
    setAdding('');
  };
  const offered = suggested.filter((t) => !draft.shared.includes(t));

  return (
    <div className="flex flex-col gap-3 rounded-md border border-card px-2.5 py-2.5">
      <div className="font-semibold text-[11.5px]">Caveats</div>

      <div className="flex flex-col gap-1">
        <span className="text-ink-muted">Shared by every tenant — not filtered by one</span>
        {draft.shared.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.shared.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded bg-wash-strong px-1.5 py-0.5 font-mono text-[10.5px]">
                {t}
                <button
                  aria-label={`Remove ${t}`}
                  onClick={() => setDraft({ ...draft, shared: draft.shared.filter((x) => x !== t) })}
                  className="text-ink-muted hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          list={listId}
          value={adding}
          onChange={(e) => (tables.includes(e.target.value) ? add(e.target.value) : setAdding(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(adding);
            }
          }}
          placeholder="Add a table: schema.table"
          aria-label="Add a shared table"
          className="field px-1.5 py-0.5 text-[11px]"
        />
        {offered.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-ink-faint">Look shared:</span>
            {offered.map((t) => (
              <button key={t} onClick={() => add(t)} className="rounded border border-dashed border-accent/40 px-1.5 py-0.5 font-mono text-[10.5px] text-accent hover:bg-accent/10">
                + {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-ink-muted">Levels inside a tenant</span>
        {levels.length === 0 ? (
          <span className="text-ink-faint">{detected ? 'None found in the catalog.' : 'Read from the catalog when it can be reached.'}</span>
        ) : (
          levels.map((l) => (
            <label key={key(l)} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.levels.includes(key(l))}
                onChange={(e) =>
                  setDraft({ ...draft, levels: e.target.checked ? [...draft.levels, key(l)] : draft.levels.filter((k) => k !== key(l)) })
                }
              />
              <span>{label(l)}</span>
            </label>
          ))
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">Leave out these tenants unless asked</span>
        <input
          value={draft.excluded}
          onChange={(e) => setDraft({ ...draft, excluded: e.target.value })}
          placeholder={`${filterColumn} values, e.g. test or internal accounts: 2, 9`}
          className="field px-1.5 py-0.5 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">Also filter on</span>
        <input
          value={draft.also}
          onChange={(e) => setDraft({ ...draft, also: e.target.value })}
          placeholder="Other columns that mean the tenant, if the catalog missed one"
          className="field px-1.5 py-0.5 font-mono text-[11px]"
        />
      </label>
    </div>
  );
}
