import { describe, expect, it } from 'vitest';
import { classify, needsWriteAccess, splitStatements, statementAt } from './sqlGuard';

const texts = (sql: string, engine?: 'postgres' | 'mysql' | 'sqlite') =>
  splitStatements(sql, engine).map((s) => s.sql);

describe('splitStatements', () => {
  it('splits the ordinary case and drops empties', () => {
    expect(texts('select 1; select 2;')).toEqual(['select 1', 'select 2']);
    expect(texts('select 1;;\n\n; select 2')).toEqual(['select 1', 'select 2']);
    expect(texts('   ')).toEqual([]);
  });

  it('keeps a trailing statement with no terminator', () => {
    expect(texts('select 1; select 2')).toEqual(['select 1', 'select 2']);
  });

  it('ignores semicolons inside string literals', () => {
    // The whole reason this is a scanner and not sql.split(';').
    expect(texts("select ';'; select 2")).toEqual(["select ';'", 'select 2']);
    expect(texts("select 'it''s; fine'")).toEqual(["select 'it''s; fine'"]);
  });

  it('ignores semicolons inside comments', () => {
    expect(texts('select 1 -- ; not a split\n; select 2')).toEqual([
      'select 1 -- ; not a split', 'select 2',
    ]);
    expect(texts('select 1 /* ; nope */ ; select 2')).toEqual([
      'select 1 /* ; nope */', 'select 2',
    ]);
  });

  it('handles MySQL backticks, # comments and backslash escapes', () => {
    expect(texts('select `a;b` from t; select 2', 'mysql')).toEqual([
      'select `a;b` from t', 'select 2',
    ]);
    expect(texts('select 1 # ; nope\n; select 2', 'mysql')).toEqual(['select 1 # ; nope', 'select 2']);
    expect(texts("select 'a\\'; b' from t", 'mysql')).toEqual(["select 'a\\'; b' from t"]);
  });

  it('handles Postgres dollar-quoted bodies full of semicolons', () => {
    const fn = "create function f() returns int as $$ begin; return 1; end; $$ language plpgsql; select 1";
    expect(texts(fn)).toHaveLength(2);
    expect(texts(fn)[1]).toBe('select 1');
  });

  it('handles a tagged dollar quote', () => {
    expect(texts("select $tag$ a;b $tag$; select 2")).toEqual([
      'select $tag$ a;b $tag$', 'select 2',
    ]);
  });

  it('reports offsets that point back into the original text', () => {
    const sql = 'select 1;\nselect 2';
    const [, second] = splitStatements(sql);
    expect(sql.slice(second.start, second.end).trim()).toBe('select 2');
  });
});

describe('classify', () => {
  it('reads the first real keyword past comments', () => {
    expect(classify('-- a banner\n/* and a block */\nselect 1')).toBe('read');
  });

  it('separates reads, writes, DDL and transaction control', () => {
    expect(classify('select 1')).toBe('read');
    expect(classify('SHOW TABLES')).toBe('read');
    expect(classify('insert into t values (1)')).toBe('write');
    expect(classify('DELETE from t')).toBe('write');
    expect(classify('create table t (a int)')).toBe('ddl');
    expect(classify('drop table t')).toBe('ddl');
    expect(classify('commit')).toBe('txn');
  });

  it('catches a data-modifying CTE', () => {
    // Opens with `with`, mutates. The case a first-keyword check gets wrong.
    expect(classify('with d as (delete from t returning *) select * from d')).toBe('write');
    expect(classify('with x as (select 1) select * from x')).toBe('read');
  });

  it('treats SELECT ... FOR UPDATE as a write', () => {
    expect(classify('select * from t for update')).toBe('write');
    expect(classify('select * from t for share')).toBe('write');
    expect(classify('select * from t')).toBe('read');
  });

  it('is not fooled by a keyword inside a string literal', () => {
    expect(classify("select 'delete from everything' as msg")).toBe('read');
    expect(classify("select * from t where note = 'for update'")).toBe('read');
  });
});

describe('needsWriteAccess', () => {
  it('is true when any statement in the batch mutates', () => {
    expect(needsWriteAccess(splitStatements('select 1; select 2'))).toBe(false);
    expect(needsWriteAccess(splitStatements('select 1; update t set a = 1'))).toBe(true);
    expect(needsWriteAccess(splitStatements('select 1; drop table t'))).toBe(true);
  });
});

describe('statementAt', () => {
  const sql = 'select 1;\nselect 2;\nselect 3;';
  const stmts = splitStatements(sql);

  it('finds the statement the cursor sits inside', () => {
    expect(statementAt(stmts, sql.indexOf('select 2'))?.sql).toBe('select 2');
    expect(statementAt(stmts, sql.indexOf('select 3') + 3)?.sql).toBe('select 3');
  });

  it('keeps the cursor with its statement when resting on the semicolon', () => {
    expect(statementAt(stmts, sql.indexOf('select 1;') + 8)?.sql).toBe('select 1');
  });

  it('falls back to the last statement past the end', () => {
    expect(statementAt(stmts, sql.length + 20)?.sql).toBe('select 3');
  });

  it('returns nothing for an empty buffer', () => {
    expect(statementAt([], 0)).toBeUndefined();
  });
});

describe('statement offsets (regression: welded statements)', () => {
  it('starts a statement at its first real character, not after the previous semicolon', () => {
    // The bug: offsets included the whitespace between statements, so
    // replacing statement 2 consumed the newline after `;` and welded the
    // replacement onto the end of statement 1 —
    //   FROM panel_widget;-- find me all the panel widgets
    const doc = 'select * from panel_widget;\n\nfind me all the panel widgets';
    const [first, second] = splitStatements(doc, 'mysql');

    expect(doc.slice(first.start, first.end)).toBe('select * from panel_widget');
    expect(doc.slice(second.start, second.end)).toBe('find me all the panel widgets');
    // The character immediately before statement 2 must still be a newline.
    expect(doc[second.start - 1]).toBe('\n');
  });

  it('reports offsets that round-trip for every statement', () => {
    const doc = '  select 1;\n\n\n  select 2 ;  \n\nselect 3';
    for (const s of splitStatements(doc, 'mysql')) {
      expect(doc.slice(s.start, s.end)).toBe(s.sql);
    }
  });
});
