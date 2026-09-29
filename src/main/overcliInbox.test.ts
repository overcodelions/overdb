import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HandoffDraft } from '../shared/overcliHandoff';
import { overcliAvailable, sendToOvercli } from './overcliInbox';

let root: string;
let inbox: string;

const draft: HandoffDraft = {
  kind: 'slow-query',
  title: 'Slow query on orders',
  summary: 'orders is scanned in full.',
  evidence: { sql: 'select * from orders where customer_id = $1', plan: 'Seq Scan on orders', envs: ['prod'] },
  repoHints: ['/work/acme-orders'],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-inbox-'));
  inbox = path.join(root, 'inbox');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('overcliAvailable', () => {
  it('is false until overcli has made its inbox', () => {
    expect(overcliAvailable(inbox)).toBe(false);
    fs.mkdirSync(inbox);
    expect(overcliAvailable(inbox)).toBe(true);
  });

  it('is false when the path is a file, not a folder', () => {
    fs.writeFileSync(inbox, '');
    expect(overcliAvailable(inbox)).toBe(false);
  });
});

describe('sendToOvercli', () => {
  it('refuses, and creates nothing, when overcli is not there', () => {
    const r = sendToOvercli(draft, { dir: inbox });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(inbox)).toBe(false);
  });

  it('writes one whole file named for arrival order, and no tmp is left', () => {
    fs.mkdirSync(inbox);
    const r = sendToOvercli(draft, { dir: inbox, now: 1234, id: 'abc' });
    expect(r).toEqual({ ok: true, id: 'abc' });
    expect(fs.readdirSync(inbox)).toEqual(['1234-abc.json']);
    const written = JSON.parse(fs.readFileSync(path.join(inbox, '1234-abc.json'), 'utf-8'));
    expect(written).toMatchObject({ v: 1, id: 'abc', from: 'overdb', kind: 'slow-query', createdAt: 1234 });
  });

  it('never carries fields it does not know — a result set tacked on stays behind', () => {
    fs.mkdirSync(inbox);
    const sneaky = {
      ...draft,
      rows: [['alice@example.com']],
      evidence: { ...draft.evidence, rows: [[1]], password: 'hunter2' },
    } as unknown as HandoffDraft;
    sendToOvercli(sneaky, { dir: inbox, now: 1, id: 'x' });
    const text = fs.readFileSync(path.join(inbox, '1-x.json'), 'utf-8');
    expect(text).not.toMatch(/alice|hunter2|"rows"|password/);
  });

  it('refuses a handoff with no repo to open it in', () => {
    fs.mkdirSync(inbox);
    const r = sendToOvercli({ ...draft, repoHints: [] }, { dir: inbox });
    expect(r).toEqual({ ok: false, error: 'Link a repo first.' });
    expect(fs.readdirSync(inbox)).toEqual([]);
  });
});
