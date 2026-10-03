import { useEffect, useState } from 'react';
import { repoLinkOwner } from '@shared/overcliHandoff';
import { appSchemas, repoLinks, type RepoLink } from '@shared/repoLinks';
import { useStore } from './store';

// The repos whose code uses a database, and which schemas each one's code
// uses. Kept on the env set (or the connection, when it is in no set), so
// linking once covers every environment and every branch. Changes save as
// they are made.

function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

/// Pick a folder, link it, and ask the repo which schemas it uses. Returns
/// the path linked, or null if none was picked.
export async function addRepo(connectionId: string): Promise<string | null> {
  const st = useStore.getState();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return null;
  const picked = await window.overdb.invoke('overcli:pickRepo', { name: owner.name });
  if (!picked) return null;
  await st.editRepoLinks(owner, (cur) => ({ ...cur, repoPaths: cur.repoPaths.includes(picked) ? cur.repoPaths : [...cur.repoPaths, picked] }));
  const probe = st.connections.find((c) => c.id === connectionId)?.branchOf ?? connectionId;
  const res = await window.overdb.invoke('repo:suggestSchemas', { connectionId: probe, path: picked });
  if (res.ok && res.suggested.length) {
    await useStore.getState().editRepoLinks(owner, (cur) => ({ ...cur, repoSchemas: { ...cur.repoSchemas, [picked]: res.suggested } }));
    st.toast(`Linked ${baseName(picked)} — its code looks like it uses ${res.suggested.join(', ')}. Change it below if not.`);
  } else {
    st.toast(`Linked ${baseName(picked)}. Choose which schemas its code uses.`);
  }
  return picked;
}

export function RepoLinksPanel({
  connectionId,
  showRecipe = false,
  onChange,
}: {
  connectionId: string;
  /// Show which repo a base recipe is saved in.
  showRecipe?: boolean;
  onChange?(): void;
}): JSX.Element | null {
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const editRepoLinks = useStore((s) => s.editRepoLinks);
  const loadSchemaList = useStore((s) => s.loadSchemaList);
  const probe = connections.find((c) => c.id === connectionId)?.branchOf ?? connectionId;
  const listed = useStore((s) => s.schemaList[probe]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!listed) void loadSchemaList(probe);
  }, [probe, listed, loadSchemaList]);

  const owner = repoLinkOwner(connectionId, connections, envSets);
  if (!owner) return null;
  const links = repoLinks(owner, connections, envSets);
  const all = appSchemas(listed ?? []);

  const setSchemas = async (path: string, schemas: string[]) => {
    await editRepoLinks(owner, (cur) => {
      const next = { ...cur.repoSchemas };
      if (schemas.length) next[path] = schemas;
      else delete next[path];
      return { ...cur, repoSchemas: next };
    });
    onChange?.();
  };
  const remove = async (path: string) => {
    await editRepoLinks(owner, (cur) => ({ ...cur, repoPaths: cur.repoPaths.filter((p) => p !== path) }));
    onChange?.();
  };
  const makeHome = async (path: string) => {
    await editRepoLinks(owner, (cur) => ({ ...cur, recipeRepo: path }));
    onChange?.();
  };
  const suggest = async (path: string) => {
    setBusy(path);
    const res = await window.overdb.invoke('repo:suggestSchemas', { connectionId: probe, path });
    setBusy(null);
    if (!res.ok) return useStore.getState().toast(res.error, 'error');
    if (res.suggested.length === 0) return useStore.getState().toast(`Nothing in ${baseName(path)} names a schema clearly. Choose them by hand.`);
    await setSchemas(path, res.suggested);
  };
  const add = async () => {
    setBusy('new');
    const picked = await addRepo(connectionId);
    setBusy(null);
    if (picked) onChange?.();
  };

  return (
    <div className="flex flex-col gap-1.5 text-[12px]">
      {links.map((l: RepoLink) => {
        const free = all.filter((s) => !l.schemas?.includes(s));
        return (
          <div key={l.path} className="rounded-md border border-card px-2.5 py-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold truncate" title={l.path}>{baseName(l.path)}</span>
              <span className="text-[10.5px] text-ink-faint font-mono truncate flex-1 min-w-0" title={l.path}>{tildify(l.path)}</span>
              {showRecipe && links.length > 1 && (
                <label className="shrink-0 flex items-center gap-1 text-[10.5px] text-ink-muted" title="The base recipe is saved in this repo, in .overdb/baseline.json">
                  <input type="radio" name={`home-${owner.id}`} checked={l.home} onChange={() => void makeHome(l.path)} className="accent-[rgb(var(--c-accent))]" />
                  recipe
                </label>
              )}
              <button
                onClick={() => void remove(l.path)}
                aria-label={`Unlink ${baseName(l.path)}`}
                title="Unlink this repo (the folder is untouched)"
                className="shrink-0 w-5 h-5 rounded text-ink-faint hover:text-bad hover:bg-card"
              >
                ×
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10.5px] text-ink-muted mr-0.5">Schemas</span>
              {l.schemas === null ? (
                <span className="text-[10.5px] text-ink-faint">any — not mapped</span>
              ) : (
                l.schemas.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 h-5 pl-1.5 pr-0.5 rounded bg-accent/15 font-mono text-[10.5px]">
                    {s}
                    <button aria-label={`Remove ${s}`} onClick={() => void setSchemas(l.path, l.schemas!.filter((x) => x !== s))} className="w-4 h-4 rounded text-ink-muted hover:text-ink">×</button>
                  </span>
                ))
              )}
              {free.length > 0 && (
                <select
                  aria-label={`Add a schema to ${baseName(l.path)}`}
                  value=""
                  onChange={(e) => e.target.value && void setSchemas(l.path, [...(l.schemas ?? []), e.target.value])}
                  className="field h-5 px-1 text-[10.5px]"
                >
                  <option value="">+ schema</option>
                  {free.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              <button onClick={() => void suggest(l.path)} disabled={busy === l.path} className="text-[10.5px] text-accent hover:underline disabled:opacity-50">
                {busy === l.path ? 'Looking…' : 'Suggest'}
              </button>
            </div>
          </div>
        );
      })}
      <button
        onClick={() => void add()}
        disabled={busy === 'new'}
        className="self-start h-[26px] px-2.5 rounded-md border border-card text-[11px] hover:bg-wash-strong disabled:opacity-50"
      >
        {busy === 'new' ? 'Linking…' : links.length ? 'Add another repo…' : 'Link a repo…'}
      </button>
    </div>
  );
}
