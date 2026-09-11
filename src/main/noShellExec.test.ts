// overdb runs external programs, and never a shell.
//
// Three features now spawn something: the 1Password CLI, the credential
// command, and `ssh` for a tunnel. All three take their arguments from a
// connection record — a file that can be hand-edited, synced between
// machines, or filled in by an import. The moment any of them goes through
// `sh -c`, that file becomes arbitrary code execution, and the difference
// is one option object nobody would notice in review.
//
// So it is asserted rather than remembered. This reads the source and fails
// on the shape of the mistake, not on its effect: `shell: true`, the exec
// family, and a stored command that has quietly become a string again.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/// Comments out. This file's own subject matter is discussed in prose all
/// over the codebase — including in the module written to avoid it — and a
/// scanner that cannot tell an explanation from an instruction fails on the
/// documentation rather than on the defect.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ file: path.relative(ROOT, full), text: code(fs.readFileSync(full, 'utf-8')) });
      }
    }
  };
  walk(SRC);
  return out;
}

describe('external programs', () => {
  it('are never run through a shell', () => {
    const offenders = sources()
      .filter((s) => /shell\s*:\s*true/.test(s.text))
      .map((s) => s.file);
    expect(
      offenders,
      'These files spawn with a shell. Every command overdb runs comes from a connection record, ' +
        'so a shell there turns an editable config into remote code execution:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('are spawned, never exec’d', () => {
    // `exec` and `execSync` ARE the shell — they run their argument through
    // /bin/sh by definition, with no option to say otherwise.
    const offenders: string[] = [];
    for (const s of sources()) {
      const imports = [...s.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)];
      for (const m of imports) {
        const named = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim());
        for (const name of named) {
          if (name && !['spawn', 'spawnSync', 'ChildProcess', 'type ChildProcess'].includes(name)) {
            offenders.push(`${s.file}: ${name}`);
          }
        }
      }
    }
    expect(
      offenders,
      'Only spawn (which takes argv) may be imported from child_process. exec and execSync run ' +
        'their argument through /bin/sh:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('take their arguments as argv, in the stored shape too', () => {
    // A `secretArgv: string` would typecheck at every call site and quietly
    // reintroduce the split-a-string-somewhere problem this design avoids.
    const types = fs.readFileSync(path.join(SRC, 'shared', 'types.ts'), 'utf-8');
    expect(types).toMatch(/secretArgv\?:\s*string\[\]/);
  });
});
