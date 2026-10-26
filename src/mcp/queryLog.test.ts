import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLogLine, readLogTail } from './queryLog';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-tail-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readLogTail', () => {
  it('is empty for a log nobody has written', () => {
    expect(readLogTail(path.join(dir, 'none.jsonl'), 10)).toEqual([]);
  });

  it('gives the newest lines first, as many as asked', () => {
    const file = path.join(dir, 'a.jsonl');
    for (let n = 1; n <= 5; n++) appendLogLine(file, { n });
    expect(readLogTail<{ n: number }>(file, 3).map((e) => e.n)).toEqual([5, 4, 3]);
  });

  it('skips a line half-written or cut by where the tail starts', () => {
    const file = path.join(dir, 'b.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ n: 1, pad: 'x'.repeat(100) })}\n${JSON.stringify({ n: 2 })}\n{"n":3,`);
    expect(readLogTail<{ n: number }>(file, 10, 40).map((e) => e.n)).toEqual([2]);
  });
});
