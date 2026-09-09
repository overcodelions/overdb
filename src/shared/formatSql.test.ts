import { describe, expect, it } from 'vitest';
import { ensureTerminated, formatSql } from './formatSql';

describe('formatSql', () => {
  it('puts each clause on its own line, columns indented one per line', () => {
    expect(formatSql('select a, b, c from t where x = 1 order by a desc limit 10')).toBe(
      [
        'SELECT',
        '  a,',
        '  b,',
        '  c',
        'FROM t',
        'WHERE x = 1',
        'ORDER BY a desc',
        'LIMIT 10',
      ].join('\n'),
    );
  });

  it('breaks joins and their ON clauses onto their own lines', () => {
    const out = formatSql(
      'select pw.id from panel_widget pw join client c on c.client_id = pw.client_id',
    );
    expect(out.split('\n')).toEqual([
      'SELECT pw.id',
      'FROM panel_widget pw',
      'JOIN client c',
      'ON c.client_id = pw.client_id',
    ]);
  });

  it('prefers the longer join keyword', () => {
    // `left outer join` must not be split into `left` + `outer join`, and
    // `union all` must not become `union` followed by a stray `all`.
    expect(formatSql('select a from x left outer join y on 1=1')).toContain('LEFT OUTER JOIN y');
    expect(formatSql('select 1 union all select 2')).toContain('UNION ALL');
  });

  it('indents AND / OR under the condition they extend', () => {
    const out = formatSql("select a from t where x = 1 and y = 2 or z = 3");
    expect(out).toContain('WHERE x = 1\n  AND y = 2\n  OR z = 3');
  });

  it('leaves subqueries alone rather than unindenting them to column 0', () => {
    // A nested SELECT is inside parens, so it must not be treated as a
    // top-level clause and dragged onto its own line.
    const out = formatSql('select a from t where id in (select id from u where q = 1)');
    expect(out).toContain('(select id from u where q = 1)');
  });

  it('never reformats the inside of a string or a comment', () => {
    expect(formatSql("select 'from a, b where' as s from t")).toContain("'from a, b where'");
    expect(formatSql('-- select from where\nselect a from t')).toContain('-- select from where');
  });

  it('does not split a comma inside a function call', () => {
    const out = formatSql('select coalesce(a, b) as x, c from t');
    expect(out).toContain('coalesce(a, b)');
  });

  it('keeps multi-digit numbers whole', () => {
    // Each digit falling through the punctuation branch turns `10` into
    // `1 0`, which is a syntax error rather than a formatting nit.
    expect(formatSql('select a from t limit 10 offset 250')).toContain('LIMIT 10');
    expect(formatSql('select 1.5e3 as n')).toContain('1.5e3');
  });

  it('never splits a multi-character operator', () => {
    // `!=` becoming `! =` is a syntax error, not a formatting nit — the
    // formatter must not be able to break a query it was asked to tidy.
    for (const [input, expected] of [
      ['select a from t where x != 0', '!= 0'],
      ['select a from t where x <> 0', '<> 0'],
      ['select a from t where x <= 0', '<= 0'],
      ['select a from t where x >= 0', '>= 0'],
      ["select a || b from t", 'a || b'],
      ['select a::text from t', 'a::text'],
    ] as const) {
      expect(formatSql(input), input).toContain(expected);
    }
  });

  it('keeps a single-item select list on the SELECT line', () => {
    // `SELECT` and `*` on separate lines is noise, not structure.
    expect(formatSql('select * from panel_widget')).toBe('SELECT *\nFROM panel_widget');
    expect(formatSql('select pw.* from panel_widget pw')).toContain('SELECT pw.*');
    expect(formatSql('select count(*) from t')).toBe('SELECT count(*)\nFROM t');
  });

  it('still breaks up a real list', () => {
    expect(formatSql('select a, b from t')).toBe('SELECT\n  a,\n  b\nFROM t');
  });

  it('keeps a qualifier bound to what follows it', () => {
    // `pw.*` must not become `pw. *`, which is a syntax error.
    expect(formatSql('select pw.* from panel_widget pw')).toContain('pw.*');
  });

  it('returns empty input unchanged', () => {
    expect(formatSql('   ')).toBe('');
  });
});

describe('ensureTerminated', () => {
  it('adds a missing semicolon', () => {
    expect(ensureTerminated('select 1')).toBe('select 1;');
  });

  it('does not double one that is already there', () => {
    expect(ensureTerminated('select 1;')).toBe('select 1;');
    expect(ensureTerminated('select 1;  \n')).toBe('select 1;');
  });

  it('leaves empty input alone', () => {
    expect(ensureTerminated('   ')).toBe('');
  });
});
