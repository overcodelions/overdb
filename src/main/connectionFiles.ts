// Where a connection's files are: the repos linked to it, its database map
// and its base recipe. Moved out of index.ts's registerIpc so that
// `overdb serve --mcp`, which never registers IPC, finds them the same way
// the app does.

import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { Store } from './store';
import { mapPath } from './mapper';
import type { DbMap } from '../shared/dbMap';
import { isRedshift } from '../shared/engines';
import { repoLinkOwner } from '../shared/overcliHandoff';
import { recipeHome, repoLinks, type RepoLink } from '../shared/repoLinks';

/// Every repo linked for this connection that is still on disk, with the
/// schemas each one's code uses.
export async function linkedRepoLinks(connectionId: string): Promise<RepoLink[]> {
  const st = Store.load();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return [];
  const links = repoLinks(owner, st.connections, st.envSets);
  const here = await Promise.all(links.map((l) => fs.stat(l.path).then((s) => s.isDirectory()).catch(() => false)));
  return links.filter((_, i) => here[i]);
}

export async function mapFileFor(connectionId: string): Promise<{ owner: DbMap['owner']; file: string } | null> {
  const st = Store.load();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return null;
  const file = mapPath(owner, {
    location: st.settings.mapLocation ?? 'overdb',
    userData: app.getPath('userData'),
    repo: recipeHome(await linkedRepoLinks(connectionId)),
  });
  return { owner, file };
}

/// In the linked repo, so it is reviewed with the code and a teammate
/// builds the same baseline; otherwise in overdb's own data.
export async function recipePath(connectionId: string): Promise<string> {
  const repo = recipeHome(await linkedRepoLinks(connectionId));
  if (repo) {
    // MySQL keeps the one recipe a repo always had: a local server and a
    // shared sandbox of the same app database share it, which is the
    // point. A Postgres or Redshift database in the same repo — a data
    // mart, say — is a different database and gets a file of its own.
    const conn = Store.load().connections.find((c) => c.id === connectionId);
    if (conn?.engine === 'postgres') {
      const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
      return path.join(repo, '.overdb', `baseline-${isRedshift(conn.variant) ? 'redshift' : 'postgres'}-${slug(conn.database || 'default')}.json`);
    }
    return path.join(repo, '.overdb', 'baseline.json');
  }
  return path.join(app.getPath('userData'), 'baselines', `${connectionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}
