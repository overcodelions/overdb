import { describe, expect, it } from 'vitest';
import { baseIsNewer, baseOf, devInstanceRefusal, isProxyConnectionId, proxyConnectionId } from './instances';

describe('which connections a base can be made from', () => {
  it.each([
    ['local', 'mysql', null],
    ['local', 'postgres', null],
    ['sandbox', 'postgres', null],
    ['dev', 'mysql', null],
    ['sandbox', 'mysql', null],
    ['staging', 'mysql', null],
  ] as const)('%s %s is allowed', (env, engine, out) => expect(devInstanceRefusal({ env, engine })).toBe(out));

  it.each([
    ['prod', 'mysql', /Never from production/],
    ['other', 'mysql', /Tag this connection/],
    ['local', 'sqlite', /MySQL, MariaDB, Postgres and Redshift/],
    ['local', 'dynamodb', /SQL databases/],
  ] as const)('%s %s is refused', (env, engine, why) => expect(devInstanceRefusal({ env, engine })).toMatch(why));
});

describe('proxy connection ids', () => {
  it('are one per base, and the old single id still counts', () => {
    expect(proxyConnectionId('abc')).toBe('overdb-proxy:abc');
    expect(isProxyConnectionId('overdb-proxy:abc')).toBe(true);
    expect(isProxyConnectionId('overdb-proxy')).toBe(true);
    expect(isProxyConnectionId('abc')).toBe(false);
  });
});

describe('a branch and its base', () => {
  const t = { id: 't', name: 'PROJ-1', note: '', baselineId: 'b1', sourceConnectionId: 's', datadir: '', port: 0, connectionId: 'c', createdAt: '2026-10-01T00:00:00.000Z' };

  it('follows its source to the rebuilt base when its own is gone', () => {
    expect(baseOf(t, [{ id: 'b2', sourceConnectionId: 's' }])?.id).toBe('b2');
    expect(baseOf(t, [{ id: 'b1', sourceConnectionId: 's' }, { id: 'b3', sourceConnectionId: 's' }])?.id).toBe('b1');
    expect(baseOf(t, [{ id: 'b2', sourceConnectionId: 'other' }])).toBeUndefined();
  });

  it('says the base is newer once it was built after the branch took its data', () => {
    expect(baseIsNewer(t, { builtAt: '2026-10-02T00:00:00.000Z' })).toBe(true);
    expect(baseIsNewer(t, { builtAt: '2026-09-30T00:00:00.000Z' })).toBe(false);
    expect(baseIsNewer({ ...t, resetAt: '2026-10-03T00:00:00.000Z' }, { builtAt: '2026-10-02T00:00:00.000Z' })).toBe(false);
  });
});
