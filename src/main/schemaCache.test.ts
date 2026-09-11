import { beforeEach, describe, expect, it } from 'vitest';
import { cachedCovers, getCached, invalidate, putCached } from './schemaCache';
import type { SchemaSnapshot } from '../shared/types';

const snap = (schemas: string[]): SchemaSnapshot => ({
  engine: 'mysql',
  serverVersion: '10.6.0-MariaDB',
  capturedAt: '',
  schemas: schemas.map((name) => ({ name, tables: [] })),
});

describe('schemaCache', () => {
  beforeEach(() => invalidate('c1'));

  it('covers a schema it was asked for', () => {
    putCached('c1', snap(['acme']), ['acme']);
    expect(cachedCovers('c1', ['acme'])).toBe(true);
    expect(cachedCovers('c1', ['acme', 'acme_cms'])).toBe(false);
  });

  it('does not cover a table it was never asked to describe', () => {
    // The bug this pins: pinning a table appeared to do nothing, because a
    // snapshot taken before the pin still satisfied the cache for five
    // minutes and the describe call was never made.
    putCached('c1', snap(['us-east-1']), ['us-east-1'], []);
    expect(cachedCovers('c1', ['us-east-1'])).toBe(true);
    expect(cachedCovers('c1', ['us-east-1'], ['LOCAL.event-log-v2'])).toBe(false);

    putCached('c1', snap(['us-east-1']), ['us-east-1'], ['LOCAL.event-log-v2']);
    expect(cachedCovers('c1', ['us-east-1'], ['LOCAL.event-log-v2'])).toBe(true);
  });

  it('treats an entry written by an older build as covering no tables', () => {
    putCached('c1', snap(['acme']), ['acme']);
    expect(cachedCovers('c1', ['acme'], ['anything'])).toBe(false);
    expect(getCached('c1')).toBeDefined();
  });
});
