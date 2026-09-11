// Resolve `op://vault/item/field` references through the 1Password CLI.
//
// The point of supporting this is that the secret never enters overdb's
// store: we keep the reference and ask `op` for the value at connect time,
// using whatever session the user already has. Rotate the item in
// 1Password and the connection follows, with nothing to update here.
//
// Modelled on overgit's CLI probing (src/main/cli.ts): check the binary
// exists before offering the option, and cap the call so a locked vault
// waiting on a prompt can't hang a connection attempt forever.

import { spawn } from 'node:child_process';
import { execEnv } from './command';

const OP_TIMEOUT_MS = 20_000;

export function probeOp(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('op', ['--version'], { env: execEnv() });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

export function isOpReference(value: string): boolean {
  return /^op:\/\/[^/]+\/[^/]+\/.+/.test(value.trim());
}

export function readOpSecret(reference: string): Promise<
  { ok: true; value: string } | { ok: false; error: string }
> {
  if (!isOpReference(reference)) {
    return Promise.resolve({
      ok: false,
      error: 'Not a 1Password reference. Expected op://vault/item/field.',
    });
  }
  return new Promise((resolve) => {
    const child = spawn('op', ['read', reference.trim()], { env: execEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: { ok: true; value: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ ok: false, error: '`op read` took longer than 20s — is the vault locked?' });
    }, OP_TIMEOUT_MS);

    child.stdout.on('data', (b) => (stdout += b.toString('utf-8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
    child.on('error', () =>
      done({ ok: false, error: '`op` is not installed or not on PATH.' }),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) done({ ok: true, value: stdout.replace(/\n$/, '') });
      else done({ ok: false, error: stderr.trim() || `op exited with code ${code}` });
    });
  });
}
