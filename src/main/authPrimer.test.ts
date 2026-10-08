import { describe, expect, it } from 'vitest';
import { AuthPrimer, scrub, type Account } from './authPrimer';
import type { Upstream } from './proxy';

const SECRET = 'hunter2-s3cret';
const ADMIN = 'root-pw-9f8e7d';
const copy: Upstream = { host: '127.0.0.1', port: 41001 };
const other: Upstream = { host: '127.0.0.1', port: 41002 };

/// A primer with a clock that moves only when told, a login that records
/// who it was and can be held open or made to fail, and a log kept.
function setup(opts: { accounts?: Account[]; fail?: (a: Account) => Error | null } = {}) {
  let t = 1_000;
  const logins: string[] = [];
  const lines: string[] = [];
  const gates: Array<() => void> = [];
  let hold = false;
  const primer = new AuthPrimer({
    accounts: async () => opts.accounts ?? [{ user: 'app', password: SECRET }],
    login: async (to, a) => {
      logins.push(`${a.user}@${to.port}`);
      if (hold) await new Promise<void>((r) => gates.push(r));
      const err = opts.fail?.(a);
      if (err) throw err;
    },
    now: () => t,
    log: (l) => lines.push(l),
    ttlMs: 60_000,
    retryMs: 5_000,
  });
  return {
    primer,
    logins,
    lines,
    advance: (ms: number) => (t += ms),
    holdLogins: (on: boolean) => (hold = on),
    releaseAll: () => gates.splice(0).forEach((g) => g()),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('auth primer', () => {
  it('logs in as every account once, then not again within the minute', async () => {
    const s = setup({ accounts: [{ user: 'app', password: SECRET }, { user: 'root', password: ADMIN }] });
    await s.primer.prime('A', copy);
    expect(s.logins).toEqual(['app@41001', 'root@41001']);
    s.advance(59_000);
    await s.primer.prime('A', copy);
    expect(s.logins).toHaveLength(2);
    // Another server is its own.
    await s.primer.prime('A', other);
    expect(s.logins).toEqual(['app@41001', 'root@41001', 'app@41002', 'root@41002']);
  });

  it('warms again once the minute is up, to catch a server restarted since', async () => {
    const s = setup();
    await s.primer.prime('A', copy);
    s.advance(60_001);
    await s.primer.prime('A', copy);
    expect(s.logins).toEqual(['app@41001', 'app@41001']);
  });

  it('makes one login for a pool connecting all at once', async () => {
    const s = setup();
    s.holdLogins(true);
    const all = Array.from({ length: 20 }, () => s.primer.prime('A', copy));
    await tick();
    expect(s.logins).toEqual(['app@41001']);
    s.releaseAll();
    await Promise.all(all);
    expect(s.logins).toEqual(['app@41001']);
  });

  it('forgets a server that restarted, so the next connection warms it', async () => {
    const s = setup();
    await s.primer.prime('A', copy);
    await s.primer.prime('A', other);
    s.primer.forget(copy);
    await s.primer.prime('A', copy);
    await s.primer.prime('A', other);
    expect(s.logins).toEqual(['app@41001', 'app@41002', 'app@41001']);
    s.primer.forget();
    await s.primer.prime('A', other);
    expect(s.logins).toEqual(['app@41001', 'app@41002', 'app@41001', 'app@41002']);
  });

  it('does not let a warming that was forgotten mid-way count as done', async () => {
    const s = setup();
    s.holdLogins(true);
    const first = s.primer.prime('A', copy);
    await tick();
    s.primer.forget(copy);
    // A new one starts rather than joining the one about a server now gone.
    const second = s.primer.prime('A', copy);
    await tick();
    expect(s.logins).toEqual(['app@41001', 'app@41001']);
    s.releaseAll();
    await Promise.all([first, second]);
    s.holdLogins(false);
    await s.primer.prime('A', copy);
    expect(s.logins).toHaveLength(2);
  });

  it('retries a failed warming after a few seconds, not at every connection', async () => {
    const s = setup({ fail: () => new Error('connect ECONNREFUSED') });
    await expect(s.primer.prime('A', copy)).resolves.toBeUndefined();
    await s.primer.prime('A', copy);
    expect(s.logins).toHaveLength(1);
    s.advance(5_001);
    await s.primer.prime('A', copy);
    expect(s.logins).toHaveLength(2);
  });

  it('keeps going past an account that fails, and never says a password', async () => {
    const s = setup({
      accounts: [{ user: 'app', password: SECRET }, { user: 'root', password: ADMIN }],
      // A driver that quotes what it was given, the worst case.
      fail: (a) => (a.user === 'app' ? new Error(`Access denied for user 'app' (password '${SECRET}', also tried ${ADMIN})`) : null),
    });
    await s.primer.prime('A', copy);
    expect(s.logins).toEqual(['app@41001', 'root@41001']);
    const said = s.lines.join('\n');
    expect(said).toMatch(/could not warm app at 127\.0\.0\.1:41001/);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(ADMIN);
  });

  it('does nothing, quietly, for a base with no accounts — Postgres, or no password kept', async () => {
    const s = setup({ accounts: [] });
    await s.primer.prime('A', copy);
    expect(s.logins).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  it('survives the accounts lookup failing', async () => {
    const lines: string[] = [];
    const primer = new AuthPrimer({
      accounts: async () => {
        throw new Error('no such base');
      },
      login: async () => undefined,
      now: () => 0,
      log: (l) => lines.push(l),
    });
    await expect(primer.prime('A', copy)).resolves.toBeUndefined();
    expect(lines.join('\n')).toMatch(/no such base/);
  });
});

describe('scrub', () => {
  it('takes every password out of a message', () => {
    expect(scrub(`a ${SECRET} b ${SECRET} c ${ADMIN}`, [{ user: 'x', password: SECRET }, { user: 'root', password: ADMIN }])).toBe('a … b … c …');
  });
});
