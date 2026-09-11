import { describe, expect, it } from 'vitest';
import { ensureTerminated, formatSql, FORMAT_STYLES, type FormatStyle } from './formatSql';

/// The reference statement and its five layouts, exactly as the styles are
/// defined elsewhere in the industry. These are byte-for-byte assertions on
/// purpose: a formatter that is "nearly" a named style is a formatter whose
/// output nobody recognises.
const REFERENCE =
  "SELECT CompanyName, AddressType, AddressLine1 FROM Customer " +
  "JOIN CustomerAddress ON (Customer.CustomerID = CustomerAddress.CustomerID) " +
  "JOIN Address ON (CustomerAddress.AddressID = Address.AddressID) " +
  "WHERE CompanyName = 'ACME Corporation'";

const EXPECTED: Record<FormatStyle, string> = {
  collapsed: [
    'SELECT CompanyName, AddressType, AddressLine1',
    'FROM Customer',
    '     JOIN CustomerAddress ON(Customer.CustomerID=CustomerAddress.CustomerID)',
    '     JOIN Address ON(CustomerAddress.AddressID=Address.AddressID)',
    "WHERE CompanyName='ACME Corporation'",
  ].join('\n'),

  'commas-before': [
    'SELECT CompanyName',
    '     , AddressType',
    '     , AddressLine1',
    'FROM Customer',
    '    JOIN CustomerAddress',
    '        ON (Customer.CustomerID = CustomerAddress.CustomerID)',
    '    JOIN Address',
    '        ON (CustomerAddress.AddressID = Address.AddressID)',
    "WHERE CompanyName = 'ACME Corporation'",
  ].join('\n'),

  default: [
    'SELECT CompanyName,',
    '       AddressType,',
    '       AddressLine1',
    'FROM Customer',
    '    JOIN CustomerAddress',
    '        ON (Customer.CustomerID = CustomerAddress.CustomerID)',
    '    JOIN Address',
    '        ON (CustomerAddress.AddressID = Address.AddressID)',
    "WHERE CompanyName = 'ACME Corporation'",
  ].join('\n'),

  indented: [
    'SELECT',
    '    CompanyName,',
    '    AddressType,',
    '    AddressLine1',
    'FROM',
    '    Customer',
    '    JOIN',
    '        CustomerAddress',
    '            ON (Customer.CustomerID = CustomerAddress.CustomerID)',
    '    JOIN',
    '        Address',
    '            ON (CustomerAddress.AddressID = Address.AddressID)',
    'WHERE',
    "    CompanyName = 'ACME Corporation'",
  ].join('\n'),

  'right-aligned': [
    'SELECT CompanyName,',
    '       AddressType,',
    '       AddressLine1',
    '  FROM Customer',
    '  JOIN CustomerAddress',
    '    ON (Customer.CustomerID       = CustomerAddress.CustomerID)',
    '  JOIN Address',
    '    ON (CustomerAddress.AddressID = Address.AddressID)',
    " WHERE CompanyName = 'ACME Corporation'",
  ].join('\n'),
};

describe('the five named layouts', () => {
  for (const style of FORMAT_STYLES) {
    it(`renders ${style.label} exactly`, () => {
      expect(formatSql(REFERENCE, style.id)).toBe(EXPECTED[style.id]);
    });
  }

  it('offers every style it can render, and no others', () => {
    expect(FORMAT_STYLES.map((s) => s.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('lines the equals signs up only where the style asks for it', () => {
    // Right-aligned is the one layout that does this; doing it everywhere
    // would insert whitespace the other four never promised.
    expect(formatSql(REFERENCE, 'default')).not.toContain('CustomerID       =');
    expect(formatSql(REFERENCE, 'right-aligned')).toContain('CustomerID       =');
  });

  it('widens the right-aligned gutter to the longest keyword present', () => {
    // GROUP BY is eight characters, so every keyword in that statement
    // right-aligns to eight rather than to SELECT's six.
    const out = formatSql('select a, count(*) from t group by a order by a', 'right-aligned');
    expect(out).toContain('  SELECT a,');
    expect(out).toContain('GROUP BY a');
  });
});

describe('formatSql, on the Default layout', () => {
  it('aligns the list under its first item', () => {
    expect(formatSql('select a, b, c from t where x = 1 order by a desc limit 10')).toBe(
      [
        'SELECT a,',
        '       b,',
        '       c',
        'FROM t',
        'WHERE x = 1',
        'ORDER BY a desc',
        'LIMIT 10',
      ].join('\n'),
    );
  });

  it('gives ON its own line here, and keeps it inline under Collapsed', () => {
    const sql = 'select pw.id from panel_widget pw join client c on c.client_id = pw.client_id';
    expect(formatSql(sql).split('\n')).toEqual([
      'SELECT pw.id',
      'FROM panel_widget pw',
      '    JOIN client c',
      '        ON c.client_id = pw.client_id',
    ]);
    expect(formatSql(sql, 'collapsed').split('\n')).toEqual([
      'SELECT pw.id',
      'FROM panel_widget pw',
      '     JOIN client c ON c.client_id=pw.client_id',
    ]);
  });

  it('prefers the longer join keyword', () => {
    // `left outer join` must not be split into `left` + `outer join`, and
    // `union all` must not become `union` followed by a stray `all`.
    expect(formatSql('select a from x left outer join y on 1=1')).toContain('LEFT OUTER JOIN y');
    expect(formatSql('select 1 union all select 2')).toContain('UNION ALL');
  });

  it('right-aligns AND / OR so the conditions they join stay in one column', () => {
    const out = formatSql('select a from t where x = 1 and y = 2 or z = 3');
    expect(out).toContain('WHERE x = 1\n  AND y = 2\n   OR z = 3');
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

  it('still breaks up a real list, one item per line', () => {
    expect(formatSql('select a, b from t')).toBe('SELECT a,\n       b\nFROM t');
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

describe('bracketed conditions', () => {
  // The shape an ORM emits, and the one the formatter used to leave as a
  // single 300-character line: the connectors are INSIDE the brackets.
  const hibernate =
    "select p.id from acme.partner p where(p.pending_customer_approval = 0 AND p.exclude_reports = 0 AND p.partner_source <> 26) and(p.client_id is not null)";

  it('breaks a long condition group onto its own lines', () => {
    const out = formatSql(hibernate, 'default');
    expect(out).toContain('WHERE (p.pending_customer_approval = 0\n');
    expect(out).toContain('AND p.exclude_reports = 0');
    expect(out.split('\n').every((l) => l.length < 80)).toBe(true);
  });

  it('aligns the connectors with the first condition in the group', () => {
    const lines = formatSql(hibernate, 'default').split('\n');
    const first = lines.find((l) => l.includes('pending_customer_approval'))!;
    const second = lines.find((l) => l.trim().startsWith('AND p.exclude_reports'))!;
    expect(second.indexOf('AND')).toBe(first.indexOf('p.pending'));
  });

  it('leaves a short group alone', () => {
    // Breaking `(a = 1 AND b = 2)` costs two lines and buys nothing.
    expect(formatSql('select * from t where (a = 1 AND b = 2)', 'default')).toBe(
      'SELECT *\nFROM t\nWHERE (a = 1 AND b = 2)',
    );
  });

  it('never breaks an IN list, which has no connectors in it', () => {
    const out = formatSql(
      "select * from t where id in ('aaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccccccc')",
      'default',
    );
    // The claim is that it stays on ONE line — the comma layout inside a
    // bracket is the list rule's business, not this one's.
    expect(out.split('\n').filter((l) => l.includes('aaaaaaaa'))).toHaveLength(1);
  });

  it('keeps collapsed collapsed', () => {
    expect(formatSql(hibernate, 'collapsed').split('\n').some((l) => l.trim().startsWith('AND p.exclude'))).toBe(false);
  });
});
