import { describe, expect, it } from 'vitest';

import { connectionPort, parseLsof } from './portOwner';

describe('parseLsof', () => {
  it('takes the command of the process holding the port', () => {
    expect(parseLsof('p64062\ncmariadbd\nf43\n')).toBe('mariadbd');
    expect(parseLsof('p1\nccloud-sql-proxy\nf9\n')).toBe('cloud-sql-proxy');
  });

  it('says nothing when lsof found nothing it may show', () => {
    expect(parseLsof('')).toBeNull();
  });
});

describe('connectionPort', () => {
  it('defaults per engine', () => {
    expect(connectionPort('mysql', undefined)).toBe(3306);
    expect(connectionPort('postgres', undefined)).toBe(5432);
    expect(connectionPort('postgres', 6543)).toBe(6543);
    expect(connectionPort('sqlite', undefined)).toBeNull();
  });
});
