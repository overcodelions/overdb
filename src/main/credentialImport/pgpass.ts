// ~/.pgpass — the one import source that legitimately carries passwords.
//
// It is the user's own file, in a documented format, created for exactly
// this purpose. Reading another application's keychain entries would be a
// different matter; reading this is what libpq itself does.
//
// libpq refuses a .pgpass that is group- or world-readable, and so does
// this. Silently reading a file the database's own client would reject
// would be teaching the user that the permission does not matter.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PgpassEntry {
  host: string;
  port: number | null;
  database: string;
  user: string;
  password: string;
  /// True where the field was the `*` wildcard, so the UI can ask rather
  /// than inventing a hostname.
  wildcard: { host: boolean; port: boolean; database: boolean; user: boolean };
}

/// Fields are colon-separated; a literal colon or backslash inside a field
/// is backslash-escaped. Splitting on /:/ corrupts any password containing
/// a colon, which is not rare.
export function splitPgpassLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i += 1;
      continue;
    }
    if (ch === ':') {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

export function parsePgpass(text: string): PgpassEntry[] {
  const out: PgpassEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = splitPgpassLine(line);
    if (f.length < 5) continue;
    const [host, port, database, user, ...rest] = f;
    out.push({
      host,
      port: port === '*' ? null : Number(port) || null,
      database,
      user,
      // Re-join the tail: a password may itself have contained separators
      // that survived escaping.
      password: rest.join(':'),
      wildcard: { host: host === '*', port: port === '*', database: database === '*', user: user === '*' },
    });
  }
  return out;
}

export type PgpassResult =
  | { ok: true; entries: PgpassEntry[]; path: string }
  | { ok: false; reason: string };

export function readPgpass(
  file = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? os.homedir(), 'postgresql', 'pgpass.conf')
    : path.join(os.homedir(), '.pgpass'),
): PgpassResult {
  // The permission gate and the read must be about the same file. Checking
  // the path's mode and then reading the path again lets a 0644 file be
  // swapped in after the check passed (CodeQL js/file-system-race), so the
  // mode is taken from the descriptor that is then read.
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { ok: false, reason: 'No ~/.pgpass found.' };
  }
  try {
    // 0600 exactly, as libpq requires. Node reports 0o666 on Windows
    // regardless of ACLs, so the mode gate does not apply there.
    const mode = fs.fstatSync(fd).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077)) {
      return {
        ok: false,
        reason: `~/.pgpass is mode ${mode.toString(8)} — libpq ignores it unless it is 0600. Fix with: chmod 600 ~/.pgpass`,
      };
    }
    return { ok: true, entries: parsePgpass(fs.readFileSync(fd, 'utf-8')), path: file };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.closeSync(fd);
  }
}
