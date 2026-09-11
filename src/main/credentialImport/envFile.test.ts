import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEnvFileVar } from './envFile';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-env-'));
const envPath = path.join(dir, '.env');
fs.writeFileSync(envPath, 'export PGPASSWORD=hunter2\nEMPTY=\n');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readEnvFileVar', () => {
  it('reads the named variable', () => {
    expect(readEnvFileVar(envPath, 'PGPASSWORD')).toEqual({ ok: true, value: 'hunter2' });
  });

  it('distinguishes missing from empty', () => {
    expect(readEnvFileVar(envPath, 'NOPE')).toMatchObject({ ok: false, error: /is not defined/ });
    expect(readEnvFileVar(envPath, 'EMPTY')).toMatchObject({ ok: false, error: /but empty/ });
  });

  it('names the path when there is no file', () => {
    const missing = path.join(dir, 'absent');
    expect(readEnvFileVar(missing, 'A')).toMatchObject({ ok: false, error: new RegExp(missing) });
  });

  it('refuses a directory and refuses nothing', () => {
    expect(readEnvFileVar(dir, 'A')).toMatchObject({ ok: false, error: /directory/ });
    expect(readEnvFileVar(envPath, '  ')).toMatchObject({ ok: false, error: /variable name/ });
  });

  // Pointed at the wrong thing — a dump, a log — this must fail fast rather
  // than read it into the main process.
  it('refuses a file far too large to be an env file', () => {
    const big = path.join(dir, 'big.env');
    fs.writeFileSync(big, 'A=' + 'x'.repeat(600 * 1024));
    expect(readEnvFileVar(big, 'A')).toMatchObject({ ok: false, error: /512KB/ });
  });
});
