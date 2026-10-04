import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DbMap } from '../shared/dbMap';
import { parseMap } from '../shared/dbMap';

// Where a database map is kept, and what git says about how far each repo
// has moved since it was mapped. Git is spawned with arguments, never a
// shell, and only ever reads.

export function mapFileName(owner: DbMap['owner']): string {
  return `${owner.kind}-${owner.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

/// In overdb's own folder by default; in the recipe repo's `.overdb/map/`
/// when the setting says so and there is one.
export function mapPath(
  owner: DbMap['owner'],
  where: { location: 'overdb' | 'repo'; userData: string; repo: string | null },
): string {
  const name = mapFileName(owner);
  return where.location === 'repo' && where.repo
    ? path.join(where.repo, '.overdb', 'map', name)
    : path.join(where.userData, 'maps', name);
}

export async function loadMap(file: string): Promise<DbMap | null> {
  const raw = await fs.readFile(file, 'utf-8').catch(() => null);
  return raw ? parseMap(raw) : null;
}

export async function saveMap(file: string, map: DbMap): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Passes finish in parallel; each write gets its own temporary file.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  // Created new, never opened if something is already there, and yours alone.
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, file);
}

function git(repo: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (b) => (out += b.toString('utf-8')));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out.trim() : null));
  });
}

/// The commit a repo is on, or null when it is not a git repo.
export function gitHead(repo: string): Promise<string | null> {
  return git(repo, ['rev-parse', 'HEAD']);
}

/// How many commits `head` is ahead of `since`, or null when git can't say
/// (a rewritten history, a commit that is gone).
export async function gitBehind(repo: string, since: string, head: string): Promise<number | null> {
  const n = await git(repo, ['rev-list', '--count', `${since}..${head}`]);
  return n !== null && /^\d+$/.test(n) ? Number(n) : null;
}

/// Files changed between two commits, relative to the repo.
export async function gitChanged(repo: string, since: string, head: string): Promise<string[] | null> {
  const out = await git(repo, ['diff', '--name-only', `${since}..${head}`], 30_000);
  return out === null ? null : out.split('\n').filter(Boolean);
}
