import { useEffect, useMemo, useRef, useState } from 'react';
import type { DbMap, MapTable } from '@shared/dbMap';
import { Elapsed, baseName, behindText, since, useMaps } from './MapCard';
import { RepoLinksPanel } from './RepoLinks';
import { useStore } from './store';
import { repoLinkOwner } from '@shared/overcliHandoff';
import { repoLinks } from '@shared/repoLinks';

type Tab = 'tables' | 'repos' | 'activity';

/// The database map, as its own place: the repos it reads, whether it is
/// up to date, and what the code says about each table.
///
/// It used to live inside Seed, the first thing that used it. But the map is
/// a property of the database and its code — a base settles its links from
/// it, the diagram draws its links — so it is managed here, once, and the
/// sheets that use it show one line and the way back.
///
/// It fills the window like Health: a list of hundreds of tables and a
/// dozen repos is not something to read in the strip under the editor.
export function MapPane({
  connectionId,
  full,
  onToggleFull,
  onClose,
  onPickTable,
}: {
  connectionId: string;
  full: boolean;
  onToggleFull(): void;
  onClose(): void;
  /// Jump the editor at a table, as the diagram does.
  onPickTable?(schema: string, table: string): void;
}): JSX.Element {
  const m = useMaps();
  const status = m.status[connectionId];
  const job = m.jobs[connectionId];
  const error = m.error[connectionId];
  const done = m.done[connectionId];
  const mapLocation = useStore((s) => s.settings.mapLocation);
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const owner = repoLinkOwner(connectionId, connections, envSets);
  const repos = owner ? repoLinks(owner, connections, envSets) : [];

  const [map, setMap] = useState<DbMap | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  const reload = () => {
    void window.overdb
      .invoke('map:read', connectionId)
      .catch(() => null)
      .then((x) => setMap(x));
  };
  useEffect(reload, [connectionId]);
  useEffect(() => {
    void m.load(connectionId);
  }, [connectionId, mapLocation]);
  // Each part is saved as it lands: read the map again as the counter moves,
  // and once more when the run ends.
  useEffect(reload, [job?.parts?.done, Boolean(job)]);

  // Where to start: the run while there is one, the tables once there are
  // some, the repos until there are any.
  const shown: Tab = tab ?? (job ? 'activity' : map && Object.keys(map.tables).length ? 'tables' : 'repos');

  const tables = useMemo(() => {
    if (!map) return [];
    const q = query.trim().toLowerCase();
    return Object.entries(map.tables)
      .filter(([key, t]) => !q || key.includes(q) || t.purpose.toLowerCase().includes(q) || (t.module ?? '').toLowerCase().includes(q))
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [map, query]);
  const LIMIT = 300;
  // By schema: a map across several reads as one long list otherwise.
  const groups = useMemo(() => {
    const by = new Map<string, typeof tables>();
    for (const row of tables.slice(0, LIMIT)) {
      const schema = row[0].slice(0, row[0].indexOf('.'));
      by.set(schema, [...(by.get(schema) ?? []), row]);
    }
    return [...by].map(([schema, rows]) => ({ schema, rows }));
  }, [tables]);

  const fresh = status?.freshness;
  const mapped = status?.map;
  const tableCount = map ? Object.keys(map.tables).length : 0;

  return (
    <div className="h-full flex flex-col min-h-0 text-[12px]">
      <div className="shrink-0 border-b border-card px-3.5 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-ink">Map</span>
        <span className="text-[11px] text-ink-faint min-w-0 truncate">
          {owner?.name}
          {repos.length > 0 && <> · {repos.length} repo{repos.length === 1 ? '' : 's'}</>}
        </span>
        <div className="flex-1" />
        {job ? (
          <>
            <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" aria-hidden="true" />
            <span className="text-[11px] text-ink-muted tabular-nums">
              {job.refresh ? 'Refreshing' : 'Mapping'} · <Elapsed from={job.startedAt} />
              {job.parts && job.parts.total > 0 && <> · {job.parts.done} of {job.parts.total} parts</>}
            </span>
            <button className={BTN} onClick={() => m.stop(connectionId)}>Stop</button>
          </>
        ) : (
          <>
            {mapped && (
              <span className={`text-[11px] ${fresh?.fresh ? 'text-good' : 'text-warn-strong'}`}>
                {fresh?.fresh ? 'Up to date' : behindText(fresh) || 'Behind the code'} · {since(mapped.updatedAt)}
              </span>
            )}
            {mapped && !fresh?.fresh && (
              <button className={`${BTN} text-accent`} onClick={() => void m.build(connectionId, true)}>Refresh</button>
            )}
            {repos.length > 0 && (
              <button
                className={mapped ? BTN : `${BTN} bg-accent text-white border-accent hover:bg-accent-strong`}
                onClick={() => void m.build(connectionId, false)}
                title={HOW_LONG}
              >
                {mapped ? 'Map from scratch' : 'Map this database'}
              </button>
            )}
          </>
        )}
        <span className="w-px h-3.5 bg-card" />
        <button
          onClick={onToggleFull}
          title={full ? 'Dock it under the editor' : 'Fill the window'}
          className="text-[11px] px-1.5 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-card"
        >
          {full ? '⤡' : '⤢'}
          <span className="ml-1">{full ? 'Dock' : 'Expand'}</span>
        </button>
        <button
          onClick={onClose}
          title="Back to your results"
          aria-label="Close map"
          className="text-[11px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-card"
        >
          ✕
        </button>
      </div>

      {job?.parts && job.parts.total > 0 && (
        <div className="shrink-0 h-[3px] bg-card" aria-hidden="true">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${(100 * job.parts.done) / job.parts.total}%` }} />
        </div>
      )}
      {(job || error || (done && !job)) && (
        <div className="shrink-0 px-3.5 py-1.5 border-b border-card text-[11.5px] flex flex-col gap-0.5">
          {job && !job.ready && (
            <p className="text-ink-muted">
              {HOW_LONG} It keeps going if you close this, and the schema this connection uses is ready to seed first.
            </p>
          )}
          {job?.ready && <p className="text-good">{job.ready}. Seeds can use what is mapped now.</p>}
          {error && <p role="alert" className="text-bad-strong">{error}</p>}
          {done && !job && <p className="text-ink-muted">{done}</p>}
        </div>
      )}

      <div className="shrink-0 px-3.5 pt-2 flex items-center gap-1 border-b border-card" role="tablist" aria-label="Map">
        <TabButton on={shown === 'tables'} onClick={() => setTab('tables')}>
          Tables {tableCount > 0 && <span className="text-ink-faint tabular-nums">{tableCount}</span>}
        </TabButton>
        <TabButton on={shown === 'repos'} onClick={() => setTab('repos')}>
          Repos <span className="text-ink-faint tabular-nums">{repos.length}</span>
        </TabButton>
        <TabButton on={shown === 'activity'} onClick={() => setTab('activity')}>
          Activity {job && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse inline-block" />}
        </TabButton>
        <div className="flex-1" />
        {shown === 'tables' && !job && mapped && mapped.unmapped > 0 && (
          <span className="mb-1.5 text-[11px] text-ink-faint">
            {mapped.unmapped} not mapped, mostly ones no code names ·{' '}
            <button className="text-accent hover:underline" onClick={() => void m.build(connectionId, false, true)}>
              Map them too
            </button>
          </span>
        )}
        {shown === 'tables' && tableCount > 0 && (
          <input
            className="field mb-1.5 w-[300px] max-w-[45%] px-2 py-1 text-[11px]"
            placeholder="Find a table, a purpose or a module"
            aria-label="Find a table"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {shown === 'repos' ? (
          <div className="px-3.5 py-3 flex flex-col gap-3 max-w-[1400px]">
            <p className="text-[11.5px] text-ink-muted leading-snug max-w-[720px]">
              The repos whose code uses this database, and the schemas each one uses. The map, seeds and bases all read
              these. The recipe repo is where a base's recipe is saved.
            </p>
            <RepoLinksPanel connectionId={connectionId} showRecipe grid onChange={() => void m.load(connectionId)} />
          </div>
        ) : shown === 'activity' ? (
          <Activity steps={job?.steps ?? []} running={Boolean(job)} />
        ) : map === undefined ? (
          <Empty>Reading the map…</Empty>
        ) : !map || tableCount === 0 ? (
          <Empty>
            {job
              ? 'Mapping — tables appear here as each part is saved.'
              : repos.length === 0
                ? 'Link the repos whose code uses this database (Repos), then map it.'
                : `No map yet. Map this database to write down, once, what the code says about each table: its purpose, the values its columns take, the rules the code enforces and the links it makes. ${HOW_LONG}`}
          </Empty>
        ) : (
          <div className="px-2 py-2 flex flex-col gap-3">
            {groups.map((g) => (
              <section key={g.schema}>
                <h4 className="sticky top-0 z-10 bg-surface/95 backdrop-blur px-2.5 py-1.5 flex items-baseline gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                  {g.schema}
                  <span className="font-normal normal-case tracking-normal tabular-nums">{g.rows.length}</span>
                </h4>
                <ul className="flex flex-col gap-px">
                  {g.rows.map(([key, t]) => (
                    <TableRow
                      key={key}
                      name={key}
                      table={t}
                      links={map.links.filter((l) => l.from.startsWith(`${key}.`) || l.to.startsWith(`${key}.`))}
                      open={open === key}
                      onToggle={() => setOpen(open === key ? null : key)}
                      onJump={(other) => {
                        setQuery('');
                        setOpen(other);
                        requestAnimationFrame(() => document.getElementById(`map-${other}`)?.scrollIntoView({ block: 'nearest' }));
                      }}
                      onPick={onPickTable}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {tables.length > LIMIT && (
              <p className="px-2.5 text-[11px] text-ink-faint">+ {tables.length - LIMIT} more — narrow the search to find one.</p>
            )}
            {tables.length === 0 && <p className="px-2.5 py-2 text-[11px] text-ink-faint">Nothing in the map matches “{query}”.</p>}
          </div>
        )}
      </div>

      {status?.file && (
        <p className="shrink-0 border-t border-card px-3.5 py-1 text-[10px] text-ink-faint font-mono truncate" title={status.file}>
          {status.file.replace(/^\/Users\/[^/]+/, '~')}
        </p>
      )}
    </div>
  );
}

const BTN = 'text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card';

/// Said wherever a map is started or running. A first map of a large
/// database across many repos is measured in minutes, not seconds, and
/// nobody should have to guess whether it has hung.
export const HOW_LONG = 'A first map takes from a few minutes to about 20 for a large database read from many repos; a refresh is much quicker.';

function TabButton({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`-mb-px px-2.5 pb-1.5 pt-0.5 text-[11.5px] flex items-center gap-1.5 border-b-2 ${
        on ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/// Every step of the run, newest last and kept in view while it runs.
function Activity({ steps, running }: { steps: Array<{ repo: string | null; text: string }>; running: boolean }): JSX.Element {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: 'end' });
  }, [steps.length, running]);
  if (steps.length === 0) {
    return <Empty>{running ? 'Finding which files name each table…' : 'Nothing has run here yet. A map, refresh or "map them too" shows its steps here.'}</Empty>;
  }
  return (
    <ul className="px-3.5 py-2 font-mono text-[11px] leading-[18px]">
      {steps.map((st, i) => (
        <li key={i} className={`flex gap-3 ${/^(Kept|Ready)/.test(st.text) ? 'text-ink' : /^Stopped/.test(st.text) ? 'text-bad-strong' : 'text-ink-muted'}`}>
          <span className="w-[160px] shrink-0 text-ink-faint truncate">{st.repo ? baseName(st.repo) : ''}</span>
          <span className="min-w-0 break-words">{st.text}</span>
        </li>
      ))}
      <li ref={end} />
    </ul>
  );
}

function TableRow({
  name,
  table,
  links,
  open,
  onToggle,
  onJump,
  onPick,
}: {
  name: string;
  table: MapTable;
  links: DbMap['links'];
  open: boolean;
  onToggle(): void;
  /// Open another table in the list: where a link leads.
  onJump(table: string): void;
  onPick?(schema: string, table: string): void;
}): JSX.Element {
  const dot = name.indexOf('.');
  const short = name.slice(dot + 1);
  const counts: Array<[number, string]> = [
    [table.values.length, 'values'],
    [table.rules.length, table.rules.length === 1 ? 'rule' : 'rules'],
    [links.length, links.length === 1 ? 'link' : 'links'],
  ];

  return (
    <li id={`map-${name}`}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={`w-full text-left px-2.5 py-[7px] rounded-md grid items-baseline gap-x-4 [grid-template-columns:minmax(200px,clamp(200px,28%,360px))_minmax(0,1fr)_auto] ${
          open ? 'bg-card' : 'hover:bg-card/70'
        }`}
      >
        <span className="font-mono text-[11.5px] text-ink truncate" title={name}>{short}</span>
        <span className={`text-[12px] text-ink-muted leading-snug ${open ? '' : 'truncate'}`}>{table.purpose || '—'}</span>
        <span className="flex gap-1">
          {counts.map(([n, label]) =>
            n > 0 ? (
              <span key={label} className="px-1.5 rounded-full bg-wash-strong text-[10px] text-ink-faint tabular-nums whitespace-nowrap">
                {n} {label}
              </span>
            ) : null,
          )}
        </span>
      </button>
      {open && (
        <div className="mx-2.5 mt-1 mb-3 rounded-lg border border-card bg-surface-elevated/60 px-4 py-3 flex flex-col gap-4 text-[12px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
            {table.module && (
              <span>
                Code <span className="font-mono text-ink">{table.module}</span>
              </span>
            )}
            {table.repo && <span>Repo <span className="font-mono text-ink">{table.repo.split('/').pop()}</span></span>}
            <div className="flex-1" />
            {onPick && (
              <button className="text-accent hover:underline" onClick={() => onPick(name.slice(0, dot), short)}>
                Query it
              </button>
            )}
          </div>

          {table.values.length + table.json.length > 0 && (
            <Section title="What its columns hold">
              {table.values.map((v) => (
                <Fact key={`v-${v.column}`} label={v.column} cite={v.ref}>
                  <span className="flex flex-wrap gap-1">
                    {v.values.map((x) => (
                      <code key={x} className="px-1.5 rounded bg-wash-strong font-mono text-[10.5px]">{x}</code>
                    ))}
                  </span>
                </Fact>
              ))}
              {table.json.map((j) => (
                <Fact key={`j-${j.column}`} label={j.column} cite={j.ref}>
                  <code className="font-mono text-[10.5px] break-all text-ink-muted">{j.shape}</code>
                </Fact>
              ))}
            </Section>
          )}

          {table.rules.length > 0 && (
            <Section title="Rules the code enforces">
              {table.rules.map((r, i) => (
                <Fact key={`r-${i}`} label={r.learnedAt ? 'learned' : ''} cite={r.ref}>
                  {r.text}
                </Fact>
              ))}
            </Section>
          )}

          {links.length > 0 && (
            <Section title="Links">
              {links.map((l, i) => {
                const outgoing = l.from.startsWith(`${name}.`);
                const here = (outgoing ? l.from : l.to).slice(name.length + 1);
                const there = outgoing ? l.to : l.from;
                const other = there.slice(0, there.lastIndexOf('.'));
                return (
                  <Fact key={`l-${i}`} label={here} cite={l.ref}>
                    <span className="text-ink-muted">{outgoing ? '→ ' : '← '}</span>
                    <button className="font-mono text-[11px] text-accent hover:underline" onClick={() => onJump(other)} title={`Show ${other}`}>
                      {there}
                    </button>
                    {l.why && <span className="text-ink-muted"> — {l.why}</span>}
                  </Fact>
                );
              })}
            </Section>
          )}
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h5 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</h5>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Fact({ label, cite, children }: { label: string; cite?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid gap-x-4 [grid-template-columns:160px_minmax(0,1fr)]">
      <span className="font-mono text-[11px] text-ink-faint truncate pt-px" title={label}>{label}</span>
      <div className="min-w-0 leading-snug">
        {children}
        {cite && <span className="block mt-0.5 font-mono text-[10px] text-ink-faint/80 break-all select-text">{cite}</span>}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="h-full flex items-center justify-center px-10 text-center text-xs text-ink-faint leading-relaxed">{children}</div>;
}
