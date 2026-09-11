import { describe, expect, it } from 'vitest';
import { previewStatement } from './preview';

describe('previewStatement', () => {
  it('writes a bare name for a table in the active schema', () => {
    expect(previewStatement('postgres', { schema: 'public', table: 'orders', activeSchema: 'public' }))
      .toBe('select *\nfrom "orders"\nlimit 200;');
  });

  it('qualifies a table the session would not resolve', () => {
    expect(previewStatement('mysql', { schema: 'acme_dm', table: 'client', activeSchema: 'acme' }))
      .toBe('select *\nfrom `acme_dm`.`client`\nlimit 200;');
  });

  it('peeks at a handful of DynamoDB items rather than reading to the row cap', () => {
    // Clicking a table must not cost a full scan. The LIMIT is lifted into
    // the request by the adapter, so DynamoDB stops evaluating at five.
    const sql = previewStatement('dynamodb', {
      schema: 'us-east-1',
      table: 'LOCAL.event-log-v2',
    });
    expect(sql).toBe('SELECT * FROM "LOCAL.event-log-v2" LIMIT 5;');
  });

  it('writes no region prefix, which would name an index that does not exist', () => {
    // "us-east-1"."t" means the index t on a table called us-east-1.
    expect(previewStatement('dynamodb', { schema: 'us-east-1', table: 'orders' })).not.toContain(
      'us-east-1',
    );
  });
});
