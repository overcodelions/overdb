import { useEffect, useMemo, useState } from 'react';
import {
  formatBytes,
  linkKey,
  summarize,
  tableKey,
  tenantTables,
  type Link,
  type TableAction,
  type TablePlan,
} from '@shared/baseline';
import { useStore } from './store';
import { RepoLinksPanel, RepoNames } from './RepoLinks';
import { MapCard } from './MapCard';
import type { TenancyLevel } from '@shared/baseline';
import { measuredShare, plansFor, startingPoints, useBaseline, type Login, type LoginHit } from './baselineStore';
import { useTickets } from './ticketsStore';
import { TicketGuide } from './TicketGuide';
import type { BuildProgress } from '@shared/baselineBuild';
import type { TicketState } from '@shared/instances';

// The Create a baseline sheet. The flow lives in baselineStore.ts and the
// rules in src/shared/baseline.ts; this file only draws them.

const BTN = 'h-7 px-3 rounded-[5px] border border-card text-[12px] text-ink hover:bg-wash-strong disabled:opacity-40';
const PRIMARY =
  'h-7 px-3.5 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-[12px] font-semibold disabled:opacity-40 flex items-center gap-2';
const LABEL = 'text-[11px] font-semibold text-ink-muted';
const FIELD = 'field h-7 px-2.5 text-[12px]';

const STEPS = [
  { id: 'start', name: 'Start from' },
  { id: 'sort', name: 'Sort tables' },
  { id: 'build', name: 'Build' },
] as const;

function tildify(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function Spinner(): JSX.Element {
  return <span className="inline-block w-3 h-3 shrink-0 rounded-full border-2 border-ink-muted/30 border-t-ink-muted animate-spin" aria-label="Working" />;
}

function DbIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

export function BaselineSheet({ connectionId }: { connectionId: string }): JSX.Element {
  const conn = useStore((s) => s.connections.find((c) => c.id === connectionId));
  const setSheet = useStore((s) => s.setSheet);
  const b = useBaseline();

  useEffect(() => {
    void useBaseline.getState().open(connectionId);
    return () => useBaseline.getState().close();
  }, [connectionId]);

  return (
    <div className="flex flex-col min-h-0 h-full text-[12px] text-ink">
      <div className="shrink-0 flex items-center gap-3 px-5 pt-4 pb-3">
        <span className="text-accent-strong"><DbIcon /></span>
        <div className="flex-1 min-w-0">
          {conn && conn.env !== 'local' ? (
            <>
              <h2 className="text-sm font-semibold">Copy {conn.name} to this machine</h2>
              <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                A small copy you can write to, still enough to log in and use the app. It becomes a base: branch it for each ticket or anything you want to try. Only reads; nothing on {conn.name} changes.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold">Create a base{conn ? ` · ${conn.name}` : ''}</h2>
              <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                A recipe for a small copy of this database that is still enough to log in and use the app. Only reads; nothing on the server changes.
              </p>
            </>
          )}
        </div>
        <button aria-label="Close" onClick={() => setSheet(null)} className="w-[26px] h-[26px] rounded-[5px] text-ink-muted hover:text-ink hover:bg-wash-strong flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <Stepper />
      {!b.loading && !b.error && <ServerNeeded />}

      {b.loading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-ink-muted">
          <Spinner /> Reading every schema’s catalog and table sizes…
        </div>
      ) : b.error ? (
        <div className="flex-1 px-5 py-5">
          <div role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-bad-strong">{b.error}</div>
        </div>
      ) : b.step === 'start' ? (
        <StartFrom />
      ) : b.step === 'sort' ? (
        <SortTables />
      ) : (
        <Build />
      )}
    </div>
  );
}

function Stepper(): JSX.Element {
  const step = useBaseline((s) => s.step);
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="shrink-0 flex items-center gap-1 px-5 pb-3 border-b border-card" aria-label="Steps">
      <li className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full">
        <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold bg-good/15 text-good">✓</span>
        <span className="text-[11px] font-semibold text-ink-muted">Look</span>
      </li>
      {STEPS.map((s, i) => {
        const done = i < at;
        const here = i === at;
        return (
          <li key={s.id} aria-current={here ? 'step' : undefined} className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full ${here ? 'bg-accent/15' : ''}`}>
            <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold ${
              done ? 'bg-good/15 text-good' : here ? 'bg-accent-strong text-white' : 'bg-wash-strong text-ink-muted'
            }`}>
              {done ? '✓' : i + 2}
            </span>
            <span className={`text-[11px] font-semibold ${here ? 'text-ink' : 'text-ink-muted'}`}>{s.name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Footer({ children, note }: { children: React.ReactNode; note?: React.ReactNode }): JSX.Element {
  return (
    <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-card bg-surface-muted/60">
      <div className="flex-1 min-w-0 text-[11px] text-ink-muted truncate">{note}</div>
      {children}
    </div>
  );
}

// ---- start from -----------------------------------------------------------

function StartFrom(): JSX.Element {
  const b = useBaseline();
  const starts = startingPoints(b);
  const ready = starts.length > 0 || b.tenant === null;
  return (
    <>
      <div className="flex-1 min-h-0 grid grid-cols-[380px_minmax(0,1fr)]">
        <Overview />
        <div className="min-h-0 overflow-y-auto px-6 py-5 flex flex-col gap-6">
          {b.previous && (
            <p className="text-[11px] text-ink-muted">
              Picked up the recipe saved {new Date(b.previous.savedAt).toLocaleDateString()} — its tenant, links and table choices.
            </p>
          )}
          {b.previousError && (
            <p className="text-[11px] text-warn-strong">
              {b.previousError.startsWith('The recipe at') ? b.previousError : `The saved recipe could not be read: ${b.previousError} Starting fresh.`}
            </p>
          )}
          {b.tenant && <TenantSearch />}
          {b.tenant && b.levels.map((lv) => <LevelNarrow key={tableKey(lv.ref)} level={lv} />)}
          <div className="flex flex-col gap-2.5">
            <div>
              <div className="font-semibold">Logins you use</div>
              <p className="text-ink-muted">Each is looked up in every table that keeps logins, and kept in the base with what it belongs to.</p>
            </div>
            <LoginAdder />
            {b.logins.map((l) => <LoginRow key={l.id} login={l} />)}
          </div>
        </div>
      </div>
      <Footer
        note={
          starts.length > 0
            ? `Next: sort every table around ${describeStarts(b)}.`
            : b.tenant
              ? 'Find the account you work in, or a login, to start from.'
              : 'No tenant: tables are sorted by size and name alone.'
        }
      >
        <button className={PRIMARY} disabled={!ready} onClick={() => b.setStep('sort')}>Sort tables</button>
      </Footer>
    </>
  );
}

function describeStarts(b: ReturnType<typeof useBaseline.getState>): string {
  const parts: string[] = [];
  if (b.tenants.length) parts.push(`${b.tenants.length} ${b.tenants.length === 1 ? b.tenant?.table ?? 'tenant' : `${b.tenant?.table ?? 'tenant'} rows`}`);
  const logins = b.logins.filter((l) => l.hits.length > 0).length;
  if (logins) parts.push(`${logins} login${logins === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

function Overview(): JSX.Element {
  const b = useBaseline();
  const bySchema = useMemo(() => {
    const m = new Map<string, { tables: number; bytes: number }>();
    for (const s of b.snapshot?.schemas ?? []) m.set(s.name, { tables: s.tables.filter((t) => t.kind === 'table').length, bytes: 0 });
    for (const st of b.stats) {
      const e = m.get(st.schema);
      if (e) e.bytes += st.bytes ?? 0;
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((x, y) => y.bytes - x.bytes);
  }, [b.snapshot, b.stats]);
  const total = bySchema.reduce((n, s) => n + s.bytes, 0);
  // A server that would not say its sizes (Redshift, for most users) shows
  // none rather than zero.
  const sized = (b.stats ?? []).some((st) => st.bytes !== null);
  const size = (n: number) => (sized ? formatBytes(n) : '—');
  const max = bySchema[0]?.bytes || 1;
  const fks = b.links.filter((l) => l.source === 'fk').length;
  const named = b.links.filter((l) => l.source === 'name').length;
  const fromCode = b.links.filter((l) => l.cited).length;
  const polyFrom = new Set(b.polyLinks.map((l) => `${tableKey(l.from)}.${l.columns[0]}`)).size;
  const family = b.snapshot && b.tenant ? tenantTables(b.snapshot, b.tenant) : [];
  const on = new Set(b.schemasOn);
  const kept = bySchema.filter((x) => on.has(x.name));

  return (
    <div className="min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-4 bg-surface-muted/60 border-r border-card">
      <div>
        <div className="font-semibold">Schemas in the base</div>
        <div className="text-[11px] text-ink-muted mt-0.5">
          {kept.length} of {bySchema.length}{sized ? `, ${size(kept.reduce((n, x) => n + x.bytes, 0))} of ${size(total)} today` : ' — sizes not available from this server'}. Untick a schema and it is not created at all.
        </div>
      </div>
      <div className="flex flex-col gap-0.5 text-[11px] max-h-[240px] overflow-y-auto -mx-1 px-1">
        {bySchema.map((x) => (
          <label key={x.name} className={`grid grid-cols-[14px_minmax(0,110px)_58px_minmax(0,1fr)_48px] gap-2 items-center py-0.5 cursor-pointer ${on.has(x.name) ? '' : 'opacity-50'}`}>
            <input type="checkbox" checked={on.has(x.name)} onChange={() => b.toggleSchema(x.name)} className="accent-[rgb(var(--c-accent-strong))]" />
            <span className="font-mono truncate" title={x.name}>{x.name}</span>
            <span className="text-ink-muted">{x.tables} tables</span>
            <div className="h-1.5 rounded-full bg-accent/70" style={{ width: `${Math.max(2, (x.bytes / max) * 100)}%` }} />
            <span className="text-right tabular-nums">{size(x.bytes)}</span>
          </label>
        ))}
      </div>
      <div className="flex gap-3 text-[11px] -mt-2">
        <button className="text-accent-strong hover:underline" onClick={() => b.setAllSchemas(true)}>All</button>
        <button className="text-accent-strong hover:underline" onClick={() => b.setAllSchemas(false)}>None</button>
      </div>

      {b.schemaFamily && <SchemaFamilyCard />}
      <TenantCard />
      {family.length > 1 && (
        <p className="text-[11px] text-ink-muted">
          Also the same tenant: {family.slice(1).map((r) => <span key={tableKey(r)} className="font-mono">{tableKey(r)} </span>)}— same name and key in another schema.
        </p>
      )}
      <p className="text-[11px] text-ink-muted">
        {fks} foreign keys, and {named} more links guessed from column names{fromCode ? `; the map confirmed or added ${fromCode} from the code` : ''}. The next step lists the guesses so you can turn any off.
      </p>
      {b.polyPairs > 0 && (
        <p className="text-[11px] text-ink-muted">
          {b.polyProgress
            ? <>Reading {b.polyPairs} type columns that may point at more than one table (<span className="font-mono">*_type</span> + <span className="font-mono">*_id</span>)… {b.polyProgress.done}/{b.polyProgress.total}</>
            : <>{polyFrom} of {b.polyPairs} <span className="font-mono">*_type</span> + <span className="font-mono">*_id</span> pairs point at tables by name — {b.polyLinks.length} links, read from a sample of each table. The others hold values like roles, not table names.</>}
        </p>
      )}
    </div>
  );
}

/// One schema per tenant: the tenant is a schema, and choosing yours is the
/// whole of narrowing.
function SchemaFamilyCard(): JSX.Element {
  const b = useBaseline();
  const fam = b.schemaFamily!;
  const on = new Set(b.schemasOn);
  const kept = fam.schemas.filter((x) => on.has(x));
  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 px-3.5 py-3 flex flex-col gap-2">
      <div className="font-semibold">One schema per tenant?</div>
      <div className="text-ink-muted">
        {fam.schemas.length} schemas hold the same {fam.tables} tables. Keep only yours — the others are not created.
      </div>
      <div className="flex flex-wrap gap-1.5">
        {fam.schemas.map((x) => (
          <button
            key={x}
            className={`h-6 px-2 rounded-full text-[11px] font-mono border ${kept.length === 1 && on.has(x) ? 'border-accent/50 bg-accent/15 text-accent-strong' : 'border-card hover:bg-wash-strong'}`}
            onClick={() => b.onlyTenantSchema(x)}
          >
            {x}
          </button>
        ))}
      </div>
    </div>
  );
}

function TenantCard(): JSX.Element {
  const b = useBaseline();
  const [picking, setPicking] = useState(false);
  const top = b.candidates[0];
  const current = b.tenant ? b.candidates.find((c) => tableKey(c.ref) === tableKey(b.tenant!)) : null;
  const emptyHere = !!b.tenant && b.stats.find((x) => x.schema === b.tenant!.schema && x.table === b.tenant!.table)?.rows === 0;
  const foundIn = [...new Set(b.tenants.map((t) => t.from).filter((x): x is string => !!x))];

  return (
    <div className="rounded-md border border-card bg-surface-elevated px-3.5 py-3 flex flex-col gap-2.5">
      {b.tenant ? (
        <>
          <div className="font-semibold">
            Rows look scoped by <span className="font-mono font-medium">{b.tenant.column}</span>
          </div>
          <div className="text-ink-muted">
            {current
              ? <>{current.tables} tables point at <span className="font-mono">{tableKey(b.tenant)}</span>, more than any other table.</>
              : <>The tenant is <span className="font-mono">{tableKey(b.tenant)}</span>.</>}
          </div>
          {emptyHere && (
            // A mart can keep its clients in another table and leave this
            // one empty; the key is what scopes, wherever the row lives.
            <div className="text-ink-muted">
              It is empty on this server{foundIn.length > 0 && <> — {b.tenants.length === 1 ? b.tenants[0].label : 'the clients you start from'} {foundIn.length === 1 ? 'was' : 'were'} found in <span className="font-mono">{foundIn.join(', ')}</span></>}.
              That is fine: what scopes the copy is the {b.tenant.column}, and the {current?.tables ?? ''} tables pointing here keep the rows that carry yours.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="font-semibold">No tenant</div>
          <div className="text-ink-muted">
            {top
              ? <>The most-referenced table is <span className="font-mono">{tableKey(top.ref)}</span>, with {top.tables} tables pointing at it — too few to call it a tenant.</>
              : 'Nothing is referenced widely enough to be a tenant.'}{' '}
            Start from logins alone.
          </div>
        </>
      )}
      {picking ? (
        <div className="flex flex-col gap-1">
          {b.candidates.map((c) => (
            <button
              key={tableKey(c.ref)}
              className="text-left px-2 py-1 rounded-[5px] hover:bg-wash-strong flex justify-between gap-2"
              onClick={() => { b.setTenant({ ...c.ref, column: c.column }); setPicking(false); }}
            >
              <span className="font-mono truncate">{tableKey(c.ref)}</span>
              <span className="text-ink-muted shrink-0">{c.tables} tables</span>
            </button>
          ))}
          <button className="text-left px-2 py-1 rounded-[5px] hover:bg-wash-strong" onClick={() => { b.setTenant(null); setPicking(false); }}>
            No tenants — start from logins
          </button>
        </div>
      ) : (
        <button className={`${BTN} self-start`} onClick={() => setPicking(true)}>
          {b.tenant ? 'Pick another' : 'Pick a tenant'}
        </button>
      )}
    </div>
  );
}

function TenantSearch(): JSX.Element {
  const b = useBaseline();
  const chosen = new Set(b.tenants.map((t) => t.key));
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="baseline-tenant" className="font-semibold">The {b.tenant?.table ?? 'tenant'} you work in</label>
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); void b.searchTenant(); }}
      >
        <input
          id="baseline-tenant"
          className={`${FIELD} w-[320px]`}
          placeholder="A name, or its key"
          value={b.tenantTerm}
          onChange={(e) => b.setTenantTerm(e.target.value)}
        />
        <button type="submit" className={`${BTN} inline-flex items-center gap-1.5`} disabled={!b.tenantTerm.trim() || b.tenantSearching}>
          {b.tenantSearching ? <><Spinner /> Finding</> : 'Find'}
        </button>
      </form>
      {b.tenantError && <p role="alert" className="text-bad-strong">{b.tenantError}</p>}
      {b.tenantSearchingIn && (
        <p className="text-[11px] text-ink-muted flex items-center gap-1.5"><Spinner /> Looking in <span className="font-mono">{b.tenantSearchingIn}</span>…</p>
      )}
      {!b.tenantSearching && b.tenantHits?.length === 0 && <p className="text-ink-muted">Nothing matched “{b.tenantTerm.trim()}”.</p>}
      {!b.tenantSearching && b.tenantHits !== null && <LookIn />}
      {(b.tenantHits?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-3 max-w-[600px]">
          {[...new Set(b.tenantHits!.map((h) => h.from ?? ''))].map((from) => {
            const rows = b.tenantHits!.filter((h) => (h.from ?? '') === from);
            return (
              <div key={from || 'own'} className="flex flex-col gap-1">
                {(from || b.tenantHits!.some((h) => h.from)) && (
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                    In <span className="font-mono normal-case tracking-normal">{from || (b.tenant ? `${b.tenant.schema}.${b.tenant.table}` : 'the tenant')}</span>
                    <span className="font-normal normal-case tracking-normal"> · {rows.length}</span>
                  </div>
                )}
                <ul className="flex flex-col gap-1">
                  {rows.map((h) => (
                    <li key={h.key}>
                      <label className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border ${chosen.has(h.key) ? 'border-good/30 bg-good/5' : 'border-card hover:bg-wash'}`}>
                        <input type="checkbox" checked={chosen.has(h.key)} onChange={() => b.toggleTenant(h)} className="accent-[rgb(var(--c-accent-strong))]" />
                        <span className="font-medium truncate">{h.label}</span>
                        <span className="ml-auto font-mono text-[10.5px] text-ink-faint truncate max-w-[180px]" title={h.key}>{h.key}</span>
                        {h.inactive && <span className="shrink-0 text-[10px] font-semibold px-1.5 rounded-[3px] text-warn-strong bg-warn/10">inactive</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {b.tenants.filter((t) => !b.tenantHits?.some((h) => h.key === t.key)).map((t) => (
        <div key={t.key} className="text-[11px] text-ink-muted">
          Also starting from <span className="font-medium text-ink">{t.label}</span> <span className="font-mono">{t.key}</span>{' '}
          <button className="text-accent-strong hover:underline" onClick={() => b.toggleTenant(t)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

/// Where the last search looked, and any other table to look in — so a
/// client kept in a table the search did not think of can still be found.
function LookIn(): JSX.Element | null {
  const b = useBaseline();
  const [pick, setPick] = useState('');
  if (!b.snapshot || !b.tenant) return null;
  const go = (key: string) => {
    const [schema, ...rest] = key.split('.');
    setPick('');
    void b.searchTenantIn({ schema, table: rest.join('.') });
  };
  const col = b.tenant.column.toLowerCase();
  // Tables and views carrying the tenant's key first, then the rest.
  const all = b.snapshot.schemas
    .flatMap((sc) => sc.tables.filter((t) => t.kind !== 'matview').map((t) => ({ key: `${sc.name}.${t.name}`, t, has: t.columns.some((c) => c.name.toLowerCase() === col) })))
    .sort((x, y) => Number(y.has) - Number(x.has) || x.key.localeCompare(y.key));
  // Every word typed must appear, in any order: "db client" finds acme_db_client.
  const needle = pick.trim().toLowerCase();
  const words = needle.split(/[\s._]+/).filter(Boolean);
  const matches = needle ? all.filter((x) => words.every((w) => x.key.toLowerCase().includes(w))) : [];
  const shown = matches.slice(0, 8);
  return (
    <div className="flex flex-col gap-1.5 text-[11px] text-ink-muted max-w-[600px]">
      <p>
        Looked in{' '}
        {b.tenantLookedIn.map((x, i) => (
          <span key={x}>
            {i > 0 && ', '}
            <span className="font-mono text-ink">{x}</span>
          </span>
        ))}
        .
      </p>
      <div className="flex flex-col gap-1">
        <input
          className="field h-7 px-2 text-[11.5px] w-[320px]"
          placeholder="Look in another table — type part of its name"
          aria-label="Find a table to look in"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              go(shown[0].key);
            }
          }}
        />
        {needle && (
          <ul className="flex flex-col w-[420px] rounded-md border border-card bg-surface-elevated overflow-hidden">
            {shown.map((x) => (
              <li key={x.key}>
                <button className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-accent/15 focus:bg-accent/15 focus:outline-none" onClick={() => go(x.key)}>
                  <span className="font-mono text-[11px] text-ink truncate">{x.key}</span>
                  {x.t.kind === 'view' && <span className="text-[10px] text-ink-faint">view</span>}
                  {x.has && <span className="ml-auto shrink-0 text-[10px] text-good">has {b.tenant!.column}</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2.5 py-1.5 text-ink-faint">No table or view named like “{pick.trim()}”.</li>}
            {matches.length > shown.length && <li className="px-2.5 py-1 text-ink-faint">+ {matches.length - shown.length} more — keep typing</li>}
          </ul>
        )}
      </div>
      {all.length === 0 && <p>No tables were read from this server.</p>}
    </div>
  );
}

/// "Partners within Acme": every one by default, or only the ones chosen —
/// by name, or the ones your logins belong to.
function LevelNarrow({ level }: { level: TenancyLevel }): JSX.Element {
  const b = useBaseline();
  const key = tableKey(level.ref);
  const chosen = b.narrowing[key] ?? [];
  const some = chosen.length > 0;
  const [open, setOpen] = useState(some);
  const [note, setNote] = useState<string | null>(null);
  const word = level.ref.table;
  // Two levels of the same name — `public.partner` and `acme_dm.partner` —
  // are told apart by their schema.
  const twin = b.levels.some((l) => l !== level && l.ref.table === level.ref.table);
  const within = b.tenants.length > 0 ? whoFor(b) : `the ${b.tenant?.table ?? 'tenant'}`;
  const hits = b.levelHits[key];
  const chosenKeys = new Set(chosen.map((r) => r.key));
  const loginsFound = b.logins.some((l) => l.hits.length > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="font-semibold">
        Narrow further: {word}
        {twin && <span className="font-normal text-ink-muted"> · {level.ref.schema}</span>}
      </div>
      <p className="text-ink-muted max-w-[560px]">
        {level.tables} tables carry a <span className="font-mono">{level.column}</span>, and each {word} belongs to a {b.tenant?.table}. Keep all of {within}’s {word}s, or only some — every table with a {level.column} then keeps only theirs, plus the rows that belong to no {word} at all ({within}’s own staff and settings).
      </p>
      <div className="flex gap-1.5" role="radiogroup" aria-label={`Which ${word}s`}>
        <button
          role="radio"
          aria-checked={!some && !open}
          className={`h-7 px-3 rounded-[5px] border text-[12px] ${!some && !open ? 'border-accent/50 bg-accent/10 text-accent-strong' : 'border-card hover:bg-wash-strong'}`}
          onClick={() => { b.clearLevel(key); setOpen(false); }}
        >
          All of {within}’s {word}s
        </button>
        <button
          role="radio"
          aria-checked={some || open}
          className={`h-7 px-3 rounded-[5px] border text-[12px] ${some || open ? 'border-accent/50 bg-accent/10 text-accent-strong' : 'border-card hover:bg-wash-strong'}`}
          onClick={() => setOpen(true)}
        >
          Only some
        </button>
      </div>
      {(open || some) && (
        <div className="flex flex-col gap-2 pl-0.5 max-w-[560px]">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void b.searchLevel(key); }}>
            <input
              className={`${FIELD} w-[260px]`}
              placeholder={`A ${word} name, or its key`}
              aria-label={`Find a ${word}`}
              value={b.levelTerm[key] ?? ''}
              onChange={(e) => b.setLevelTerm(key, e.target.value)}
            />
            <button type="submit" className={BTN} disabled={!(b.levelTerm[key] ?? '').trim() || b.levelBusy[key]}>
              {b.levelBusy[key] ? <Spinner /> : 'Find'}
            </button>
            {loginsFound && (
              <button
                type="button"
                className={BTN}
                onClick={() => void b.levelFromLogins(key).then((n) => setNote(n === 0 ? `None of the logins found belongs to a ${word}.` : null))}
              >
                The {word}s my logins belong to
              </button>
            )}
          </form>
          {note && <p className="text-ink-muted">{note}</p>}
          {hits?.length === 0 && <p className="text-ink-muted">No {word} of {within} matched.</p>}
          {(hits?.length ?? 0) > 0 && (
            <ul className="flex flex-col gap-1 max-h-[180px] overflow-y-auto">
              {hits!.map((h) => (
                <li key={h.key}>
                  <label className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border ${chosenKeys.has(h.key) ? 'border-good/30 bg-good/5' : 'border-card'}`}>
                    <input type="checkbox" checked={chosenKeys.has(h.key)} onChange={() => b.toggleLevelRow(key, h)} className="accent-[rgb(var(--c-accent-strong))]" />
                    <span className="font-medium truncate">{h.label}</span>
                    <span className="font-mono text-[11px] text-ink-muted truncate">{h.key}</span>
                    {h.inactive && <span className="ml-auto shrink-0 text-[10px] font-semibold px-1.5 rounded-[3px] text-warn-strong bg-warn/10">inactive</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {some && (
            <div className="flex flex-wrap gap-1.5">
              {chosen.map((r) => (
                <span key={r.key} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-accent/10 text-accent-strong text-[11px]">
                  {r.label}
                  <button aria-label={`Remove ${r.label}`} className="w-4 h-4 rounded-full hover:bg-accent/20" onClick={() => b.toggleLevelRow(key, r)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// One box that adds logins, rather than a box per login: type one and
/// press Enter, or paste several. Each becomes its own card below.
function LoginAdder(): JSX.Element {
  const b = useBaseline();
  const [text, setText] = useState('');
  const count = text.split(/[\s,;]+/).filter(Boolean).length;
  return (
    <form
      className="flex gap-2 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text;
        setText('');
        void b.addLogins(value);
      }}
    >
      <label htmlFor="add-login" className="sr-only">Add a login</label>
      <input
        id="add-login"
        className={`${FIELD} w-[340px]`}
        placeholder="Add an email or username — or paste several"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className={BTN} disabled={count === 0}>
        {count > 1 ? `Add ${count}` : 'Add'}
      </button>
    </form>
  );
}

/// A login that was added: what it is, where it was found, and what it
/// belongs to.
function LoginRow({ login }: { login: Login }): JSX.Element {
  const b = useBaseline();
  const status = login.searching
    ? null
    : login.error
      ? 'could not look it up'
      : login.searched
        ? login.hits.length === 0
          ? 'not found'
          : `found in ${login.hits.length} table${login.hits.length === 1 ? '' : 's'}`
        : '';
  return (
    <div className="rounded-md border border-card bg-surface-elevated/60 max-w-[600px]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-medium truncate">{login.term}</span>
        <span className={`text-[11px] ${login.searched && login.hits.length === 0 ? 'text-warn-strong' : 'text-ink-muted'}`}>
          {login.searching ? <span className="inline-flex items-center gap-1.5"><Spinner /> looking it up</span> : status}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`Remove ${login.term}`}
          title="Remove this login"
          className="w-6 h-6 rounded-[5px] text-ink-muted hover:text-ink hover:bg-wash-strong"
          onClick={() => b.removeLogin(login.id)}
        >
          ×
        </button>
      </div>
      {(login.error || login.hits.length > 0 || (login.searched && login.hits.length === 0)) && (
        <div className="flex flex-col gap-1.5 px-3 pb-2.5">
          {login.error && <p role="alert" className="text-bad-strong">{login.error}</p>}
          {login.searched && !login.error && login.hits.length === 0 && (
            <p className="text-ink-muted">No table that keeps logins has this email or username. Check the spelling, or remove it.</p>
          )}
          {login.hits.map((h) => <LoginFinding key={`${tableKey(h.ref)}:${h.key}`} hit={h} />)}
        </div>
      )}
    </div>
  );
}

function LoginFinding({ hit }: { hit: LoginHit }): JSX.Element {
  const b = useBaseline();
  const conventional = /^users?$/i.test(hit.ref.table);
  const chosen = hit.tenantKey !== null && b.tenants.some((t) => t.key === hit.tenantKey);
  const other = hit.tenantKey !== null && !chosen && b.tenants.length > 0;

  let tone = 'border-good/30 bg-good/5';
  if (hit.unlinked || !conventional) tone = 'border-ai/30 bg-ai/5';
  if (other) tone = 'border-warn/30 bg-warn/5';

  return (
    <div className={`rounded-md border px-3 py-2 flex flex-col gap-1 ${tone}`}>
      <div>
        <span className="font-semibold">Found in <span className="font-mono">{tableKey(hit.ref)}</span></span>{' '}
        <span className="font-mono text-[11px] text-ink-muted">{hit.column} {hit.key}</span>
      </div>
      {hit.facts.length > 0 && <div className="text-ink-muted">{hit.facts.join(' · ')}</div>}
      {hit.unlinked && (
        <div className="text-ink-muted">
          This table has no link to {b.tenant?.table ?? 'the tenant'} that overdb can see. The login is kept; how it reaches an account is a question for the code.
        </div>
      )}
      {hit.tenantKey && chosen && (
        <div className="text-ink-muted">On {hit.tenantLabel ?? hit.tenantKey}, which you start from.</div>
      )}
      {hit.tenantKey && !chosen && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={false}
            onChange={() => b.toggleTenant({ key: hit.tenantKey!, label: hit.tenantLabel ?? hit.tenantKey!, inactive: false })}
            className="accent-[rgb(var(--c-accent-strong))]"
          />
          <span>
            On <span className="font-medium">{hit.tenantLabel ?? hit.tenantKey}</span>
            {b.tenants.length > 0 ? ', not one you start from.' : '.'} Include it in the base too
          </span>
        </label>
      )}
    </div>
  );
}

// ---- sort tables ----------------------------------------------------------

/// Three answers to "what happens to this table", which is the question the
/// screen exists for. The six actions underneath stay in the recipe.
type Bucket = 'keep' | 'whole' | 'none';

const BUCKET: Record<TableAction, Bucket> = {
  scoped: 'keep', whole: 'whole', empty: 'none', review: 'none', skip: 'none', schema: 'none',
};

const NONE_PARTS: Array<{ action: TableAction; label: string }> = [
  { action: 'empty', label: 'logs, history and queues' },
  { action: 'review', label: 'large or unsized tables tied to nothing you start from' },
  { action: 'schema', label: 'empty today' },
  { action: 'skip', label: 'backups and scratch copies, left out altogether' },
];

/// Who the measured share belongs to: the narrowest level chosen, or the
/// tenant.
function measuredWho(b: ReturnType<typeof useBaseline.getState>): string {
  const level = b.levels.filter((l) => (b.narrowing[tableKey(l.ref)] ?? []).length > 0).pop();
  if (!level) return whoFor(b);
  const rows = b.narrowing[tableKey(level.ref)];
  return rows.length === 1 ? rows[0].label : `${rows.length} ${level.ref.table}s`;
}

/// Who the baseline is built around, in the person's own words.
function whoFor(b: ReturnType<typeof useBaseline.getState>): string {
  const names = b.tenants.map((t) => t.label);
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} and ${names.length - 1} more`;
  const login = b.logins.find((l) => l.hits.length > 0)?.term.trim();
  return login || 'your starting points';
}

function count(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}

function SortTables(): JSX.Element {
  const b = useBaseline();
  const words = useSourceWords();
  const plans = useMemo(() => plansFor(b), [b.snapshot, b.stats, b.links, b.linksOff, b.tenant, b.tenants, b.logins, b.overrides, b.measured]);
  const sum = useMemo(() => summarize(plans), [plans]);
  const [open, setOpen] = useState<Bucket | null>(null);
  useEffect(() => {
    void useBaseline.getState().measure();
  }, [b.tenants, b.narrowing]);
  const share = measuredShare(b);
  const [query, setQuery] = useState('');
  const who = whoFor(b);
  const tenantWord = b.tenant?.table ?? 'tenant';

  const inBucket = (k: Bucket) => plans.filter((p) => BUCKET[p.action] === k);
  const keep = inBucket('keep');
  const whole = inBucket('whole');
  const none = inBucket('none');
  // Redshift gives a plain user row counts but no sizes: then the sums are
  // in rows, not a row of "0 B".
  const sized = plans.some((p) => p.bytes !== null);
  const bytes = (ps: TablePlan[], kept: boolean) =>
    ps.reduce((n, p) => n + ((sized ? (kept ? p.keepBytes : p.bytes) : (kept ? (p.action === 'whole' ? p.rows : p.keepRows) : p.rows)) ?? 0), 0);
  const amount = (n: number) => (sized ? formatBytes(n) : `${count(n)} rows`);

  const needle = query.trim().toLowerCase();
  const matches = needle ? plans.filter((p) => tableKey(p.ref).toLowerCase().includes(needle)) : null;

  return (
    <>
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-h-0 overflow-y-auto px-6 py-5 flex flex-col gap-4 [&>*]:shrink-0">
          <div className="flex flex-col gap-1">
            <p className="text-[14px] leading-6">
              Keeps the rows for <b>{who}</b>
              {b.levels.filter((lv) => (b.narrowing[tableKey(lv.ref)] ?? []).length > 0).map((lv) => {
                const rows = b.narrowing[tableKey(lv.ref)];
                return <span key={tableKey(lv.ref)}> — only {rows.length === 1 ? `the ${lv.ref.table}` : `${rows.length} ${lv.ref.table}s`} <b>{rows.map((r) => r.label).join(', ')}</b></span>;
              })}{' '}
              in {keep.length} tables, copies {whole.length} small tables whole, and copies no rows from the other {none.length}.
            </p>
            <p className="text-ink-muted">
              <span className="text-[20px] leading-7 font-semibold text-ink tracking-tight">{sized ? `${formatBytes(sum.bytes)} → about ${formatBytes(sum.keepBytes)}` : `${amount(bytes(plans, false))} → about ${amount(bytes([...keep, ...whole], true))}`}</span>
              {'  '}
              {share !== null && b.measured
                ? `estimated: ${measuredWho(b)} holds ${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of ${b.measured.table}, counted just now`
                : b.tenants.length > 0
                  ? `estimated as if ${whoFor(b)} were an average-sized ${tenantWord}${b.measuring ? ' — measuring…' : ''}`
                  : 'estimated from the server’s statistics'}
            </p>
          </div>

          <input
            className={`${FIELD} w-[320px] shrink-0`}
            placeholder="Find a table"
            aria-label="Find a table"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {matches ? (
            <div className="rounded-md border border-card overflow-hidden">
              <div className="px-3.5 py-2 text-ink-muted border-b border-card">
                {matches.length === 0 ? `No table matches “${query.trim()}”.` : `${matches.length} matching`}
              </div>
              {matches.length > 0 && <TableList plans={matches} who={who} showBucket />}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Section
                id="keep"
                title={`Rows for ${who} only`}
                explain={`Tables tied to ${who}: they carry a ${b.tenant?.column ?? 'key'}, or point at a table that does. Only the rows that belong to ${who} are copied.`}
                tables={keep.length}
                today={bytes(keep, false)}
                kept={bytes(keep, true)}
                amount={amount}
                open={open === 'keep'}
                onToggle={() => setOpen(open === 'keep' ? null : 'keep')}
              >
                <TableList plans={keep} who={who} />
              </Section>
              <Section
                id="whole"
                title="Copied whole"
                explain={`Small tables not tied to any ${tenantWord}: settings, types, lookups. The app needs all of them, and all of them is small.`}
                tables={whole.length}
                today={bytes(whole, false)}
                kept={bytes(whole, true)}
                amount={amount}
                open={open === 'whole'}
                onToggle={() => setOpen(open === 'whole' ? null : 'whole')}
              >
                <TableList plans={whole} who={who} />
              </Section>
              <Section
                id="none"
                title="No rows copied"
                explain={
                  NONE_PARTS
                    .map((part) => ({ ...part, n: none.filter((p) => p.action === part.action).length }))
                    .filter((part) => part.n > 0)
                    .map((part) => `${part.n} ${part.label}`)
                    .join(' · ') +
                  (none.some((p) => p.action === 'skip')
                    ? '. Created empty so the app still finds them — except backups, which are not created at all.'
                    : '. Created empty, so the app still finds them.')
                }
                tables={none.length}
                today={bytes(none, false)}
                kept={0}
                amount={amount}
                open={open === 'none'}
                onToggle={() => setOpen(open === 'none' ? null : 'none')}
              >
                <TableList plans={none} who={who} />
              </Section>
            </div>
          )}
        </div>
        <Links />
      </div>
      <Footer
        note={
          b.savedPath
            ? <>Saved to <span className="font-mono">{tildify(b.savedPath)}</span>.</>
            : b.saveError
              ? <span className="text-bad-strong">{b.saveError}</span>
              : b.recipePath
                ? <>Saves to <span className="font-mono">{tildify(b.recipePath)}</span>{b.repo ? ', in the linked repo' : ''}.</>
                : null
        }
      >
        <button className={BTN} onClick={() => b.setStep('start')}>Back</button>
        <button className={BTN} disabled={b.saving || !!b.savedPath} onClick={() => void b.save()}>
          {b.savedPath ? 'Saved' : 'Save recipe'}
        </button>
        <button
          className={PRIMARY}
          disabled={b.saving || !buildable(b.snapshot?.engine) || (!!b.server && !b.server.found)}
          title={!buildable(b.snapshot?.engine) ? 'Bases are for MySQL, MariaDB, Postgres and Redshift' : b.server && !b.server.found ? 'Install the server it runs on first, above' : undefined}
          onClick={() => void b.build()}
        >
          {b.saving && <Spinner />} {words.remote ? 'Copy to this machine' : 'Build base'}
        </button>
      </Footer>
    </>
  );
}

// ---- build ----------------------------------------------------------------

const STAGES: Array<{ id: BuildProgress['stage']; name: string }> = [
  { id: 'start', name: 'Start an empty instance here' },
  { id: 'schemas', name: 'Create schemas' },
  { id: 'tables', name: 'Create tables' },
  { id: 'rows', name: 'Copy rows' },
  { id: 'parents', name: 'Complete foreign keys' },
  { id: 'objects', name: 'Views, routines, triggers' },
  { id: 'users', name: 'Accounts' },
  { id: 'finish', name: 'Save it as the base' },
];

function useElapsed(from: number | null, running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  return from ? Math.max(0, Math.round((now - from) / 1000)) : 0;
}

/// A copy runs on a server of the same kind as the one it came from —
/// MySQL 8's tables do not load into MariaDB — so when this machine has
/// none, say so before any work is done, and offer to install it.
function ServerNeeded(): JSX.Element | null {
  const b = useBaseline();
  const sv = b.server;
  if (!sv || sv.found || !sv.flavor) return null;
  const kind = KIND_NAME[sv.flavor] ?? 'MySQL';
  const redshift = /redshift/i.test(b.snapshot?.serverVersion ?? '');
  return (
    <div className="mx-5 mb-2 rounded-md border border-warn/35 bg-warn/5 px-3.5 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <p className="leading-snug">
          <b>This copy needs {kind} {sv.version} on this machine.</b>{' '}
          <span className="text-ink-muted">
            {redshift
              ? 'Redshift does not run on a Mac, so its copy runs on Postgres — Redshift’s storage settings are left behind, its types mapped to the nearest Postgres ones.'
              : <>The server is {kind}, and its copy runs on the same kind{sv.flavor === 'mysql' ? ' — MariaDB cannot load MySQL 8’s tables' : ''}.</>}{' '}
            overdb only needs the program; it starts and stops its own copies and never runs it as a service.
          </span>
        </p>
        {b.install ? (
          <p className="font-mono text-[11px] text-ink-muted truncate" title={b.install.line}><Spinner /> {b.install.line}</p>
        ) : sv.formula ? (
          <p className="text-[11px] text-ink-muted">
            Installs with Homebrew: <span className="font-mono text-ink">brew install {sv.formula}</span> · a few minutes
          </p>
        ) : (
          <p className="text-[11px] text-ink-muted">
            {sv.brew ? 'Homebrew has no formula for it.' : 'Homebrew is not installed.'} Install {kind} {sv.version} another way, then check again.
          </p>
        )}
        {b.installError && <p role="alert" className="text-[11px] text-bad-strong break-words">{b.installError}</p>}
      </div>
      {sv.formula ? (
        <button className={`${PRIMARY} shrink-0`} disabled={!!b.install} onClick={() => void b.installServer()}>
          {b.install ? 'Installing…' : `Install ${kind} ${sv.formula.split('@')[1] ?? ''}`.trim()}
        </button>
      ) : (
        <button className={`${BTN} shrink-0`} onClick={() => void b.checkServer()}>Check again</button>
      )}
    </div>
  );
}

const buildable = (engine: string | undefined) => engine === 'mysql' || engine === 'postgres';
const KIND_NAME: Record<string, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'Postgres' };

/// A base of a shared server is a copy of it, and is said that way: "your
/// server" is wrong for a sandbox someone else runs.
function useSourceWords(): { remote: boolean; name: string; server: string } {
  const b = useBaseline();
  const conn = useStore((s) => s.connections.find((c) => c.id === b.connectionId));
  const found = b.server?.found;
  const kind = found && b.server?.flavor ? KIND_NAME[b.server.flavor] : null;
  const version = found ? (b.server?.flavor === 'postgres' ? found.version.split('.')[0] : found.version.split('.').slice(0, 2).join('.')) : '';
  return {
    remote: !!conn && conn.env !== 'local',
    name: conn?.name ?? 'the server',
    server: kind ? `${kind} ${version}` : 'a new',
  };
}

function Build(): JSX.Element {
  const b = useBaseline();
  const words = useSourceWords();
  const running = b.buildJob !== null;
  const elapsed = useElapsed(b.buildStartedAt, running);
  const last = b.buildLog[b.buildLog.length - 1];
  const reached = new Set(b.buildLog.map((l) => l.stage));
  const counted = [...b.buildLog].reverse().find((l) => l.total);

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        {b.built ? (
          <Built />
        ) : (
          <>
            <div>
              <p className="text-[14px] leading-6">
                {running
                  ? words.remote
                    ? <>Copying <b>{words.name}</b> to this machine, for <b>{whoFor(b)}</b>. {words.name} is only read; the copy is written to {words.server === 'a new' ? 'a new instance' : `a ${words.server} instance`} overdb runs here.</>
                    : <>Building a base for <b>{whoFor(b)}</b>. Your server is only read; everything is written to {words.server === 'a new' ? 'a new instance' : `a ${words.server} instance`} overdb runs.</>
                  : b.buildError
                    ? words.remote ? 'The copy stopped.' : 'The build stopped.'
                    : words.remote ? 'Ready to copy.' : 'Ready to build.'}
              </p>
              {running && <p className="text-ink-muted">{elapsed}s · {last?.text ?? 'Starting'}</p>}
            </div>
            {b.buildError && (
              <div role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 flex items-start gap-3">
                <span className="flex-1 min-w-0 text-bad-strong break-words">{b.buildError}</span>
                {b.buildLogFile && (
                  <button
                    className="shrink-0 text-[11px] text-ink-muted hover:text-ink underline decoration-dotted underline-offset-2"
                    onClick={() => void window.overdb.invoke('app:showLog', b.buildLogFile!)}
                    title={b.buildLogFile}
                  >
                    Show the log
                  </button>
                )}
              </div>
            )}
            <ol className="flex flex-col gap-2 max-w-[560px]">
              {STAGES.map((st) => {
                const here = running && last?.stage === st.id;
                const done = reached.has(st.id) && !here;
                return (
                  <li key={st.id} className="flex items-center gap-2.5">
                    <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold ${
                      done ? 'bg-good/15 text-good' : here ? 'bg-accent-strong text-white' : 'bg-wash-strong text-ink-muted'
                    }`}>
                      {done ? '✓' : here ? <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> : ''}
                    </span>
                    <span className={here ? 'font-semibold' : done ? '' : 'text-ink-muted'}>{st.id === 'start' && words.server !== 'a new' ? `Start ${words.server} here` : st.name}</span>
                    {here && counted?.stage === st.id && counted.total ? (
                      <span className="flex items-center gap-2 text-ink-muted">
                        <span className="w-40 h-1.5 rounded-full bg-wash-strong overflow-hidden">
                          <span className="block h-full bg-accent" style={{ width: `${Math.round(((counted.done ?? 0) / counted.total) * 100)}%` }} />
                        </span>
                        {counted.done}/{counted.total}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
      <Footer note={running ? 'It keeps going if you send it to the background; closing the sheet any other way stops it and throws away what it made.' : undefined}>
        {running ? (
          <>
            <button className={BTN} onClick={() => b.stopBuild()}>Stop</button>
            <button className={PRIMARY} onClick={() => b.background()}>Keep going in the background</button>
          </>
        ) : (
          <>
            <button className={BTN} onClick={() => b.setStep('sort')}>Back to tables</button>
            {b.built
              ? <button className={PRIMARY} onClick={() => useStore.getState().setSheet(null)}>Done</button>
              : <button className={PRIMARY} disabled={!!b.server && !b.server.found} onClick={() => void b.build()}>{words.remote ? 'Copy again' : 'Build again'}</button>}
          </>
        )}
      </Footer>
    </>
  );
}

function Built(): JSX.Element {
  const b = useBaseline();
  const words = useSourceWords();
  const setSheet = useStore((s) => s.setSheet);
  const select = useStore((s) => s.select);
  const tickets = useTickets();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState<TicketState | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const r = b.built!.report;

  return (
    <div className="flex flex-col gap-5 max-w-[720px]">
      <div className="rounded-md border border-good/30 bg-good/5 px-4 py-3 flex flex-col gap-1">
        <div className="text-[14px] font-semibold">
          {words.remote ? <>Copied {words.name} to this machine — a base for {b.built!.label}</> : <>Base built for {b.built!.label}</>}
        </div>
        <div className="text-ink-muted">
          {r.tables} tables · {r.rows.toLocaleString()} rows · {formatBytes(b.built!.bytes)} on disk · {Math.round(r.durationMs / 1000)}s
          {r.filled > 0 && <> · {r.filled.toLocaleString()} parent rows fetched so no foreign key points at nothing</>}
        </div>
        {r.skipped.length > 0 && (
          <div>
            <button className="text-[12px] text-warn-strong hover:underline" onClick={() => setShowSkipped(!showSkipped)}>
              {r.skipped.length} things could not be recreated {showSkipped ? '▾' : '▸'}
            </button>
            {showSkipped && (
              <ul className="mt-1 flex flex-col gap-0.5 text-[11px]">
                {r.skipped.map((x) => <li key={x.what}><span className="font-mono">{x.what}</span> <span className="text-ink-muted">— {x.reason}</span></li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {made ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px]">
            <b>{made.name}</b> is running. Here is how to use it.
          </p>
          <TicketGuide ticket={made} />
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void tickets.create(b.built!.id, name, note).then((t) => t && setMade(t));
          }}
        >
          <div className="font-semibold">Make a branch for a ticket</div>
          <p className="text-ink-muted">A clone of this base with its own port. Seed it, break it, throw it away — the base stays as it is.</p>
          <div className="flex gap-2">
            <input className={`${FIELD} w-[160px]`} placeholder="PROJ-123, or any name" aria-label="Branch name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className={`${FIELD} flex-1`} placeholder="What it is for (optional)" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className={PRIMARY} disabled={!name.trim() || !!tickets.busy.new}>
              {tickets.busy.new ? <><Spinner /> Cloning</> : 'Make branch'}
            </button>
          </div>
          {tickets.error && <p role="alert" className="text-bad-strong">{tickets.error}</p>}
        </form>
      )}
    </div>
  );
}

function Section(props: {
  id: Bucket;
  title: string;
  explain: string;
  tables: number;
  today: number;
  kept: number;
  amount(n: number): string;
  open: boolean;
  onToggle(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-md border border-card overflow-hidden">
      <button
        className={`w-full flex items-start gap-3 px-4 py-3 text-left ${props.open ? 'bg-accent/5' : 'hover:bg-wash'}`}
        aria-expanded={props.open}
        aria-controls={`baseline-${props.id}`}
        onClick={props.onToggle}
      >
        <span className="mt-0.5 text-ink-muted w-3">{props.open ? '▾' : '▸'}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold">{props.title} <span className="font-normal text-ink-muted">· {props.tables} tables</span></span>
          <span className="block text-ink-muted mt-0.5">{props.explain}</span>
        </span>
        <span className="shrink-0 text-right tabular-nums">
          <span className="block">{props.id === 'none' ? props.amount(0) : `~${props.amount(props.kept)}`}</span>
          <span className="block text-[11px] text-ink-muted">of {props.amount(props.today)} today</span>
        </span>
      </button>
      {props.open && <div id={`baseline-${props.id}`} className="border-t border-card">{props.children}</div>}
    </section>
  );
}

const MOVES: Array<{ action: TableAction; label: (who: string) => string }> = [
  { action: 'scoped', label: (who) => `Rows for ${who} only` },
  { action: 'whole', label: () => 'Copy whole' },
  { action: 'empty', label: () => 'Create empty' },
  { action: 'skip', label: () => 'Leave out' },
];

const ROW_LIMIT = 200;

function TableList({ plans, who, showBucket = false }: { plans: TablePlan[]; who: string; showBucket?: boolean }): JSX.Element {
  const b = useBaseline();
  const sorted = [...plans].sort((x, y) => (y.bytes ?? 0) - (x.bytes ?? 0));
  const cols = 'grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_150px_120px] gap-4 items-center';
  return (
    <div className="max-h-[420px] overflow-y-auto">
      <div className={`${cols} sticky top-0 z-10 bg-surface-elevated px-4 pt-2.5 pb-2 text-[11px] text-ink-muted`}>
        <span>Table</span>
        <span>Why</span>
        <span className="text-right">Rows copied</span>
        <span />
      </div>
      {sorted.slice(0, ROW_LIMIT).map((p) => {
        const key = tableKey(p.ref);
        const moved = b.overrides[key] !== undefined;
        const why =
          p.action === 'scoped' && p.via.length > 1
            ? `through ${p.via.slice(0, -1).map((v) => v.table).join(' → ')}`
            : p.reason;
        return (
          <div key={key} className={`${cols} group px-4 py-2 even:bg-[var(--c-row-alt)] hover:bg-wash-strong`}>
            <span className="min-w-0 truncate" title={key}>
              <span className="font-mono text-[11px] text-ink-muted">{p.ref.schema}.</span>
              <span className="font-mono text-[12px]">{p.ref.table}</span>
              {showBucket && (
                <span className="block text-[11px] text-ink-muted">
                  {MOVES.find((m) => m.action === p.action)?.label(who) ?? 'No rows copied'}
                </span>
              )}
            </span>
            <span className="min-w-0 truncate text-ink-muted" title={p.via.map((v) => `${v.column} → ${v.table}`).join(', ') || why}>
              {moved ? <span className="text-accent-strong">moved by you</span> : why}
            </span>
            <span className="text-right tabular-nums">
              <Copied plan={p} />
            </span>
            <span className="text-right">
              {moved ? (
                <button className="text-[11px] text-accent-strong hover:underline" onClick={() => b.overrideTable(key, null)}>Undo</button>
              ) : (
                <select
                  aria-label={`Change what happens to ${key}`}
                  className="h-6 max-w-full bg-transparent text-[11px] text-ink-muted hover:text-ink rounded-[4px] cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100"
                  value=""
                  onChange={(e) => e.target.value && b.overrideTable(key, e.target.value as TableAction)}
                >
                  <option value="">Move to…</option>
                  {MOVES.filter((m) => m.action !== p.action).map((m) => (
                    <option key={m.action} value={m.action}>{m.label(who)}</option>
                  ))}
                </select>
              )}
            </span>
          </div>
        );
      })}
      {sorted.length > ROW_LIMIT && (
        <div className="px-4 py-2 text-[11px] text-ink-muted">+ {sorted.length - ROW_LIMIT} smaller tables. Find a table to see one.</div>
      )}
    </div>
  );
}

/// "~5,519 of 640,178": what is kept, against what is there today.
function Copied({ plan }: { plan: TablePlan }): JSX.Element {
  const today = count(plan.rows);
  if (plan.action === 'whole') return <><span>all</span> <span className="text-ink-muted">{today}</span></>;
  if (plan.action === 'scoped') {
    return (
      <>
        <span>{plan.keepRows === null ? 'some' : `~${count(plan.keepRows)}`}</span>
        <span className="text-ink-muted"> of {today}</span>
      </>
    );
  }
  return <><span>none</span> <span className="text-ink-muted">of {today}</span></>;
}

/// The guesses that need a person: a column that could mean more than one
/// table, where the choice decides which rows are kept. The rest are behind
/// a toggle — they are listed so they can be checked, not so they must be.
function Links(): JSX.Element {
  const b = useBaseline();
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  const off = new Set(b.linksOff);
  const named = useMemo(
    () => b.links.filter((l) => l.source !== 'fk' && !l.audit).sort((x, y) => (linkKey(x) < linkKey(y) ? -1 : 1)),
    [b.links],
  );
  // A column that could mean `app.client` or `app_dm.client` means the
  // tenant either way: nothing to decide.
  const family = useMemo(
    () => new Set(b.snapshot && b.tenant ? tenantTables(b.snapshot, b.tenant).map(tableKey) : []),
    [b.snapshot, b.tenant],
  );
  const unsure = named.filter(
    (l) => l.alternatives.length > 0 && ![l.to, ...l.alternatives].every((r) => family.has(tableKey(r))),
  );
  const base = all ? named : unsure;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? base.filter((l) => linkKey(l).toLowerCase().includes(needle)) : base;
  const LIMIT = 150;

  return (
    <div className="min-h-0 flex flex-col gap-3 px-4 py-5 bg-surface-muted/60 border-l border-card">
      <CodeCheck />
      {b.fromMap && b.fromMap.confirmed + b.fromMap.corrected + b.fromMap.added > 0 && (
        <p className="text-[11px] text-ai leading-snug">
          From the map:{' '}
          {[
            b.fromMap.confirmed && `${b.fromMap.confirmed} confirmed`,
            b.fromMap.corrected && `${b.fromMap.corrected} pointed at the table the code uses`,
            b.fromMap.added && `${b.fromMap.added} added that the names never suggested`,
          ]
            .filter(Boolean)
            .join(', ')}
          . Each cites where in the code.
        </p>
      )}
      <div>
        <div className="font-semibold">{all ? 'Every guessed link' : unsure.length > 0 ? `${unsure.length} links to check` : 'Nothing to check'}</div>
        <div className="text-ink-muted mt-0.5">
          {all
            ? `${named.length} columns overdb read as pointing at a table because of their names. Turn one off and its table stops following it.`
            : unsure.length > 0
              ? 'Each of these columns could point at more than one table. overdb picked the likeliest; turn one off if it is wrong.'
              : 'Every guessed link has only one table it could mean.'}
        </div>
      </div>
      {(all || unsure.length > 8) && (
        <input className={FIELD} placeholder="Filter by table or column" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter links" />
      )}
      <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
        {shown.slice(0, LIMIT).map((l) => <LinkRow key={linkKey(l)} link={l} on={!off.has(linkKey(l))} onToggle={() => b.toggleLink(linkKey(l))} />)}
        {shown.length > LIMIT && <li className="text-[11px] text-ink-muted px-1">+ {shown.length - LIMIT} more — filter to find one.</li>}
      </ul>
      <button className="self-start text-[12px] text-accent-strong hover:underline" onClick={() => { setAll(!all); setFilter(''); }}>
        {all ? 'Only the ones to check' : `Show all ${named.length} guessed links`}
      </button>
    </div>
  );
}

function Sparkle(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </svg>
  );
}

/// What the code says that the schema cannot: suggestions, each with its
/// reason, applied only when a person says so.
function CodeCheck(): JSX.Element {
  const b = useBaseline();
  const running = b.codeJob !== null;
  const r = b.reading;
  const pending = r ? r.links.filter((v) => !b.applied.includes(v.link)).length + r.tables.filter((t) => !b.applied.includes(t.table)).length : 0;

  return (
    <div className="rounded-md border border-ai/30 bg-ai/5 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 font-semibold text-ai"><Sparkle /> Check with the code</div>
      {!b.repo ? (
        <>
          <p className="text-ink-muted">Link the repos your services live in, and say which schemas each one’s code uses. claude reads the ones for the schemas in this base — read-only — for what the schema cannot say.</p>
          {b.connectionId && <RepoLinksPanel connectionId={b.connectionId} showRecipe onChange={() => b.reposChanged()} />}
        </>
      ) : !b.claude ? (
        <p className="text-ink-muted">Reading the code needs the claude CLI installed.</p>
      ) : running ? (
        <>
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-ink-muted max-h-[110px] overflow-hidden">
            {b.codeSteps.slice(-6).map((st, i) => <li key={i} className="truncate">{st.kind} {st.text}</li>)}
            {b.codeSteps.length === 0 && <li>Starting claude in {tildify(b.repo)}</li>}
          </ul>
          <button className={`${BTN} self-start`} onClick={() => b.stopReadCode()}>Stop</button>
        </>
      ) : r ? (
        <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto">
          {r.findings.map((f, i) => (
            <p key={i}>{f.text}{f.ref && <span className="block font-mono text-[10px] text-ink-muted">{f.ref}</span>}</p>
          ))}
          {r.links.map((v) => (
            <Suggestion key={v.link} done={b.applied.includes(v.link)} onApply={() => b.applyLink(v)}>
              <span className="font-mono text-[11px] break-all">{v.link}</span> — {v.verdict === 'off' ? 'turn off' : 'right as it is'}. <span className="text-ink-muted">{v.why}</span>
            </Suggestion>
          ))}
          {r.tables.map((t) => (
            <Suggestion key={t.table} done={b.applied.includes(t.table)} onApply={() => b.applyTable(t)}>
              <span className="font-mono text-[11px]">{t.table}</span> — {t.action === 'whole' ? 'copy whole' : t.action === 'scoped' ? 'keep its rows' : t.action === 'empty' ? 'create empty' : 'leave out'}. <span className="text-ink-muted">{t.why}</span>
            </Suggestion>
          ))}
          {r.findings.length + r.links.length + r.tables.length === 0 && <p className="text-ink-muted">The code had nothing to add.</p>}
          <div className="flex gap-2">
            {pending > 1 && <button className={BTN} onClick={() => b.applyAll()}>Apply all {pending}</button>}
            <button className={BTN} onClick={() => void b.readCode()}>Read again</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-ink-muted">
            {b.map
              ? 'The map has already settled what it could (below). Reading the code goes further: claude reads the repos for this base’s tenant, logins and tables, with Read, Grep and Glob only, and suggests changes you apply one by one.'
              : 'claude reads the repos for the schemas in this base, with Read, Grep and Glob only, and suggests changes you apply one by one. A database map settles links without reading the code each time.'}
          </p>
          {b.connectionId && <RepoNames connectionId={b.connectionId} />}
          {b.connectionId && <MapCard compact connectionId={b.connectionId} onChange={() => void b.mapChanged()} />}
          {b.codeError && <p role="alert" className="text-bad-strong">{b.codeError}</p>}
          <button className={`${BTN} self-start text-ai`} onClick={() => void b.readCode()}>Read the code</button>
        </>
      )}
    </div>
  );
}

function Suggestion({ children, done, onApply }: { children: React.ReactNode; done: boolean; onApply(): void }): JSX.Element {
  return (
    <div className="rounded-[5px] bg-surface-elevated border border-card px-2.5 py-1.5 flex items-start gap-2">
      <div className="flex-1 min-w-0 text-[11px] leading-[16px]">{children}</div>
      {done ? <span className="text-[11px] text-good shrink-0">Applied</span> : <button className={`${SMALL_BTN} shrink-0`} onClick={onApply}>Apply</button>}
    </div>
  );
}

const SMALL_BTN = 'h-6 px-2 rounded-[5px] border border-card text-[11px] text-ink hover:bg-wash-strong';

function LinkRow({ link, on, onToggle }: { link: Link; on: boolean; onToggle(): void }): JSX.Element {
  const id = `link-${linkKey(link)}`;
  return (
    <li className={`rounded-md border px-2.5 py-1.5 ${link.alternatives.length ? 'border-ai/30 bg-ai/5' : 'border-card bg-surface-elevated'}`}>
      <div className="flex items-start gap-2">
        <input id={id} type="checkbox" checked={on} onChange={onToggle} className="mt-0.5 accent-[rgb(var(--c-accent-strong))]" />
        <label htmlFor={id} className="min-w-0 text-[11px] break-all">
          <span className="font-mono">{tableKey(link.from)}.{link.columns[0]}</span>
          <span className="text-ink-muted"> points at </span>
          <span className="font-mono">{tableKey(link.to)}</span>
          {link.when && (
            <span className="text-ink-muted"> when <span className="font-mono">{link.when.column}</span> = <span className="font-mono">{link.when.value}</span></span>
          )}
        </label>
      </div>
      {link.cited && (
        <div className="ml-6 min-w-0 text-[11px] text-ai break-all">
          From the code{link.cited.why ? `: ${link.cited.why}` : ''}
          {link.cited.ref && <span className="block font-mono text-[10px] text-ink-muted">{link.cited.ref}</span>}
        </div>
      )}
      {link.alternatives.length > 0 && (
        <div className="ml-6 min-w-0 text-[11px] text-ink-muted break-all">
          or maybe {link.alternatives.slice(0, 3).map(tableKey).join(', ')}{link.alternatives.length > 3 ? '…' : ''}
        </div>
      )}
    </li>
  );
}
