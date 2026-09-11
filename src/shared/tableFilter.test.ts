import { describe, expect, it } from 'vitest';
import { filterTableNames, matchesTableFilter, parseTableFilter } from './tableFilter';

const names = [
  'LOCAL.event-log-v2',
  'LOCAL.client-cache',
  'PROD.event-log-v2',
  'STAGE.event-log-v2',
  'stream-dump-util',
];

describe('parseTableFilter', () => {
  it('treats a wildcard-free pattern as a prefix', () => {
    expect(parseTableFilter('LOCAL.')).toEqual([{ exclude: false, glob: 'local.*' }]);
  });

  it('leaves an explicit wildcard alone', () => {
    expect(parseTableFilter('*event*')).toEqual([{ exclude: false, glob: '*event*' }]);
  });

  it('reads a leading ! as an exclusion', () => {
    expect(parseTableFilter('!PROD.')).toEqual([{ exclude: true, glob: 'prod.*' }]);
  });

  it('drops a bare * rather than building a filter that filters nothing', () => {
    expect(parseTableFilter('*')).toEqual([]);
  });

  it('accepts commas and newlines', () => {
    expect(parseTableFilter('LOCAL., !PROD.\nSTAGE.')).toHaveLength(3);
  });
});

describe('matchesTableFilter', () => {
  it('keeps everything when there is no filter', () => {
    expect(filterTableNames(names, '')).toEqual(names);
    expect(filterTableNames(names, undefined)).toEqual(names);
  });

  it('narrows to a prefix', () => {
    expect(filterTableNames(names, 'LOCAL.')).toEqual(['LOCAL.event-log-v2', 'LOCAL.client-cache']);
  });

  it('is case-insensitive, so a capital letter is not a silent empty result', () => {
    expect(filterTableNames(names, 'local.')).toHaveLength(2);
  });

  it('keeps everything except an exclusion when only exclusions are given', () => {
    // "so we don't get prod tables" — the request that started this. It must
    // not require also naming everything you DO want.
    expect(filterTableNames(names, '!PROD.')).toEqual([
      'LOCAL.event-log-v2', 'LOCAL.client-cache', 'STAGE.event-log-v2', 'stream-dump-util',
    ]);
  });

  it('lets an exclusion veto an include', () => {
    expect(filterTableNames(names, '*event*, !PROD.')).toEqual([
      'LOCAL.event-log-v2', 'STAGE.event-log-v2',
    ]);
  });

  it('ORs multiple includes', () => {
    expect(filterTableNames(names, 'LOCAL., STAGE.')).toHaveLength(3);
  });

  it('does not let a dot in the pattern match any character', () => {
    // `LOCALx` must not match the pattern `LOCAL.` — a regex-unescaped dot
    // would quietly widen every prefix anyone types.
    expect(matchesTableFilter('LOCALxevent', parseTableFilter('LOCAL.'))).toBe(false);
  });

  it('matches a single character with ?', () => {
    expect(filterTableNames(['ev1', 'ev22'], 'ev?')).toEqual(['ev1']);
  });
});
