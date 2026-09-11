import { describe, expect, it } from 'vitest';
import type { AskTurn } from '@shared/types';
import { exchanges, filterTurns } from './askFilter';

function thread(...pairs: Array<[string, string]>): AskTurn[] {
  return pairs.flatMap(([q, a], i) => [
    { role: 'user' as const, text: q, at: 1000 + i },
    { role: 'assistant' as const, text: a, at: 1001 + i },
  ]);
}

describe('exchanges', () => {
  it('groups each answer under the question above it', () => {
    expect(exchanges(thread(['q1', 'a1'], ['q2', 'a2'])).map((ex) => ex.map((t) => t.text))).toEqual(
      [
        ['q1', 'a1'],
        ['q2', 'a2'],
      ],
    );
  });

  it('keeps every answer when a question drew more than one', () => {
    const turns: AskTurn[] = [
      { role: 'user', text: 'q', at: 1 },
      { role: 'assistant', text: 'a1', at: 2 },
      { role: 'assistant', text: 'a2', at: 3 },
    ];
    expect(exchanges(turns)).toHaveLength(1);
  });

  it('does not drop an answer that opens the thread', () => {
    const turns: AskTurn[] = [{ role: 'assistant', text: 'could not ask', failed: true, at: 1 }];
    expect(exchanges(turns).flat()).toEqual(turns);
  });
});

describe('filterTurns', () => {
  const turns = thread(['about panels', 'the panel_widget join'], ['about users', 'the user_id']);

  it('returns the thread itself when there is no filter', () => {
    expect(filterTurns(turns, '')).toBe(turns);
    expect(filterTurns(turns, '   ')).toBe(turns);
  });

  it('keeps the question when only its answer matched', () => {
    expect(filterTurns(turns, 'panel_widget').map((t) => t.text)).toEqual([
      'about panels',
      'the panel_widget join',
    ]);
  });

  it('keeps the answer when only its question matched', () => {
    expect(filterTurns(turns, 'about users').map((t) => t.text)).toEqual([
      'about users',
      'the user_id',
    ]);
  });

  it('ignores case', () => {
    expect(filterTurns(turns, 'PANEL_Widget')).toHaveLength(2);
  });

  it('searches the statement that rode along with the question', () => {
    const withSql: AskTurn[] = [
      { role: 'user', text: 'why is this slow?', sql: 'SELECT * FROM directives', at: 1 },
      { role: 'assistant', text: 'no index', at: 2 },
    ];
    expect(filterTurns(withSql, 'directives')).toHaveLength(2);
  });

  it('returns nothing when the thread does not mention it', () => {
    expect(filterTurns(turns, 'redshift')).toEqual([]);
  });
});
