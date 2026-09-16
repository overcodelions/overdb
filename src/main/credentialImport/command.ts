// Run a command; its stdout is the password.
//
// This is the source that makes overdb work with the secret manager we
// have never heard of. Vault, AWS Secrets Manager, `pass`, `gopass`,
// `gcloud secrets versions access`, `security find-generic-password`, or
// the three-line wrapper script your platform team wrote — all of them are
// "a command that prints a secret", and one code path covers every one.
//
// Three rules, and they are the security posture of the feature:
//
//   1. **No shell, ever.** argv in, spawn out. A stored command line that
//      goes through `sh -c` turns a synced settings file into remote code
//      execution; argv has nothing to interpret. See src/shared/argv.ts,
//      which refuses shell syntax at the point of entry rather than
//      passing it through as a literal argument nobody expected.
//   2. **A hard timeout.** A credential helper that waits on a locked
//      vault, a TouchID prompt nobody sees, or a dead network would
//      otherwise hang the connection attempt forever with no way to cancel.
//   3. **A capped read.** Pointed at the wrong file, `cat` on a 2GB blob
//      must not be a memory exhaustion bug in the main process.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { expandHome } from '../../shared/argv';

const TIMEOUT_MS = 20_000;
/// Generous for a password, tiny for anything that isn't one.
const MAX_OUTPUT = 64 * 1024;

export type SecretResult = { ok: true; value: string } | { ok: false; error: string };

/// The PATH a GUI app gets is not the PATH your shell gets.
///
/// Launched from the Dock, a macOS app inherits a minimal
/// `/usr/bin:/bin:/usr/sbin:/sbin` — so `op`, `vault` and `aws` are all
/// missing, and the failure ("spawn vault ENOENT") reads as though the tool
/// is not installed. Adding the standard package-manager directories makes
/// the Dock and the terminal behave the same way, which is the behaviour
/// everyone already assumes.
///
/// None of that holds on Windows, where PATH is `;`-separated and every
/// entry contains a colon of its own. Splitting `C:\Windows;C:\Windows\System32`
/// on `:` shreds a working PATH into nonsense, so there we hand the
/// environment back untouched.
export function execEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === 'win32') return { ...env };
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/bin`,
    '/opt/local/bin',
  ];
  const current = (env.PATH ?? '').split(':').filter(Boolean);
  const merged = [...current];
  for (const dir of extra) if (!merged.includes(dir)) merged.push(dir);
  return { ...env, PATH: merged.join(':') };
}

export function runSecretCommand(argv: string[], timeoutMs = TIMEOUT_MS): Promise<SecretResult> {
  if (!argv.length || !argv[0].trim()) {
    return Promise.resolve({ ok: false, error: 'No command is configured.' });
  }
  const [bin, ...args] = argv;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: SecretResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // `shell: false` is the default and is stated anyway: this is the line
    // whose accidental change would be the whole vulnerability.
    const child = spawn(expandHome(bin.trim(), os.homedir()), args, {
      env: execEnv(),
      shell: false,
      // A helper that decides to read from a terminal should see EOF
      // immediately rather than blocking until the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let overflowed = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // SIGTERM is a request. A helper wedged on a prompt may ignore it.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
      done({
        ok: false,
        error: `The command did not finish within ${Math.round(timeoutMs / 1000)}s — it may be waiting for input overdb cannot answer.`,
      });
    }, timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length > MAX_OUTPUT) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += b.toString('utf-8');
    });
    // Capped hard: stderr is a diagnostic here, and a tool that decides to
    // narrate at length must not become the memory profile of this process.
    // Note that it is shown to the user on failure and cannot be redacted:
    // overdb does not know the secret when the command failed to produce
    // one. A helper that echoes credentials to stderr will echo them here.
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 4_000) stderr += b.toString('utf-8');
    });

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done({
        ok: false,
        error:
          code === 'ENOENT'
            ? `${bin} was not found on PATH. A GUI app does not inherit your shell's PATH — give the full path to the program if it lives somewhere unusual.`
            : code === 'EACCES'
              ? `${bin} is not executable.`
              : `Could not run ${bin}: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (overflowed) {
        return done({ ok: false, error: 'The command printed more than 64KB. That is not a password — check what it points at.' });
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
        return done({
          ok: false,
          error: `${bin} exited with status ${code ?? '?'}${detail ? `: ${detail}` : '.'}`,
        });
      }
      // Trailing newline only. Leading and inner whitespace can be part of
      // a password, and eating it would produce a credential that is
      // subtly, unfixably wrong.
      const value = stdout.replace(/\r?\n$/, '');
      if (!value) {
        return done({ ok: false, error: `${bin} succeeded but printed nothing.` });
      }
      done({ ok: true, value });
    });
  });
}
