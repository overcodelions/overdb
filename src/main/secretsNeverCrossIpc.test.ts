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
import { CHANNELS } from './ipcInvokeMapKeys';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN = /password|secret|token|credential|connectionString|ConnectSpec/i;
/// `hasPassword` / `hasSecret` are the sanctioned shape: a boolean saying a
/// value exists, never the value itself. Strip them before testing FORBIDDEN
/// so the presence flag this whole file exists to require doesn't trip the
/// check meant to catch the value it replaces. Matched against the FULL
/// declaration (name AND `: boolean`), not just the identifier — stripping
/// the name alone would leave `: string;` behind and pass a channel that
/// renamed an actual password to `hasPassword: string`.
const ALLOWED_FLAG = /\bhas(Password|Secret)\s*\??\s*:\s*boolean/g;

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

/// Each entry is `'channel': (args) => Return;`. The return type can span
/// multiple lines (an inline object, a generic), so this brace-matches
/// rather than looking at one line at a time — a line-by-line reader checks
/// only the first line of a multi-line return type, which for an object
/// literal is bare `{`.
function returnTypes(): Array<{ channel: string; returns: string }> {
  const body = invokeMapBody();
  const out: Array<{ channel: string; returns: string }> = [];
  const entryRe = /['"]([^'"]+)['"]\s*:\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body))) {
    const channel = m[1];
    // Walk forward from the args list's opening paren to its matching
    // close, tracking `()`/`{}`/`<>` depth, then find the `=>` right after.
    let i = entryRe.lastIndex - 1;
    let depth = 0;
    let arrowAt = -1;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(' || ch === '{' || ch === '<') depth += 1;
      else if (ch === ')' || ch === '}' || ch === '>') depth -= 1;
      if (depth === 0 && ch === '=' && body[i + 1] === '>') {
        arrowAt = i;
        break;
      }
    }
    if (arrowAt < 0) continue;
    // Capture the return type forward from the arrow, tracking the same
    // depth, until a `;` at depth 0 — the entry terminator.
    let d = 0;
    let end = -1;
    for (let j = arrowAt + 2; j < body.length; j++) {
      const ch = body[j];
      if (ch === '{' || ch === '(' || ch === '<') d += 1;
      else if (ch === '}' || ch === ')' || ch === '>') d -= 1;
      else if (ch === ';' && d === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    out.push({ channel, returns: body.slice(arrowAt + 2, end).trim() });
    entryRe.lastIndex = end;
  }
  return out;
}

describe('the IPC seam and credentials', () => {
  it('no channel returns anything credential-shaped', () => {
    const offenders = returnTypes()
      .filter((e) => FORBIDDEN.test(e.returns.replace(ALLOWED_FLAG, '')))
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

  it('the parser sees every channel the contract test sees', () => {
    expect(returnTypes().map((e) => e.channel).sort()).toEqual(Object.keys(CHANNELS).sort());
  });
});
