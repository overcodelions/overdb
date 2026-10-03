// MySQL server instances overdb owns: the one a baseline is built in, and
// one per ticket copy. See docs/design/baselines.md.
//
// Started from the mysqld already on this machine, with `--no-defaults` so
// nothing in your my.cnf — its port, its socket, its datadir — can point an
// instance at your own server's files. Each one has its own directory, its
// own loopback port and its own socket, and is stopped when overdb quits.
// Every process is spawned with an argv, never through a shell.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface Mysqld {
  path: string;
  /// `9.2.0`.
  version: string;
}

/// Where a mysqld usually lives: Homebrew on Apple silicon and Intel, the
/// versioned formulae beside it, the official installer, and PATH.
async function candidates(): Promise<string[]> {
  const out: string[] = [];
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    const opt = path.join(prefix, 'opt');
    const names = await fs.readdir(opt).catch(() => [] as string[]);
    for (const n of names.filter((x) => /^(mysql|mariadb|percona-server)(@[\d.]+)?$/.test(x)).sort()) {
      out.push(path.join(opt, n, 'bin', 'mysqld'));
    }
  }
  out.push('/usr/local/mysql/bin/mysqld');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) out.push(path.join(dir, 'mysqld'));
  return [...new Set(out)];
}

function run(file: string, args: string[], timeoutMs = 120_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export async function mysqldVersion(file: string): Promise<string | null> {
  const r = await run(file, ['--version'], 15_000);
  return r.code === 0 ? r.out.match(/Ver\s+(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
}

/// A mysqld for a server of `serverVersion`: the same major.minor if one is
/// installed — a data directory and its DDL are happiest with their own
/// version — else the newest found.
export async function findMysqld(serverVersion: string): Promise<Mysqld | null> {
  const found: Mysqld[] = [];
  for (const file of await candidates()) {
    const ok = await fs.access(file).then(() => true).catch(() => false);
    if (!ok) continue;
    const version = await mysqldVersion(file);
    if (version && !found.some((f) => f.version === version)) found.push({ path: file, version });
  }
  if (found.length === 0) return null;
  const want = serverVersion.match(/^(\d+\.\d+)/)?.[1];
  const same = found.find((f) => want && f.version.startsWith(`${want}.`));
  if (same) return same;
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/// An empty data directory with a root account and no password, the way
/// the server makes one for a fresh install.
export async function initialize(bin: Mysqld, datadir: string): Promise<void> {
  await fs.mkdir(path.dirname(datadir), { recursive: true });
  const log = path.join(path.dirname(datadir), 'initialize.log');
  const r = await run(bin.path, ['--no-defaults', '--initialize-insecure', `--datadir=${datadir}`, `--log-error=${log}`]);
  if (r.code !== 0) {
    const tail = await fs.readFile(log, 'utf-8').catch(() => r.out);
    throw new Error(`mysqld could not create a data directory: ${lastLines(tail)}`);
  }
}

function lastLines(text: string, n = 4): string {
  return text.trim().split('\n').slice(-n).join(' ').replace(/\s+/g, ' ');
}

/// A port the kernel says is free. Racy by nature — another process could
/// take it before mysqld binds — so a failed start says which port.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Running {
  id: string;
  port: number;
  socket: string;
  proc: ChildProcess;
  datadir: string;
}

const running = new Map<string, Running>();

/// Sockets live in the temp directory: a Unix socket path is limited to
/// about 104 bytes on macOS, and Application Support paths eat most of it.
function socketFor(id: string): string {
  return path.join(os.tmpdir(), `overdb-${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}.sock`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export function runningInstance(id: string): Running | undefined {
  return running.get(id);
}

/// Start an instance on `datadir` and wait until it accepts connections.
export async function start(id: string, bin: Mysqld, datadir: string, port?: number): Promise<Running> {
  const existing = running.get(id);
  if (existing && existing.proc.exitCode === null) return existing;
  const p = port ?? (await freePort());
  const socket = socketFor(id);
  const dir = path.dirname(datadir);
  const log = path.join(dir, 'mysqld.log');
  // A socket or pid file left by an instance that was killed rather than
  // stopped makes mysqld refuse to start.
  await fs.rm(socket, { force: true });
  await fs.rm(`${socket}.lock`, { force: true });
  const proc = spawn(
    bin.path,
    [
      '--no-defaults',
      `--datadir=${datadir}`,
      `--port=${p}`,
      '--bind-address=127.0.0.1',
      `--socket=${socket}`,
      `--pid-file=${path.join(dir, 'mysqld.pid')}`,
      `--log-error=${log}`,
      '--mysqlx=OFF',
      '--disable-log-bin',
      '--innodb-buffer-pool-size=64M',
    ],
    { stdio: 'ignore', detached: false },
  );
  const inst: Running = { id, port: p, socket, proc, datadir };
  running.set(id, inst);
  proc.on('exit', () => {
    if (running.get(id) === inst) running.delete(id);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    if (await canConnect(p)) return inst;
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGKILL');
  running.delete(id);
  const tail = await fs.readFile(log, 'utf-8').catch(() => '');
  throw new Error(`mysqld did not start on port ${p}: ${lastLines(tail) || 'no log written'}`);
}

/// Stop gracefully: SIGTERM is mysqld's own shutdown, which flushes InnoDB
/// so the directory is clean to copy.
export async function stop(id: string, timeoutMs = 60_000): Promise<void> {
  const inst = running.get(id);
  if (!inst) return;
  if (inst.proc.exitCode !== null) {
    running.delete(id);
    return;
  }
  const exited = new Promise<void>((resolve) => inst.proc.once('exit', () => resolve()));
  inst.proc.kill('SIGTERM');
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
  if ((await Promise.race([exited, timer])) === 'timeout') {
    inst.proc.kill('SIGKILL');
    await exited;
  }
  running.delete(id);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...running.keys()].map((id) => stop(id)));
}

export function runningIds(): string[] {
  return [...running.keys()];
}

/// Copy a stopped data directory. On APFS `cp -c` makes a copy-on-write
/// clone — seconds and almost no disk however large; anywhere else, or if
/// that fails, a plain copy, which is fine for a baseline of megabytes.
export async function cloneDir(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (process.platform === 'darwin') {
    const r = await run('/bin/cp', ['-c', '-R', from, to], 300_000);
    if (r.code === 0) return;
    await fs.rm(to, { recursive: true, force: true });
  }
  await fs.cp(from, to, { recursive: true });
}

/// What makes a copy a different server: a fresh server UUID, and no
/// leftover pid or socket from the directory it was copied from.
export async function makeDistinct(datadir: string): Promise<void> {
  await fs.rm(path.join(datadir, 'auto.cnf'), { force: true });
  for (const name of await fs.readdir(datadir).catch(() => [] as string[])) {
    if (/\.pid$|\.sock(\.lock)?$/.test(name)) await fs.rm(path.join(datadir, name), { force: true });
  }
}

/// Bytes actually on disk. A clone shares its blocks with the baseline, so
/// this is what it would cost on its own, not what it adds.
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}
