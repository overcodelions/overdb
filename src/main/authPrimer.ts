// Warming a MySQL server's login cache, so a service's first login through
// the proxy works.
//
// MySQL 8.4 and 9 accounts use caching_sha2_password. A login the server has
// seen since it started takes the fast path: a scramble, checked against
// what it remembers. The first login after a start is "full
// authentication", which wants the password itself — over TLS or a local
// socket, or else encrypted with the server's RSA key, which the client must
// first ask for. Connector/J with useSSL=false refuses to ask unless told
// allowPublicKeyRetrieval=true, and fails with "Public Key Retrieval is not
// allowed". Every branch copy starts empty, and so does your own server
// after a restart.
//
// The proxy cannot fix that in the stream: it forwards bytes and never reads
// them. So before it forwards, overdb logs in once itself, as each account
// it holds a password for — mysql2 asks for the key on its own — and the
// service's login that follows takes the fast path. Nothing in the service
// changes.
//
// Once per server per minute at most: a pool of fifty opening at once makes
// one login, not fifty, and a restart is caught within the minute. A start,
// a reset or a switch of target forgets what was warmed, so the next
// connection warms again.
//
// Electron-free and given everything it touches, so it can be tested with
// a clock and a login that are not real. It never logs a password; what it
// logs of a driver's error has any password taken out first.

import mysql from 'mysql2/promise';
import type { Upstream } from './proxy';

/// A login to make. Held only for the length of one warming.
export interface Account {
  user: string;
  password: string;
}

export interface PrimerDeps {
  /// The accounts to log in as for this base's proxy, at this destination —
  /// none when the base is not MySQL. Main reads them from its own secret
  /// store; they never pass through IPC.
  accounts(source: string, to: Upstream): Promise<Account[]>;
  /// One login, closed straight after.
  login(to: Upstream, account: Account): Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /// How long a warmed server is taken to stay warm.
  ttlMs?: number;
  /// How long before a warming that failed is tried again: soon, but not at
  /// every connection of a pool, each waiting on a login that will not work.
  retryMs?: number;
}

export const PRIME_TTL_MS = 60_000;
export const PRIME_RETRY_MS = 5_000;

function keyOf(to: Upstream): string {
  return `${to.host}:${to.port}`;
}

/// A driver's message with every password it might quote taken out.
export function scrub(message: string, accounts: Account[]): string {
  let out = message;
  for (const a of accounts) if (a.password) out = out.split(a.password).join('…');
  return out;
}

export class AuthPrimer {
  private readonly done = new Map<string, { at: number; ok: boolean }>();
  private readonly flying = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly ttlMs: number;
  private readonly retryMs: number;

  constructor(private readonly deps: PrimerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.warn(line));
    this.ttlMs = deps.ttlMs ?? PRIME_TTL_MS;
    this.retryMs = deps.retryMs ?? PRIME_RETRY_MS;
  }

  /// Warm this destination for this base's proxy, unless it was warmed
  /// recently or is being warmed now — then join that. Never throws: a
  /// warming that fails leaves the service's login to succeed or fail on
  /// its own, as it would have without overdb.
  prime(source: string, to: Upstream): Promise<void> {
    const key = keyOf(to);
    const seen = this.done.get(key);
    if (seen && this.now() - seen.at < (seen.ok ? this.ttlMs : this.retryMs)) return Promise.resolve();
    const already = this.flying.get(key);
    if (already) return already;
    const run: Promise<void> = this.warm(source, to).then((ok) => {
      // Forgotten while it ran — the server restarted under it, say: what it
      // learned is about a server that is gone.
      if (this.flying.get(key) !== run) return;
      this.flying.delete(key);
      this.done.set(key, { at: this.now(), ok });
    });
    this.flying.set(key, run);
    return run;
  }

  /// Forget one destination — it restarted, or was replaced — or, with
  /// none named, all of them.
  forget(to?: Upstream): void {
    if (!to) {
      this.done.clear();
      this.flying.clear();
      return;
    }
    this.done.delete(keyOf(to));
    this.flying.delete(keyOf(to));
  }

  private async warm(source: string, to: Upstream): Promise<boolean> {
    let accounts: Account[] = [];
    try {
      accounts = await this.deps.accounts(source, to);
    } catch (err) {
      this.log(`auth primer: no accounts to warm ${keyOf(to)} with: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    let ok = true;
    for (const a of accounts) {
      try {
        await this.deps.login(to, a);
      } catch (err) {
        ok = false;
        const said = err instanceof Error ? err.message : String(err);
        this.log(`auth primer: could not warm ${a.user} at ${keyOf(to)}: ${scrub(said, accounts)}`);
      }
    }
    return ok;
  }
}

/// The real login: mysql2, which asks for the server's key itself over a
/// plain connection, so the full authentication goes through and the
/// server remembers the account.
export async function mysqlLogin(to: Upstream, account: Account): Promise<void> {
  const conn = await mysql.createConnection({
    host: to.host,
    port: to.port,
    user: account.user,
    password: account.password,
    connectTimeout: 5_000,
  });
  // An error after the login — a server going away — is not this one's to report.
  conn.on('error', () => undefined);
  await conn.end().catch(() => conn.destroy());
}
