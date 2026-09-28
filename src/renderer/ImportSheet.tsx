import { useEffect, useRef, useState } from 'react';
import type { Connection, EnvKind, SslMode } from '@shared/types';
import { VARIANTS, type Variant } from '@shared/engines';
import { middleTruncate } from '@shared/truncate';
import { useStore } from './store';
import { TAG_TEXT } from './engineTags';

type Candidate = {
  sourceId: string; name: string; origin: string;
  engine: 'postgres' | 'mysql' | 'sqlite' | null; driver: string; env: EnvKind;
  group?: string; host?: string; port?: number; database?: string;
  user?: string; hasPassword?: boolean; ssl?: SslMode; note?: string;
};
type Source = { id: string; label: string; detail: string; candidates: Candidate[] };

/// Retyping twenty connections is the reason people abandon a new client
/// before they have tried it. Everything here is read-only against the other
/// tool's files, and nothing is created until you pick it.
export function ImportSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const importConnections = useStore((s) => s.importConnections);
  const existing = useStore((s) => s.connections);

  const [sources, setSources] = useState<Source[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [root, setRoot] = useState<string>();
  const [busy, setBusy] = useState(false);

  const scan = async (projectRoot?: string) => {
    const result = await window.overdb.invoke('import:scan', projectRoot);
    setSources(result.sources as Source[]);
    // Pre-select what we can actually connect to and don't already have.
    const auto = new Set<string>();
    for (const source of result.sources) {
      for (const c of source.candidates) {
        if (c.engine && !alreadyHave(existing, c as Candidate)) auto.add(c.sourceId);
      }
    }
    setPicked(auto);
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFolder = async () => {
    const folder = await window.overdb.invoke('app:pickFolder');
    if (folder) {
      setRoot(folder);
      await scan(folder);
    }
  };

  const apply = async () => {
    if (!sources) return;
    setBusy(true);
    try {
      const items = sources
        .flatMap((s) => s.candidates)
        .filter((c) => picked.has(c.sourceId) && c.engine)
        .map((c) => ({
          name: c.name,
          engine: c.engine!,
          env: c.env,
          host: c.host,
          port: c.port,
          database: c.database,
          user: c.user,
          ssl: c.ssl,
          // secretSource is derived in store.ts from whether import:commit
          // actually finds and stores a password for this sourceId — not
          // from hasPassword here, which could disagree if a re-scan
          // cleared the main-side scanned map between pick and apply.
          sourceId: c.sourceId,
        }));
      await importConnections(items);
      setSheet(null);
    } finally {
      setBusy(false);
    }
  };

  const total = sources?.reduce((n, s) => n + s.candidates.length, 0) ?? 0;

  const [query, setQuery] = useState('');
  const [envFilter, setEnvFilter] = useState<EnvKind | 'all'>('all');
  const q = query.trim().toLowerCase();
  const visible = (c: Candidate) =>
    (envFilter === 'all' || c.env === envFilter) &&
    (!q || [c.name, c.host, c.database, c.user].some((v) => v?.toLowerCase().includes(q)));

  const envCounts = new Map<EnvKind, number>();
  for (const c of sources?.flatMap((s) => s.candidates) ?? []) {
    envCounts.set(c.env, (envCounts.get(c.env) ?? 0) + 1);
  }
  const envs = ENV_ORDER.filter((e) => envCounts.has(e));
  const shown = sources?.map((s) => ({ ...s, rows: s.candidates.filter(visible) })) ?? [];
  const anyShown = shown.some((s) => s.rows.length > 0);

  const setMany = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const found = sources
    ? total === 0
      ? 'Nothing found on this machine yet.'
      : `Found ${plural(total, 'connection')} in ${listOf(sources.filter((s) => s.candidates.length).map((s) => s.label))}.`
    : 'Looking in your IDE and DBeaver configs, ~/.pgpass and this app’s environment…';

  // Header and footer stay put while the list scrolls between them, so
  // Import is reachable however many candidates a machine turns up.
  return (
    <div className="flex flex-col min-h-0">
      <div className="shrink-0 px-6 pt-5 pb-3.5 border-b border-card flex flex-col gap-3.5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Import connections</h2>
            <p className="mt-1 text-xs text-ink-muted leading-snug">
              {found} Nothing there is changed, and nothing is added until you tick it.
            </p>
          </div>
          <button onClick={() => setSheet(null)} aria-label="Close" title="Close (Esc)"
                  className="shrink-0 -mr-1.5 w-7 h-7 flex items-center justify-center rounded-[5px] text-ink-muted hover:text-ink hover:bg-card">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                 strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Filtering is for finding, not choosing: a hidden row keeps its
            tick, and the button's count is always everything ticked. */}
        {total > 6 && (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-52">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   strokeWidth="1.6" strokeLinecap="round" aria-hidden
                   className="pointer-events-none absolute left-2.5 top-[7.5px] text-ink-faint">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              <input
                aria-label="Filter connections"
                className="field w-full h-7 pl-8 pr-2.5 text-xs"
                placeholder="Filter by name or host"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
            <Chip on={envFilter === 'all'} onClick={() => setEnvFilter('all')} label="All" count={total} />
            {envs.map((e) => (
              <Chip key={e} on={envFilter === e} onClick={() => setEnvFilter(envFilter === e ? 'all' : e)}
                    label={e} count={envCounts.get(e)!} warn={e === 'prod'} />
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-3.5 pb-4 flex flex-col gap-4">
        {sources === null ? (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="animate-spin">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
              <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Scanning…
          </p>
        ) : total === 0 ? (
          <p className="text-xs text-ink-muted leading-relaxed">
            overdb looks at JetBrains IDE and DBeaver configs, <span className="font-mono">~/.pgpass</span>,
            and connection URLs in its own environment. If your projects keep their own{' '}
            <span className="font-mono">.idea</span> folders, scan the folder they live in.
          </p>
        ) : !anyShown ? (
          <p className="text-xs text-ink-muted">
            Nothing matches.{' '}
            <button className="text-accent hover:underline" onClick={() => { setQuery(''); setEnvFilter('all'); }}>
              Clear the filter
            </button>
          </p>
        ) : (
          shown.filter((s) => s.rows.length > 0).map((source) => {
            const pickable = source.candidates.filter((c) => c.engine).map((c) => c.sourceId);
            const pickableShown = source.rows.filter((c) => c.engine).map((c) => c.sourceId);
            const count = pickable.filter((id) => picked.has(id)).length;
            const onShown = pickableShown.filter((id) => picked.has(id)).length;
            return (
              <section key={source.id} className="rounded-lg border border-card overflow-hidden">
                <div className="px-3.5 py-2.5 bg-wash flex flex-col gap-0.5">
                  <div className="flex items-center gap-3">
                    <TriCheckbox
                      label={`Select every connection from ${source.label}`}
                      checked={pickableShown.length > 0 && onShown === pickableShown.length}
                      mixed={onShown > 0 && onShown < pickableShown.length}
                      disabled={pickableShown.length === 0}
                      onChange={(on) => setMany(pickableShown, on)}
                    />
                    <span className="text-[12.5px] font-semibold text-ink">{source.label}</span>
                    <span className="text-[11.5px] text-ink-muted">
                      {count} of {pickable.length} selected
                    </span>
                  </div>
                  {source.detail && (
                    <p className="pl-[26px] text-[11px] text-ink-muted leading-snug">{source.detail}</p>
                  )}
                </div>

                <ul>
                  {source.rows.map((c) => (
                    <Row
                      key={c.sourceId}
                      c={c}
                      have={alreadyHave(existing, c)}
                      checked={picked.has(c.sourceId)}
                      onChange={(on) => setMany([c.sourceId], on)}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-card bg-surface-muted/60 px-6 py-3 flex items-center gap-2.5">
        <button
          onClick={() => void chooseFolder()}
          className="h-[30px] px-2 -ml-2 rounded-[5px] text-[12.5px] text-ink-muted hover:text-ink hover:bg-card inline-flex items-center gap-1.5 min-w-0"
          title={root ?? 'Also scan a folder for project .idea configs'}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               strokeWidth="1.4" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M1.5 4.5v8h13v-7H8L6.5 3.5h-5z" />
          </svg>
          <span className="truncate">
            {root ? `Also scanning ${root.split('/').pop()}` : 'Scan a projects folder…'}
          </span>
        </button>
        <div className="flex-1" />
        {picked.size > 0 && (
          <span className="shrink-0 text-[11.5px] text-ink-muted">Imports open read-only</span>
        )}
        <button
          onClick={() => setSheet(null)}
          className="shrink-0 h-[30px] px-3 rounded-[5px] border border-card bg-card hover:bg-wash-strong text-[12.5px] text-ink"
        >
          Cancel
        </button>
        {/* accent-strong: white on the dark accent is under 4.5:1. */}
        <button
          onClick={() => void apply()}
          disabled={busy || picked.size === 0}
          className="shrink-0 h-[30px] px-3 rounded-[5px] bg-accent-strong hover:bg-accent-strong/90 text-white text-[12.5px] font-medium disabled:opacity-40"
        >
          {busy ? 'Importing…' : picked.size === 0 ? 'Import' : `Import ${plural(picked.size, 'connection')}`}
        </button>
      </div>
    </div>
  );
}

const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/// The badge the sidebar will show once it is imported, so the list reads
/// the same before and after. Redshift arrives as Postgres (same wire
/// protocol) but is worth telling apart at a glance.
function tagFor(c: Candidate): { text: string; className: string } {
  if (!c.engine) return { text: c.driver.toUpperCase(), className: 'text-ink-faint' };
  const variant: Variant = /redshift/i.test(c.driver) || /redshift\.amazonaws\.com$/i.test(c.host ?? '')
    ? 'redshift'
    : c.engine;
  return { text: VARIANTS[variant].tag.toUpperCase(), className: TAG_TEXT[variant] };
}

function Row({
  c,
  have,
  checked,
  onChange,
}: {
  c: Candidate;
  have: boolean;
  checked: boolean;
  onChange(on: boolean): void;
}): JSX.Element {
  const disabled = !c.engine;
  const tag = tagFor(c);
  const where = [
    c.host ? `${c.host}${c.port ? `:${c.port}` : ''}${c.database ? `/${c.database}` : ''}` : c.database,
    c.user,
  ].filter(Boolean).join(' · ');
  return (
    <li className="border-t border-rule">
      <label
        className={`grid grid-cols-[14px_64px_minmax(0,1fr)] gap-x-3 items-start px-3.5 py-2 ${
          disabled ? 'opacity-50' : `cursor-pointer hover:bg-wash ${have && !checked ? 'opacity-60' : ''}`
        }`}
        title={disabled ? `overdb has no driver for ${c.driver}` : undefined}
      >
        <input
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-[3px] w-3.5 h-3.5 accent-[rgb(var(--c-accent-strong))]"
        />
        <span className={`pt-[3px] truncate text-[9.5px] font-semibold tracking-[0.04em] ${tag.className}`}>
          {tag.text}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="truncate text-[12.5px] text-ink">{c.name}</span>
            <span className={`shrink-0 text-[10px] font-medium px-1.5 rounded-full border ${
              c.env === 'prod'
                ? 'border-warn/40 bg-warn/10 text-warn'
                : 'border-card text-ink-muted'
            }`}>
              {c.env}
            </span>
            {have && (
              <span className="shrink-0 flex items-center gap-1 text-[11px] text-ink-muted"
                    title="The same engine, host, port and database is already in your list">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
                Already in overdb
              </span>
            )}
          </span>
          {where && (
            <span className="block mt-0.5 font-mono text-[11px] text-ink-muted whitespace-nowrap" title={where}>
              {middleTruncate(where, 70)}
            </span>
          )}
          {c.note && (
            <span className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-muted leading-snug">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   strokeWidth="1.5" strokeLinecap="round" aria-hidden className="shrink-0 mt-px">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7.2v4M8 4.8v.01" />
              </svg>
              {c.note}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

/// A group checkbox that can say "some of these": a plain checkbox has no
/// markup for mixed, only the DOM property.
function TriCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange(on: boolean): void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      aria-checked={mixed ? 'mixed' : checked}
      checked={checked}
      disabled={disabled}
      // Mixed goes to all, the way Finder and Mail do it.
      onChange={() => onChange(mixed || !checked)}
      className="w-3.5 h-3.5 accent-[rgb(var(--c-accent-strong))]"
    />
  );
}

function Chip({
  on,
  onClick,
  label,
  count,
  warn,
}: {
  on: boolean;
  onClick(): void;
  label: string;
  count: number;
  warn?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`h-[26px] px-2.5 rounded-full border text-xs inline-flex items-center gap-1.5 ${
        on
          ? 'border-ink/20 bg-wash-strong text-ink'
          : warn
            ? 'border-warn/30 text-warn hover:bg-wash'
            : 'border-card text-ink-muted hover:text-ink hover:bg-wash'
      }`}
    >
      {label}
      <span className={on ? 'text-ink-muted' : 'text-ink-faint'}>{count}</span>
    </button>
  );
}

/// Same engine, host, port and database — the identity that matters for a
/// connection, regardless of what either tool called it.
function alreadyHave(connections: Connection[], c: Candidate): boolean {
  return connections.some(
    (existing) =>
      existing.engine === c.engine &&
      (existing.host ?? '') === (c.host ?? '') &&
      (existing.port ?? 0) === (c.port ?? 0) &&
      (existing.database ?? '') === (c.database ?? ''),
  );
}
