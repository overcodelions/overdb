import { describe, expect, it } from 'vitest';
import {
  looksLikeQuestion,
  looksLikeSql,
  looksLikeSqlShapedProse,
  stripTrailingSemicolons,
} from './looksLikeSql';

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

  it('is false for a selection dragged from inside a comment', () => {
    // The reported bug: selecting two finished statements by starting the
    // drag after the `--` handed the translator work the user had already
    // done. The blob opens with "find", but a line under it opens with
    // SELECT, and that settles it.
    expect(
      looksLikeQuestion(
        'find me all the clients whith more than 100 partners\nSELECT client_id\nFROM acme.partner;',
      ),
    ).toBe(false);
  });

  it('ignores a stray word or half-typed identifier', () => {
    expect(looksLikeQuestion('panel_widget')).toBe(false);
    expect(looksLikeQuestion('panel widget')).toBe(false);
  });
});

describe('looksLikeSqlShapedProse', () => {
  it('catches a sentence that opens with a keyword', () => {
    // The reported bug: this reached the server and came back as a syntax
    // error, when the only useful reading of it is a question.
    expect(
      looksLikeSqlShapedProse('select allt he panels that are for partners in north america'),
    ).toBe(true);
    expect(looksLikeSqlShapedProse('show me the panels for hp')).toBe(true);
    expect(looksLikeSqlShapedProse('update the partners that are inactive')).toBe(true);
  });

  it('leaves real statements alone', () => {
    for (const sql of [
      'select id from users order by name',
      'select distinct name from partner where active',
      'select * from directives',
      'insert into t values (1)',
      'show tables',
      'select 1',
      'select a from t', // a bare identifier is not an English word
      'delete from partner where id = 3',
    ]) {
      expect(looksLikeSqlShapedProse(sql), sql).toBe(false);
    }
  });

  it('needs a sentence, not a short statement', () => {
    expect(looksLikeSqlShapedProse('show me tables')).toBe(false);
  });

  it('backs off the moment SQL punctuation appears', () => {
    // Punctuation means someone was writing SQL, whatever the words say.
    expect(looksLikeSqlShapedProse('select count(*) that are for partners')).toBe(false);
    expect(looksLikeSqlShapedProse('select a, that, b from t')).toBe(false);
  });
});

describe('stripTrailingSemicolons', () => {
  it('drops the terminator a question picked up out of habit', () => {
    expect(stripTrailingSemicolons('how many partners are there?;')).toBe(
      'how many partners are there?',
    );
    expect(stripTrailingSemicolons('give me the panels ;;  ')).toBe('give me the panels');
  });

  it('leaves text that does not end in one', () => {
    expect(stripTrailingSemicolons('  select 1  ')).toBe('select 1');
  });
});

describe('looksLikeQuestion with a trailing semicolon', () => {
  it('still reads as a question', () => {
    expect(looksLikeQuestion('give me all the panel widgets for client hp;')).toBe(true);
    expect(
      looksLikeQuestion('select allt he panels that are for partners in north america;'),
    ).toBe(true);
  });

  it('does not turn a finished statement into one', () => {
    expect(looksLikeQuestion('select * from panel_widget;')).toBe(false);
  });
});
