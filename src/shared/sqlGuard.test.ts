import { describe, expect, it } from 'vitest';
import { affectedVerb, classify, needsWriteAccess, replaceEnd, severity, splitStatements, statementAt } from './sqlGuard';

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

describe('severity', () => {
  it('separates losing data from changing it', () => {
    // Both are writes. Only one of them can lose you something.
    expect(severity("delete from t where id = 1")).toBe('destructive');
    expect(severity('drop table t')).toBe('destructive');
    expect(severity('truncate table t')).toBe('destructive');
    expect(severity("update t set x = 1")).toBe('mutating');
    expect(severity('insert into t (a) values (1)')).toBe('mutating');
    expect(severity('alter table t add index i (a)')).toBe('mutating');
  });

  it('calls an ordinary query a read', () => {
    expect(severity('select * from t')).toBe('read');
    expect(severity('  -- a note\nSELECT 1')).toBe('read');
    expect(severity('show tables')).toBe('read');
  });

  it('reads through a data-modifying CTE to what it actually does', () => {
    expect(severity('with x as (delete from t returning *) select * from x')).toBe('destructive');
    expect(severity('with x as (insert into t values (1) returning *) select * from x')).toBe('mutating');
    expect(severity('with x as (select 1) select * from x')).toBe('read');
  });

  it('leaves SELECT ... FOR UPDATE a read, though classify calls it a write', () => {
    // It takes locks; it changes nothing. The progress bar should not go
    // red for a query that cannot lose you anything.
    expect(classify('select * from t for update')).toBe('write');
    expect(severity('select * from t for update')).toBe('read');
  });
});

describe('affectedVerb', () => {
  it('names what the statement did', () => {
    expect(affectedVerb("delete from t where id = '1'")).toBe('deleted');
    expect(affectedVerb('UPDATE t SET a = 1')).toBe('updated');
    expect(affectedVerb('insert into t values (1)')).toBe('inserted');
    expect(affectedVerb('-- a comment\n  truncate table t')).toBe('truncated');
  });

  it('falls back to "affected" rather than guessing', () => {
    // A procedure may insert, update or both. "3 rows affected" is vague;
    // "3 rows deleted" about an insert would be wrong.
    expect(affectedVerb('call rebuild_everything()')).toBe('affected');
    expect(affectedVerb('with x as (delete from t returning *) insert into u select * from x'))
      .toBe('affected');
  });
});

describe('replaceEnd', () => {
  it('reaches past the terminator a replacement would duplicate', () => {
    // The reported bug: translating or refining a statement wrote its own
    // `;` and left the original stranded on a line of its own.
    const doc = 'select * from t order by a desc;';
    const [stmt] = splitStatements(doc);
    expect(doc.slice(stmt.start, stmt.end)).toBe('select * from t order by a desc');
    expect(doc.slice(stmt.start, replaceEnd(doc, stmt.end))).toBe(doc);
  });

  it('crosses the whitespace before a detached terminator', () => {
    const doc = 'select 1\n;';
    const [stmt] = splitStatements(doc);
    expect(doc.slice(stmt.start, replaceEnd(doc, stmt.end))).toBe(doc);
  });

  it('leaves an unterminated statement alone', () => {
    const doc = 'select 1';
    expect(replaceEnd(doc, doc.length)).toBe(doc.length);
  });

  it('stops at its own terminator, never inside the next statement', () => {
    const doc = 'select 1;\n\nselect 2;';
    const [first, second] = splitStatements(doc);
    expect(doc.slice(first.start, replaceEnd(doc, first.end))).toBe('select 1;');
    expect(doc.slice(second.start, replaceEnd(doc, second.end))).toBe('select 2;');
  });

  it('does not reach forward to a terminator that is not its own', () => {
    // An unterminated statement followed by another: the next `;` belongs to
    // the statement after it, and swallowing the text between would delete a
    // query the user never touched.
    const doc = 'select 1';
    const [only] = splitStatements(`${doc}`);
    expect(replaceEnd(doc, only.end)).toBe(doc.length);
  });
});
