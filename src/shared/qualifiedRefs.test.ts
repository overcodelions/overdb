import { describe, expect, it } from 'vitest';
import { referencedSchemas } from './qualifiedRefs';

describe('referencedSchemas', () => {
  it('finds the schema a qualified FROM reaches into', () => {
    expect(referencedSchemas('select * from acme.panel_widget')).toEqual(['acme']);
  });

  it('finds schemas across joins, deduplicated, first appearance first', () => {
    const sql = `select * from acme.panel_widget p
                 join acme.client c on c.id = p.client_id
                 join other_db.audit a on a.id = p.id`;
    expect(referencedSchemas(sql)).toEqual(['acme', 'other_db']);
  });

  it('ignores column qualifiers, which are aliases far more often than schemas', () => {
    expect(referencedSchemas('select p.name from panel_widget p where p.id = 1')).toEqual([]);
  });

  it('reads through backticks and double quotes', () => {
    expect(referencedSchemas('select * from `acme`.`panel_widget`')).toEqual(['acme']);
    expect(referencedSchemas('select * from "sales"."order"')).toEqual(['sales']);
  });

  it('covers the write verbs too, so a repair prompt sees the right catalog', () => {
    expect(referencedSchemas('update acme.client set x = 1')).toEqual(['acme']);
    expect(referencedSchemas('insert into acme.client (id) values (1)')).toEqual(['acme']);
  });

  it('is not confused by an unqualified query', () => {
    expect(referencedSchemas('select * from panel_widget')).toEqual([]);
  });
});
