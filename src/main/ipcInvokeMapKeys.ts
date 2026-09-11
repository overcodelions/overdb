// Parses the set of channel names declared on IPCInvokeMap (src/shared/
// types.ts). Pulled out of ipcContract.test.ts so it can be imported at
// runtime by another test — secretsNeverCrossIpc.test.ts cross-checks its
// own, differently-written parse of the same interface against this one,
// and importing a *.test.ts file from inside a running test re-executes
// that file's top-level `describe` blocks, which vitest rejects.

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function ipcInvokeMapKeys(): Set<string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'types.ts'), 'utf-8');
  const start = src.indexOf('export interface IPCInvokeMap');
  if (start < 0) throw new Error('IPCInvokeMap interface not found in types.ts');
  const braceOpen = src.indexOf('{', start);
  // Find the matching closing brace by counting depth.
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('IPCInvokeMap interface body has unbalanced braces');
  const body = src.slice(braceOpen + 1, end);
  // Match keys at the start of any line: optional whitespace, a quoted
  // string, then a colon. This skips block comments and field-typedef
  // continuation lines (which start with non-quote chars).
  const re = /^\s*['"]([^'"]+)['"]\s*:/gm;
  const keys = new Set<string>();
  for (const m of body.matchAll(re)) {
    keys.add(m[1]);
  }
  return keys;
}

/// Exported so secretsNeverCrossIpc.test.ts can cross-check its own,
/// differently-written parse of IPCInvokeMap against this one — two parsers
/// agreeing is much stronger evidence than either one passing alone.
export const CHANNELS: Record<string, true> = Object.fromEntries(
  [...ipcInvokeMapKeys()].map((k) => [k, true] as const),
);
