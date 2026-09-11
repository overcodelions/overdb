import { describe, expect, it } from 'vitest';
import { suggestionBlock } from './suggestion';

const at = new Date('2026-09-09T16:59:00');

describe('suggestionBlock', () => {
  it('puts a comment line above the statement', () => {
    const out = suggestionBlock('select 1', 'Suggested by claude', at);
    const [first, ...rest] = out.split('\n');
    expect(first.startsWith('-- ')).toBe(true);
    expect(first).toContain('Suggested by claude');
    expect(rest.join('\n')).toBe('select 1');
  });

  it('uses "-- " with a trailing space, which is what MySQL requires', () => {
    // `--select` is not a comment on MySQL; it is a parse error, and the
    // whole buffer stops running.
    expect(suggestionBlock('select 1', 'x', at)).toMatch(/^-- \S/);
  });

  it('folds a multi-line note onto the comment line', () => {
    // Otherwise the second half of the note lands BELOW the `--` and
    // becomes something the editor will happily run.
    const out = suggestionBlock('select 1', 'from claude\ndrop table t', at);
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('drop table t');
    expect(lines[1]).toBe('select 1');
  });

  it('trims the statement so the comment sits directly on it', () => {
    expect(suggestionBlock('\n\n  select 1  \n\n', 'x', at).split('\n')[1]).toBe('select 1');
  });

  it('keeps the shape of a multi-line statement', () => {
    // Only the outer whitespace goes; the indentation the formatter chose
    // is the readable part of a hundred-line rewrite.
    const sql = 'select a\nfrom t\nwhere b = 1';
    expect(suggestionBlock(`\n${sql}\n`, 'x', at).split('\n').slice(1).join('\n')).toBe(sql);
  });
});
