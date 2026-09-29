import { describe, expect, it } from 'vitest';
import { followSchema } from './schemaFollow';

describe('followSchema', () => {
  const lists = {
    a: ['teams', 'billing'],
    b: ['teams', 'billing'],
    c: ['teams'],
  };

  it('moves the members that were in step, onto a schema they have', () => {
    const r = followSchema({ a: 'teams', b: 'teams' }, 'a', 'billing', lists);
    expect(r.schemas).toEqual({ a: 'billing', b: 'billing' });
    expect(r.followed).toEqual(['b']);
  });

  it('leaves a member that does not have the new schema', () => {
    const r = followSchema({ a: 'teams', c: 'teams' }, 'a', 'billing', lists);
    expect(r.schemas).toEqual({ a: 'billing', c: 'teams' });
    expect(r.followed).toEqual([]);
  });

  it('leaves a member that was deliberately on another name', () => {
    const r = followSchema({ a: 'teams', b: 'teams_v2' }, 'a', 'billing', lists);
    expect(r.schemas.b).toBe('teams_v2');
  });

  it('leaves a member whose schema list is not known', () => {
    const r = followSchema({ a: 'teams', gone: 'teams' }, 'a', 'billing', lists);
    expect(r.schemas.gone).toBe('teams');
  });
});
