// Whether a connection may be seeded.
//
// Seeding is the one flow in overdb where a model's SQL is the whole point
// of the exercise, so it is fenced to the one place that is safe to get
// wrong: a database on this machine that you already treat as scratch.
//
// Four checks, and all four must pass. Each one catches a mistake the others
// cannot:
//
//   * TAGGED LOCAL — the user's own statement of what this is.
//   * WRITES ON — the user already decided this connection may change.
//   * ON THIS MACHINE — the tag can be wrong, and `localhost` is not proof:
//     an SSH tunnel, `kubectl port-forward` and a cloud SQL proxy all show
//     up as a loopback port with a real server behind it. The tunnels overdb
//     drives itself are known and refused here.
//     So for a loopback port, main asks the OS which process is listening
//     on it (src/main/portOwner.ts). A database server or Docker means a
//     server on this machine; ssh, kubectl or a cloud SQL proxy means a
//     forward, and is refused.
//   * DEV-SIZED — the backstop for when the listener cannot be seen (a
//     server running as another user, an OS without lsof). A 48-million-row
//     table does not look like anybody's laptop. Not asked when the
//     listener is a known server, a SQLite file or a unix socket: those are
//     on this machine by construction, and a local copy of production data
//     is exactly what a real dev database often is.
//
// There is no override. A wrong tag is precisely the accident this exists
// to catch, and a button that says "seed it anyway" would be pressed on the
// day the tag is wrong.
//
// Main runs `connectionChecks` again on every statement the seed flow sends
// (see `query:run` with origin 'seed'), so a renderer that skipped this
// module still meets the same answer.

import type { Connection } from './types';

/// The largest table a seedable database may hold. Generous — a local copy
/// of a real schema with a realistic seed can reach six figures — and still
/// two orders of magnitude under any production table worth protecting.
export const SEED_MAX_ROWS = 1_000_000;

export interface TableCount {
  schema: string;
  table: string;
  /// The server's own estimate where it keeps one (MySQL's TABLE_ROWS,
  /// Postgres's reltuples), else a bounded count: a count that reached the
  /// cap is reported AS the cap with `capped` set, "at least this many".
  rows: number;
  capped: boolean;
  /// An estimate rather than a count. Right to within a factor, which is
  /// all a size backstop needs: 48 million is unmistakable either way.
  approx?: boolean;
}

/// What owns a loopback port: a database server (or Docker) on this
/// machine, a forward to somewhere else, or something unrecognised.
export type ListenerKind = 'server' | 'forward' | 'unknown';

export interface Listener {
  /// The process name, as the OS reports it.
  process: string;
  kind: ListenerKind;
}

export interface SeedFacts {
  tables: TableCount[];
  /// Who is listening on the connection's port. Null when it could not be
  /// seen or does not apply (SQLite, a socket).
  listener?: Listener | null;
}

/// Servers, and the container runtimes that publish a local container's
/// port. A container is on this machine, whatever is inside it.
const SERVERS =
  /^(mysqld|mariadbd|mysqld_safe|mariadbd-safe|postgres|postmaster|cockroach|tidb-server|dolt|com\.docker\..+|docker-proxy|dockerd|vpnkit.*|orbstack.*|limactl|colima|lima.*|gvproxy|podman.*|qemu.*|rancher.*|containerd.*)$/i;

/// Things that forward a local port to a server somewhere else.
const FORWARDS =
  /^(ssh|autossh|kubectl|oc|cloud[-_]sql[-_]proxy.*|cloudsql.*|alloydb.*|session-manager-plugin|ssm.*|socat|stunnel.*|ngrok|tsh|teleport|boundary|cloudflared|sshuttle|gcloud|aws|az|pscale|flyctl|fly|heroku|railway|doctl)$/i;

export function classifyListener(process: string): ListenerKind {
  const name = process.trim().split('/').pop() ?? '';
  if (FORWARDS.test(name)) return 'forward';
  if (SERVERS.test(name)) return 'server';
  return 'unknown';
}

/// Whether the connection is on this machine by construction — a file, or
/// a unix socket — so that nothing about its size is evidence either way.
function localByConstruction(conn: Connection): boolean {
  return conn.engine === 'sqlite' || !!conn.host?.startsWith('/');
}

export type GateCheckId = 'engine' | 'env' | 'writes' | 'machine' | 'size';

export interface GateCheck {
  id: GateCheckId;
  /// null while the facts it needs are still being read.
  ok: boolean | null;
  label: string;
  detail?: string;
}

export interface SeedGate {
  ok: boolean;
  checks: GateCheck[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopback(host: string | undefined): boolean {
  if (!host) return true;
  const h = host.trim().toLowerCase();
  // A unix socket path is on this machine by definition.
  if (h.startsWith('/')) return true;
  return LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function onThisMachine(conn: Connection, listener?: Listener | null): GateCheck {
  const base = { id: 'machine' as const, label: 'On this machine' };
  if (conn.engine === 'sqlite') {
    return { ...base, ok: !!conn.file, detail: conn.file ? 'A SQLite file, no tunnel or proxy' : 'No file set' };
  }
  if (conn.tunnel) {
    const port = conn.port ? `:${conn.port}` : '';
    return {
      ...base,
      ok: false,
      label: 'Goes through an SSH tunnel',
      detail: `${conn.host ?? 'localhost'}${port} → ${conn.tunnel.target} → ${conn.tunnel.remoteHost ?? conn.host ?? 'the database'}`,
    };
  }
  if (!isLoopback(conn.host)) {
    return { ...base, ok: false, label: 'Not on this machine', detail: `The host is ${conn.host}` };
  }
  const where = conn.host?.startsWith('/') ? 'a unix socket' : `${conn.host ?? 'localhost'}${conn.port ? `:${conn.port}` : ''}`;
  if (listener?.kind === 'forward') {
    return { ...base, ok: false, label: 'Port-forwarded, not a local server', detail: `${listener.process} is listening on ${where}` };
  }
  if (listener?.kind === 'server') {
    return { ...base, ok: true, detail: `${listener.process} is listening on ${where}` };
  }
  return { ...base, ok: true, detail: `Connected directly on ${where}` };
}

/// The checks that need only the saved connection. Main repeats these on
/// every seed statement, where no facts are at hand.
export function connectionChecks(conn: Connection): GateCheck[] {
  const checks: GateCheck[] = [];
  if (conn.engine === 'dynamodb') {
    checks.push({
      id: 'engine', ok: false, label: 'DynamoDB can’t be seeded yet',
      detail: 'Seeding writes SQL INSERTs; PostgreSQL, MySQL and SQLite are supported.',
    });
  }
  checks.push({
    id: 'env',
    ok: conn.env === 'local',
    label: conn.env === 'local' ? 'Tagged local' : `Tagged ${conn.env}, not local`,
  });
  checks.push({
    id: 'writes',
    ok: !!conn.writesEnabled,
    label: conn.writesEnabled ? 'Writes already on for this connection' : 'Writes are off for this connection',
    detail: conn.writesEnabled ? undefined : 'Turn writes on from the editor toolbar first.',
  });
  checks.push(onThisMachine(conn));
  return checks;
}

/// Why a statement from the seed flow must not run on this connection, or
/// null when it may. Only the connection checks — size needs a round trip
/// and was already passed to get this far.
export function seedRefusal(conn: Connection | undefined): string | null {
  if (!conn) return 'No such connection.';
  const failed = connectionChecks(conn).find((c) => c.ok === false);
  return failed ? `Seeding refused: ${failed.label.toLowerCase()}.` : null;
}

function sizeCheck(facts: SeedFacts | null): GateCheck {
  const base = { id: 'size' as const, label: 'Dev-sized' };
  if (!facts) return { ...base, ok: null, detail: 'Checking this connection…' };
  const largest = [...facts.tables].sort((a, b) => b.rows - a.rows)[0];
  const n = facts.tables.length;
  const tables = `${n} table${n === 1 ? '' : 's'}`;
  if (!largest) return { ...base, ok: true, detail: 'No tables yet' };
  const big = largest.capped || largest.rows > SEED_MAX_ROWS;
  const rows = `${largest.capped ? 'at least ' : largest.approx ? 'about ' : ''}${largest.rows.toLocaleString('en-US')} row${largest.rows === 1 ? '' : 's'}`;
  return big
    ? { ...base, ok: false, label: 'Not dev-sized', detail: `${tables} · ${largest.table} has ${rows}` }
    : { ...base, ok: true, detail: `${tables}, largest has ${rows}` };
}

export function seedGate(conn: Connection, facts: SeedFacts | null): SeedGate {
  const checks = connectionChecks(conn);
  const machine = checks.findIndex((c) => c.id === 'machine');
  if (machine >= 0 && checks[machine].ok) checks[machine] = onThisMachine(conn, facts?.listener);
  // Size is only evidence when nothing better is: a known server, a file or
  // a socket is on this machine however much data it holds.
  const sizeMatters = !localByConstruction(conn) && facts?.listener?.kind !== 'server';
  if (sizeMatters) checks.push(sizeCheck(facts));
  return { ok: checks.every((c) => c.ok === true), checks };
}

/// Whether the gate needs the rows counted at all. The counts still go to
/// the prompt either way; this only decides whether a big table may stop
/// the counting early.
export function sizeGates(conn: Connection, listener: Listener | null): boolean {
  return !localByConstruction(conn) && listener?.kind !== 'server';
}
