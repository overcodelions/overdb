// No IPC channel may hand a credential to the renderer.
//
// The design intent is that the renderer's relationship to secrets is
// WRITE-ONLY: `conn:setSecret` exists, and nothing returns one. That is
// easy to state and easy to erode — someone adds a "test connection"
// channel that echoes the resolved ConnectSpec back for debugging, and the
// property is quietly gone.
//
// So it is asserted rather than documented. This parses IPCInvokeMap and
// fails if any RETURN type mentions a credential-shaped name. Argument
// types are deliberately not checked: passing a password IN is the whole
// point of conn:setSecret.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN = /password|secret|token|credential|connectionString|ConnectSpec/i;

function invokeMapBody(): string {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types.ts'), 'utf-8');
  const start = src.indexOf('export interface IPCInvokeMap');
  if (start < 0) throw new Error('IPCInvokeMap not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in IPCInvokeMap');
}

/// Each entry is `'channel': (args) => Return;`. The return type is
/// everything after the top-level `=>`.
function returnTypes(): Array<{ channel: string; returns: string }> {
  const out: Array<{ channel: string; returns: string }> = [];
  for (const line of invokeMapBody().split('\n')) {
    const m = /^\s*['"]([^'"]+)['"]\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const arrow = m[2].indexOf('=>');
    if (arrow < 0) continue;
    out.push({ channel: m[1], returns: m[2].slice(arrow + 2).replace(/;$/, '').trim() });
  }
  return out;
}

describe('the IPC seam and credentials', () => {
  it('no channel returns anything credential-shaped', () => {
    const offenders = returnTypes()
      .filter((e) => FORBIDDEN.test(e.returns))
      .map((e) => `${e.channel} => ${e.returns}`);
    expect(
      offenders,
      'These IPC channels return a credential-shaped type:\n  ' +
        offenders.join('\n  ') +
        '\nSecrets are resolved in main and posted straight to the connection host. ' +
        'The renderer must never be able to read one back.',
    ).toEqual([]);
  });

  it('there is a setter and no getter', () => {
    const channels = returnTypes().map((e) => e.channel);
    expect(channels).toContain('conn:setSecret');
    expect(channels.filter((c) => /^conn:(get|read|reveal)Secret$/.test(c))).toEqual([]);
  });

  it('the parser actually found the map', () => {
    expect(returnTypes().length).toBeGreaterThan(10);
  });
});
