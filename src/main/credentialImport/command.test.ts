import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execEnv, runSecretCommand } from './command';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-cmd-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/// A helper script standing in for `vault` / `op` / your platform team's
/// wrapper. Written rather than mocked: the thing under test is process
/// behaviour, and a mocked spawn would assert nothing about it.
function script(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

// These drive a real child process through `#!/bin/sh` helper scripts,
// which Windows cannot spawn at all (EFTYPE — it has no shebang). The
// behaviour under test is POSIX process behaviour; the Windows path is
// covered by execEnv below.
describe.skipIf(process.platform === 'win32')('runSecretCommand', () => {
  it('takes stdout as the password', async () => {
    const bin = script('ok.sh', 'printf "hunter2"');
    await expect(runSecretCommand([bin])).resolves.toEqual({ ok: true, value: 'hunter2' });
  });

  it('drops the trailing newline every CLI prints, and nothing else', async () => {
    const bin = script('nl.sh', 'printf "hunter2\\n"');
    await expect(runSecretCommand([bin])).resolves.toEqual({ ok: true, value: 'hunter2' });
    // Leading and interior whitespace can be part of a password; eating it
    // would produce a credential that is subtly and unfixably wrong.
    const padded = script('pad.sh', 'printf " hunter 2 \\n"');
    await expect(runSecretCommand([padded])).resolves.toEqual({ ok: true, value: ' hunter 2 ' });
  });

  it('passes arguments through verbatim', async () => {
    const bin = script('args.sh', 'printf "%s" "$2"');
    await expect(runSecretCommand([bin, 'get', 'the-secret'])).resolves.toEqual({
      ok: true,
      value: 'the-secret',
    });
  });

  // The security property. There is no shell, so a metacharacter is just a
  // character in an argument — it cannot start a second command. (The form
  // refuses to store these at all; this asserts the floor beneath that.)
  it('does not interpret shell syntax in an argument', async () => {
    const bin = script('echo.sh', 'printf "%s" "$1"');
    await expect(runSecretCommand([bin, '$(id); rm -rf /'])).resolves.toEqual({
      ok: true,
      value: '$(id); rm -rf /',
    });
  });

  it('reports a non-zero exit with the tool’s own complaint', async () => {
    const bin = script('fail.sh', 'echo "vault: not authenticated" >&2; exit 2');
    const r = await runSecretCommand([bin]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/status 2.*not authenticated/);
  });

  it('says something useful when the program is missing', async () => {
    const r = await runSecretCommand([path.join(dir, 'not-installed')]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/PATH/);
  });

  it('treats success with no output as a failure', async () => {
    const bin = script('quiet.sh', 'exit 0');
    const r = await runSecretCommand([bin]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/printed nothing/);
  });

  // A helper waiting on a locked vault or an unseen prompt would otherwise
  // hang the connection attempt with nothing to cancel.
  it('gives up on a command that hangs', async () => {
    const bin = script('hang.sh', 'sleep 30');
    const r = await runSecretCommand([bin], 300);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/did not finish/);
  });

  it('refuses to read an unbounded amount', async () => {
    const bin = script('flood.sh', 'head -c 200000 /dev/zero | tr "\\0" "x"');
    const r = await runSecretCommand([bin]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/64KB/);
  });

  it('refuses an empty argv', async () => {
    await expect(runSecretCommand([])).resolves.toMatchObject({ ok: false });
  });
});

describe('execEnv', () => {
  // A Dock-launched app gets /usr/bin:/bin:/usr/sbin:/sbin, so `vault` and
  // `op` are missing and the error reads as "not installed".
  it('adds the directories package managers actually use', () => {
    const p = execEnv({ PATH: '/usr/bin:/bin' }, 'darwin').PATH!.split(':');
    expect(p.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(p).toContain('/opt/homebrew/bin');
    expect(p).toContain('/usr/local/bin');
  });

  it('does not duplicate what is already there', () => {
    const p = execEnv({ PATH: '/usr/local/bin' }, 'darwin').PATH!.split(':');
    expect(p.filter((x) => x === '/usr/local/bin')).toHaveLength(1);
  });

  it('leaves the rest of the environment alone', () => {
    expect(execEnv({ PATH: '/bin', HOME: '/Users/me' }, 'darwin').HOME).toBe('/Users/me');
  });

  // On Windows the separator is `;` and every entry has a colon in it, so
  // the POSIX merge would turn `C:\Windows` into two bogus directories.
  it('does not touch a Windows PATH', () => {
    const env = { PATH: 'C:\\Windows;C:\\Windows\\System32', USERNAME: 'me' };
    expect(execEnv(env, 'win32')).toEqual(env);
  });
});
