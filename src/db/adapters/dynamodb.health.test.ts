import { describe, expect, it } from 'vitest';
import { dynamoPanels, gsiBytes } from './dynamodb';

function table(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TableName: 'orders',
    TableSizeBytes: 1_000_000,
    ItemCount: 500,
    ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 },
    ...patch,
  };
}

describe('gsiBytes', () => {
  it('is null for a table with no secondary indexes, not zero', () => {
    // Zero would draw a bar saying the indexes are empty; null says there
    // are none.
    expect(gsiBytes(table())).toBeNull();
  });

  it('adds up every index, because each is its own copy of the data', () => {
    expect(
      gsiBytes(
        table({
          GlobalSecondaryIndexes: [{ IndexSizeBytes: 400 }, { IndexSizeBytes: 600 }],
        }),
      ),
    ).toBe(1000);
  });
});

describe('dynamoPanels', () => {
  const limits = { accountRead: 1000, accountWrite: 1000 };

  it('reads provisioned units against the account ceiling', () => {
    const panels = dynamoPanels([table(), table({ TableName: 'events' })], limits, 'us-east-1');
    const capacity = panels.find((p) => p.key === 'dynamo-capacity');
    expect(capacity?.rows[0].value).toBe('200 of 1,000');
    expect(capacity?.rows[0].tone).toBe('good');
    expect(capacity?.rows[1].value).toBe('100 of 1,000');
  });

  it('escalates as the account fills', () => {
    const hungry = table({ ProvisionedThroughput: { ReadCapacityUnits: 950, WriteCapacityUnits: 800 } });
    const panels = dynamoPanels([hungry], limits, 'us-east-1');
    const rows = panels.find((p) => p.key === 'dynamo-capacity')?.rows ?? [];
    expect(rows[0].tone).toBe('bad');
    expect(rows[1].tone).toBe('watch');
  });

  it('says which tables the capacity number does not cover', () => {
    const panels = dynamoPanels(
      [table(), table({ TableName: 'events', BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } })],
      limits,
      'us-east-1',
    );
    expect(panels[0].note).toContain('1 of these 2 tables bill per request');
  });

  it('has nothing to say about capacity when the account reports no ceiling', () => {
    expect(dynamoPanels([table()], {}, 'us-east-1').map((p) => p.key)).toEqual([]);
  });

  it('ranks secondary indexes by size, across tables', () => {
    const panels = dynamoPanels(
      [
        table({ GlobalSecondaryIndexes: [{ IndexName: 'by_customer', IndexSizeBytes: 2048 }] }),
        table({
          TableName: 'events',
          GlobalSecondaryIndexes: [{ IndexName: 'by_day', IndexSizeBytes: 8192 }],
        }),
      ],
      limits,
      'us-east-1',
    );
    const gsi = panels.find((p) => p.key === 'dynamo-gsi');
    expect(gsi?.rows.map((r) => r.label)).toEqual(['by_day', 'by_customer']);
    expect(gsi?.rows[0].sub).toBe('on events');
    expect(gsi?.rows[0].value).toBe('8.0 KB');
  });
});
