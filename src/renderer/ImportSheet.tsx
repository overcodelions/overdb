import { useEffect, useState } from 'react';
import type { Connection, EnvKind, SslMode } from '@shared/types';
import { useStore } from './store';

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

  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">Import connections</h2>
      <p className="text-[11px] text-ink-faint leading-snug mb-4">
        Read from the tools already on this machine. Nothing is modified, and nothing is
        imported until you tick it.
      </p>

      {sources === null ? (
        <p className="text-xs text-ink-muted">Scanning…</p>
      ) : total === 0 ? (
        <p className="text-xs text-ink-muted">
          Nothing found. overdb looks at JetBrains IDE and DBeaver configs, <span className="font-mono">~/.pgpass</span>,
          and connection URLs in its own environment.
        </p>
      ) : (
        sources.map((source) => (
          <div key={source.id} className="mb-4">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                {source.label}
              </span>
              <button
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    const ids = source.candidates.filter((c) => c.engine).map((c) => c.sourceId);
                    const allOn = ids.every((id) => next.has(id));
                    for (const id of ids) (allOn ? next.delete(id) : next.add(id));
                    return next;
                  })
                }
                className="text-[10px] text-accent hover:underline"
              >
                toggle all
              </button>
            </div>
            <p className="text-[10px] text-ink-faint mb-1.5">{source.detail}</p>

            <div className="rounded border border-card divide-y divide-card">
              {source.candidates.map((c) => {
                const have = alreadyHave(existing, c);
                const disabled = !c.engine;
                return (
                  <label
                    key={c.sourceId}
                    className={`flex items-start gap-2 px-2 py-1.5 ${
                      disabled ? 'opacity-50' : 'hover:bg-card cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={picked.has(c.sourceId)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(c.sourceId);
                          else next.delete(c.sourceId);
                          return next;
                        })
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-xs text-ink truncate">{c.name}</span>
                        <span
                          className={`text-[9px] uppercase tracking-wider px-1 rounded ${
                            c.env === 'prod'
                              ? 'bg-warn/10 text-warn/90 border border-warn/25'
                              : 'text-ink-faint'
                          }`}
                        >
                          {c.env}
                        </span>
                        {have && <span className="text-[9px] text-ink-faint">already added</span>}
                      </span>
                      <span className="block text-[10px] text-ink-faint font-mono truncate">
                        {c.engine ?? c.driver}
                        {c.host ? ` · ${c.host}` : ''}
                        {c.database ? `/${c.database}` : ''}
                        {c.user ? ` · ${c.user}` : ''}
                      </span>
                      {c.note && <span className="block text-[10px] text-ink-muted">{c.note}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))
      )}

      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={() => void chooseFolder()}
          className="text-[11px] text-ink-faint hover:text-accent"
          title="Also scan a folder for project .idea configs"
        >
          {root ? `scanning ${root.split('/').pop()}` : '+ also scan a projects folder'}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
        >
          Cancel
        </button>
        <button
          onClick={() => void apply()}
          disabled={busy || picked.size === 0}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          {busy ? 'Importing…' : `Import ${picked.size}`}
        </button>
      </div>
    </div>
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
