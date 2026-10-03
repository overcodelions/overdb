// The seed flow's model may read a repo. It must never be able to do more.
//
// Reading the code is what makes a seed the app will accept, and it is also
// the one place overdb hands a model tools. A repo usually holds a `.env`
// with the database's own credentials, so a shell — or any tool that runs
// code, or an MCP server — would let the model reach the database directly
// and walk straight past the write gate. These tests fail the build if the
// investigation's arguments ever loosen, and pin down the parsing of what
// comes back, which is paths and patterns and never file contents.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { INVESTIGATE_TOOLS, investigateArgs, resultFromStream, stepsFromStreamLine } from './ai';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

describe('the seed investigation', () => {
  const args = investigateArgs('');

  it('has exactly Read, Grep and Glob', () => {
    expect([...INVESTIGATE_TOOLS]).toEqual(['Read', 'Grep', 'Glob']);
    expect(args).toContain('--tools=Read,Grep,Glob');
    expect(args.filter((a) => a.startsWith('--tools'))).toHaveLength(1);
  });

  it('names no tool that runs code or writes', () => {
    const joined = args.join(' ');
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'PowerShell']) {
      expect(joined, tool).not.toMatch(new RegExp(`--(tools|allowedTools)=[^ ]*\\b${tool}\\b`));
    }
    expect(joined).not.toMatch(/--allowedTools|--dangerously|bypassPermissions|--mcp-config\b/);
  });

  it('is restricted, MCP-free, non-prompting and denied dotenv files', () => {
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--permission-mode=dontAsk');
    expect(args.find((a) => a.startsWith('--disallowedTools='))).toContain('Read(./**/.env*)');
  });

  it('denies secrets in every extra repo it may read, by absolute path', () => {
    const more = investigateArgs('', ['/code/billing-svc']);
    expect(more.join(' ')).toContain('--add-dir /code/billing-svc');
    const deny = more.find((a) => a.startsWith('--disallowedTools='))!;
    expect(deny).toContain('Read(//code/billing-svc/**/.env*)');
    expect(deny).toContain('Read(//code/billing-svc/**/*.key)');
    expect(deny).toContain('Read(./**/.env*)');
  });

  it('is only ever started with those arguments', () => {
    const src = read('src', 'main', 'ai.ts');
    const spawns = [...src.matchAll(/spawn\(([^)]*\))/g)].map((m) => m[1]);
    const claude = spawns.filter((s) => s.includes('investigateArgs'));
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatch(/^'claude', investigateArgs\(/);
  });

  it('seedPrompts cannot reach the database or register IPC', () => {
    const src = read('src', 'main', 'seedPrompts.ts');
    expect(src).not.toContain('ipcMain');
    expect(src).not.toMatch(/from '\.\/dbSupervisor'/);
    expect(src).not.toMatch(/from '\.\.\/db\//);
  });

  it('query:run holds seed statements to the gate', () => {
    const src = read('src', 'main', 'index.ts');
    const run = src.slice(src.indexOf("'query:run'"), src.indexOf("'query:ack'"));
    expect(run).toMatch(/args\.origin === 'seed'[\s\S]*seedRefusal\(conn\)/);
  });
});

describe('stepsFromStreamLine', () => {
  const cwd = '/work/shop';
  const line = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });

  it('reports files read relative to the repo, and searches by pattern', () => {
    expect(
      stepsFromStreamLine(
        line([
          { type: 'text', text: 'Looking at the tiers.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/work/shop/src/tier.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'loyalty_tier', path: '/work/shop/src' } },
          { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.sql' } },
        ]),
        cwd,
      ),
    ).toEqual([
      { kind: 'read', text: 'src/tier.ts' },
      { kind: 'grep', text: '"loyalty_tier" in src' },
      { kind: 'glob', text: '**/*.sql' },
    ]);
  });

  it('never surfaces tool results, which carry file contents', () => {
    const result = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'SECRET=hunter2' }] },
    });
    expect(stepsFromStreamLine(result, cwd)).toEqual([]);
    expect(stepsFromStreamLine('not json', cwd)).toEqual([]);
  });
});

describe('resultFromStream', () => {
  it('takes the final result event', () => {
    const out = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', is_error: false, result: '```json\n{}\n```' }),
      '',
    ].join('\n');
    expect(resultFromStream(out)).toEqual({ ok: true, text: '```json\n{}\n```' });
    expect(resultFromStream('')).toBeNull();
  });
});
