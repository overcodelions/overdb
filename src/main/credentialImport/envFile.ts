// One variable, read out of a `.env` file at connect time.
//
// The environment source is honest about its weakness — a Dock launch does
// not inherit your shell — and this is the fix that does not involve
// copying the secret anywhere: point at the file it already lives in.
//
// Only the path is stored. The file is read here, in main, once per
// connection attempt, and the value goes straight into a ConnectSpec.
// Nothing is cached: rotating the file rotates the credential, which is the
// whole reason to prefer this over pasting the value into the keychain.

import fs from 'node:fs';
import os from 'node:os';
import { parseDotenv } from '../../shared/dotenv';
import { expandHome } from '../../shared/argv';

/// Enough for any .env; small enough that pointing this at a database dump
/// fails fast instead of reading it into memory.
const MAX_BYTES = 512 * 1024;

export type EnvFileResult = { ok: true; value: string } | { ok: false; error: string };

export function readEnvFileVar(filePath: string, variable: string): EnvFileResult {
  const resolved = expandHome(filePath.trim(), os.homedir());
  if (!variable.trim()) return { ok: false, error: 'No variable name is set.' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'ENOENT'
          ? `There is no file at ${resolved}.`
          : `Could not open ${resolved}: ${code ?? 'unknown error'}.`,
    };
  }
  if (stat.isDirectory()) return { ok: false, error: `${resolved} is a directory.` };
  if (stat.size > MAX_BYTES) {
    return { ok: false, error: `${resolved} is larger than 512KB — that is not an env file.` };
  }

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'EACCES'
          ? `overdb is not allowed to read ${resolved}.`
          : `Could not read ${resolved}.`,
    };
  }

  const value = parseDotenv(text)[variable.trim()];
  // The name is safe to echo; the value is never in any message from here.
  if (value === undefined) return { ok: false, error: `${variable} is not defined in ${resolved}.` };
  if (value === '') return { ok: false, error: `${variable} is defined in ${resolved} but empty.` };
  return { ok: true, value };
}
