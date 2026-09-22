// The engine layer must not be able to reach `electron`.
//
// src/dbhost/index.ts is forked as a utilityProcess today and will be
// forked by `overdb serve --mcp` under plain node later. Under plain node
// `require('electron')` resolves to a stub returning a binary path, or
// throws — either way a single stray import anywhere in the transitive
// graph takes the whole process down, at REQUIRE time, before any error
// handling runs. It is also invisible in development, where the electron
// package sits right there in node_modules and imports fine.
//
// So this walks the graph statically rather than importing it. Importing
// would execute module bodies and would only catch an electron import on a
// path that happens to be evaluated; reading the files catches every one.
//
// Written before the CLI exists, deliberately: retrofitting this rule after
// the fact means untangling it, and the whole cheapness of `serve --mcp`
// later rests on it being true from the start.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src', 'dbhost', 'index.ts');

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

function staticSpecifiersIn(body: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(body))) out.push(m[1]);
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(entry: string): { files: Set<string>; bare: Map<string, string[]> } {
  const files = new Set<string>();
  const bare = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const body = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(ROOT, file);
    for (const spec of staticSpecifiersIn(body)) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
        continue;
      }
      if (spec.startsWith('.')) continue;
      bare.set(spec, [...(bare.get(spec) ?? []), rel]);
    }
  }
  return { files, bare };
}

describe('the connection-host import graph', () => {
  const graph = walk(ENTRY);

  it('never imports electron', () => {
    const offenders = graph.bare.get('electron') ?? [];
    expect(
      offenders,
      'These files are reachable from src/dbhost/index.ts and import electron:\n  ' +
        offenders.join('\n  ') +
        '\nThe connection host runs under plain node too. Keep electron in src/main.',
    ).toEqual([]);
  });

  it('reaches the real adapters, so the guard above is guarding something', () => {
    // path.relative gives backslashes on Windows; the expectations below are
    // repo paths, which are written with forward slashes everywhere.
    const rel = [...graph.files].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(rel).toContain('src/db/adapters/postgres.ts');
    expect(rel).toContain('src/db/adapters/mysql.ts');
    expect(rel).toContain('src/db/adapters/sqlite.ts');
  });

  it('does not pull in the renderer or the main process', () => {
    const leaked = [...graph.files]
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((f) => f.startsWith('src/renderer/') || f.startsWith('src/main/'));
    expect(leaked).toEqual([]);
  });
});
