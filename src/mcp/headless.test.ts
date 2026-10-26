import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryLogPath, queryLogger } from './headless';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-qlog-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the headless query log', () => {
  it('is off unless asked for', () => {
    expect(queryLogPath(['--connections', 'c.json'])).toBeNull();
    expect(queryLogPath(['--connections', 'c.json', '--query-log', '/data/q.jsonl'])).toBe('/data/q.jsonl');
  });

  it('writes one line per call, with the worker its runtime named', () => {
    const file = path.join(dir, 'q.jsonl');
    const log = queryLogger(file, { OVERCLI_WORKER: 'Triage', OVERCLI_CONVERSATION: 'conv-1' });
    log({ at: '2026-01-01T00:00:00.000Z', tool: 'query', connection: 'shop', ok: true, ms: 3, sql: 'select 1', rowCount: 1 });
    log({ at: '2026-01-01T00:00:01.000Z', tool: 'list_tables', connection: 'shop', ok: true, ms: 2 });
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ worker: 'Triage', conversation: 'conv-1', tool: 'query', sql: 'select 1' });
  });

  it('moves a full log aside rather than growing forever', () => {
    const file = path.join(dir, 'q.jsonl');
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    queryLogger(file, {})({ at: 'now', tool: 'query', connection: 'shop', ok: true, ms: 1 });
    expect(fs.statSync(`${file}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);
  });
});
