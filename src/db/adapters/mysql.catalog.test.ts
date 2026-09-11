import { describe, expect, it } from 'vitest';
import { lowerKeys } from './mysql';

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
