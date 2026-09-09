import { describe, expect, it } from 'vitest';
import { looksLikeQuestion, looksLikeSql } from './looksLikeSql';

describe('looksLikeSql', () => {
  it('recognises statements across dialects', () => {
    for (const sql of [
      'select 1',
      'SELECT * FROM t',
      'with x as (select 1) select * from x',
      'insert into t values (1)',
      'show tables',
      'explain select 1',
      'pragma table_info(t)',
      '  \n  update t set a = 1',
    ]) {
      expect(looksLikeSql(sql), sql).toBe(true);
    }
  });

  it('sees past leading comments', () => {
    // A banner comment above a query must not make it look like prose.
    expect(looksLikeSql('-- a note\nselect 1')).toBe(true);
    expect(looksLikeSql('/* block */ select 1')).toBe(true);
    expect(looksLikeSql('# mysql comment\nselect 1')).toBe(true);
  });

  it('accepts a parenthesised select', () => {
    expect(looksLikeSql('(select 1) union (select 2)')).toBe(true);
  });

  it('treats empty input as SQL, so nothing is translated', () => {
    expect(looksLikeSql('   ')).toBe(true);
  });

  it('recognises plain English as not SQL', () => {
    expect(looksLikeSql('give me all the panel widgets for client hp')).toBe(false);
    expect(looksLikeSql('how many orders were placed last week?')).toBe(false);
  });
});

describe('looksLikeQuestion', () => {
  it('is true for a real request', () => {
    expect(looksLikeQuestion('give me all the panel widgets for client hp')).toBe(true);
  });

  it('is false for anything that is already SQL', () => {
    // The asymmetry that matters: rewriting a query the user already wrote
    // correctly is far worse than letting prose hit a syntax error, which
    // the error panel already offers to fix.
    expect(looksLikeQuestion('select * from panel_widget')).toBe(false);
  });

  it('ignores a stray word or half-typed identifier', () => {
    expect(looksLikeQuestion('panel_widget')).toBe(false);
    expect(looksLikeQuestion('panel widget')).toBe(false);
  });
});
