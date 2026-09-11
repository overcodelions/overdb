// Coverage for the streaming path itself — the chunked pull protocol the
// dbhost process drives, and the BLOB round-trip through it into an export
// format. Every other sqlite test exercises introspect()/health(); nothing
// previously ran stream() against more than a handful of rows.

import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from './sqlite';
import { formatRows } from '../../shared/exportRows';

describe('SqliteAdapter streaming', () => {
  it('pulls a large result in fixed-size chunks and round-trips a BLOB column', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect({ engine: 'sqlite', file: ':memory:', readOnly: false, statementTimeoutMs: null });

    const ddl = await adapter.stream('create table items (id integer primary key, blob_col blob)');
    await ddl.close();

    const ROWS = 1_200;
    for (let i = 0; i < ROWS; i++) {
      const h = await adapter.stream('insert into items (id, blob_col) values (?, ?)', [
        i,
        new Uint8Array([i % 256, (i + 1) % 256]),
      ]);
      await h.close();
    }

    const handle = await adapter.stream('select id, blob_col from items order by id');

    const first = await handle.next(500);
    expect(handle.columns.length).toBeGreaterThan(0);
    expect(first.rows).toHaveLength(500);
    expect(first.done).toBe(false);

    const second = await handle.next(500);
    expect(second.rows).toHaveLength(500);
    expect(second.done).toBe(false);

    const third = await handle.next(500);
    expect(third.rows).toHaveLength(200);
    expect(third.done).toBe(true);

    await expect(handle.close()).resolves.toBeUndefined();

    const literal = formatRows(handle.columns, [third.rows[0]], 'insert');
    expect(literal).toMatch(/X'[0-9a-f]+'/);
  });
});
