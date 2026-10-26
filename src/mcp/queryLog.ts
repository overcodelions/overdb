// One JSON line per agent call, appended to a file that never grows past a
// size. Both servers keep one: the headless server when asked
// (`--query-log`), the app's `serve --mcp` always, in its userData folder,
// so the app can show what agents did (src/main/agentActivity.ts).
//
// Electron-free: the headless entry reaches this file.

import fs from 'node:fs';
import path from 'node:path';

/// A log past this is moved to FILE.1 and started again.
export const QUERY_LOG_MAX_BYTES = 5 * 1024 * 1024;

/// Throws when the line can't be written; the caller decides who hears.
export function appendLogLine(file: string, value: unknown, maxBytes = QUERY_LOG_MAX_BYTES): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Everything after the open goes through the open file, never back to
  // the path: a path checked and then used may name another file by the
  // time it is used. So a full log is copied aside and emptied in place
  // rather than renamed. A line another run appends between the copy and
  // the truncate is lost — once per maxBytes, at worst.
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > maxBytes) {
      const full = Buffer.alloc(size);
      fs.readSync(fd, full, 0, size, 0);
      fs.writeFileSync(`${file}.1`, full, { mode: 0o600 });
      fs.ftruncateSync(fd, 0);
    }
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/// The last `limit` lines of the log, newest first. Reads only the tail, so
/// a full log costs the same as a short one. A line cut by the read, or
/// half-written by a server that is appending right now, is skipped.
export function readLogTail<T>(file: string, limit: number, tailBytes = 512 * 1024): T[] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    const out: T[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i].trim()) continue;
      try {
        out.push(JSON.parse(lines[i]) as T);
      } catch {
        // partial line
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
