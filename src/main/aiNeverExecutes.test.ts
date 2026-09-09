// The AI layer must have no path to executing SQL.
//
// The design intent is that a model PROPOSES: its output lands in the editor
// as text the user reads, and running it is then the user's own act, with
// the read-only transaction still in front of any mutation. That is easy to
// state and easy to erode — someone adds a convenient "run this" button to
// the Ask panel and the property is quietly gone.
//
// So it is asserted structurally, in three independent ways: the execute
// channel's origin union has no 'ai' member, there is exactly one execute
// channel, and the AI modules cannot reach the database at all.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

describe('the AI layer and execution', () => {
  it("QueryOrigin has no 'ai' member", () => {
    const types = read('src', 'shared', 'types.ts');
    const m = /export type QueryOrigin =([^;]+);/.exec(types);
    expect(m, 'QueryOrigin not found in shared/types.ts').toBeTruthy();
    expect(m![1]).not.toMatch(/['"]ai['"]/);
  });

  it('there is exactly one channel that executes SQL', () => {
    const types = read('src', 'shared', 'types.ts');
    const executors = [...types.matchAll(/^\s*'([a-z]+:[A-Za-z]+)':/gm)]
      .map((x) => x[1])
      .filter((c) => /^query:(run|exec|execute)$/.test(c));
    expect(executors).toEqual(['query:run']);
  });

  it('ai.ts and aiPrompts.ts cannot reach the database or register IPC', () => {
    for (const file of ['ai.ts', 'aiPrompts.ts', 'schemaContext.ts']) {
      const src = read('src', 'main', file);
      expect(src, `${file} registers an IPC handler`).not.toContain('ipcMain.handle');
      expect(src, `${file} imports the supervisor`).not.toMatch(/from '\.\/dbSupervisor'/);
      expect(src, `${file} imports the engine layer`).not.toMatch(/from '\.\.\/db\//);
    }
  });

  it('schemaContext takes a snapshot, so row data cannot reach a prompt', () => {
    // The guarantee is structural: with no adapter reference there is
    // nothing to read rows FROM, whatever a future prompt asks for.
    const src = read('src', 'main', 'schemaContext.ts');
    expect(src).not.toMatch(/\bquery\s*\(/);
    expect(src).toMatch(/SchemaSnapshot/);
  });
});
