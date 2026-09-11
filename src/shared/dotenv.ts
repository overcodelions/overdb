// Reading a variable out of a `.env` file.
//
// The environment-variable source has one honest weakness, and the note in
// the connection form admits it: a GUI app launched from the Dock does not
// inherit your shell profile, so `$PGPASSWORD` is set for your terminal and
// not for overdb. Pointing at the file the value actually lives in fixes
// that without copying the secret anywhere.
//
// Deliberately a small parser rather than a dependency. It handles what
// `.env` files in the wild contain — `export`, quotes, `#` comments — and
// stops well short of dotenv's variable interpolation, which would mean
// evaluating the file rather than reading it.

/// Parse `.env` text. Later definitions win, matching every other reader.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(body.slice(eq + 1).trim());
  }
  return out;
}

/// Quoted values keep everything inside the quotes, including the `#` that
/// would otherwise start a comment and the spaces a trim would eat.
/// Unquoted values stop at an unescaped `#`, which is where every other
/// reader stops too.
function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}
