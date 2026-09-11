import { describe, expect, it } from 'vitest';
import { lowerKeys, MYSQL_TABLE_READS_SQL, MYSQL_TABLE_SIZE_SQL } from './mysql';

describe('lowerKeys', () => {
  it('reads a MySQL 8 catalog row the same as a MariaDB one', () => {
    // MySQL 8 answers information_schema with the data dictionary's own
    // upper-case column names, whatever case you wrote in the select list.
    // Unfolded, `r.table_name` is undefined on Aurora and populated on
    // MariaDB — and the catalog then loads with the right number of tables
    // and every name empty, which reads downstream as "no such table".
    expect(lowerKeys([{ TABLE_SCHEMA: 'acme', TABLE_NAME: 'panel_widget' }])).toEqual([
      { table_schema: 'acme', table_name: 'panel_widget' },
    ]);
    expect(lowerKeys([{ table_schema: 'acme', table_name: 'panel_widget' }])).toEqual([
      { table_schema: 'acme', table_name: 'panel_widget' },
    ]);
  });

  it('keeps values exactly as they came', () => {
    expect(lowerKeys([{ COLUMN_DEFAULT: null, NON_UNIQUE: 0 }])).toEqual([
      { column_default: null, non_unique: 0 },
    ]);
  });
});

/// MySQL's reserved words, restricted to the ones that read like ordinary
/// column names and so actually get used as aliases. Not the full list —
/// a test nobody can scan is a test nobody maintains.
const RESERVED_ALIASES = [
  'rows', 'reads', 'writes', 'groups', 'ranges', 'lead', 'lag', 'first', 'last',
  'rank', 'over', 'window', 'system', 'cume_dist', 'percent_rank', 'except',
  'lateral', 'recursive', 'optimizer_costs', 'get', 'grouping',
];

describe('health statements', () => {
  // These two shipped with `as rows` and `as reads`, and nothing caught it:
  // a broken health read becomes a line in "what this server would not
  // say", so the pane loses a whole panel and reports a parser error where
  // the explanation should be. Cheap to assert, invisible otherwise.
  it.each([
    ['table sizes', MYSQL_TABLE_SIZE_SQL],
    ['table reads', MYSQL_TABLE_READS_SQL],
  ])('does not alias a column to a reserved word in %s', (_name, sql) => {
    const aliases = [...sql.matchAll(/\bas\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.filter((a) => RESERVED_ALIASES.includes(a))).toEqual([]);
  });

  it('reads each alias the snapshot then looks for', () => {
    // The rename is only half a fix if the mapping still reads row.rows.
    expect(MYSQL_TABLE_SIZE_SQL).toMatch(/as est_rows/);
    expect(MYSQL_TABLE_READS_SQL).toMatch(/as read_count/);
  });
});
