import { describe, expect, it } from 'vitest';
import { resolveStep, tableAliases } from './aliases';

describe('tableAliases', () => {
  it('reads a qualified table and its alias', () => {
    const a = tableAliases(
      'SELECT c.client_id FROM acme.partner p JOIN acme.client c ON p.client_id=c.client_id',
    );
    expect(a.p).toBe('acme.partner');
    expect(a.c).toBe('acme.client');
  });

  it('maps an unaliased table to itself', () => {
    expect(tableAliases('select * from flyway_schema_history;').flyway_schema_history).toBe(
      'flyway_schema_history',
    );
  });

  it('takes AS, and reads through backticks', () => {
    const a = tableAliases('select * from `acme`.`panel_widget` as pw');
    expect(a.pw).toBe('acme.panel_widget');
  });

  it('does not mistake a keyword for an alias', () => {
    // `from panel_widget where ...` used to report an alias called `where`.
    const a = tableAliases('select * from panel_widget where notify_daily = 1');
    expect(a.where).toBeUndefined();
    expect(a.panel_widget).toBe('panel_widget');
  });

  it('reads every table in a multi-join statement', () => {
    const a = tableAliases(
      'FROM partner_group_view_restrictions v JOIN partner_group g ON g.id = v.id LEFT JOIN role r ON 1=1',
    );
    expect(a.v).toBe('partner_group_view_restrictions');
    expect(a.g).toBe('partner_group');
    expect(a.r).toBe('role');
  });
});

describe('resolveStep', () => {
  const aliases = tableAliases('from acme.partner p join acme.client c on 1=1');

  it('gives the table and the alias it was called', () => {
    expect(resolveStep('p', aliases)).toEqual({ table: 'acme.partner', alias: 'p' });
  });

  it('reports no alias when the step is already the table name', () => {
    expect(resolveStep('client', tableAliases('from client'))).toEqual({
      table: 'client',
      alias: null,
    });
  });

  it('returns null for a step that is not a table — a sort, a temp table', () => {
    expect(resolveStep('Sort', aliases)).toBeNull();
  });
});
