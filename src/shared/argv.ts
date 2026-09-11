// Turning a typed command line into an argv array, and back.
//
// The reason this exists rather than a `shell: true` spawn is the whole
// security posture of the "run a command for the password" source. A shell
// string is stored in a file the user edits, arrives from an import, or is
// pasted from a wiki — and running it through `sh -c` means every one of
// those paths is arbitrary code execution with a pipeline, a redirect and a
// `$(...)` in it. So overdb stores argv, spawns argv, and never has a shell
// in the picture at all.
//
// The cost of that choice is that shell syntax silently stops working:
// `vault kv get -field=x secret/db | tr -d '\n'` would pass `|` and `tr` to
// vault as arguments. Silently doing the wrong thing is worse than
// refusing, so metacharacters are rejected with a sentence saying why.

/// Characters that mean something to a shell and nothing to us. `~` is
/// deliberately absent: it is common in paths and expanding it ourselves
/// (see expandHome) is both safe and expected.
const SHELL_METACHARACTERS = /[|&;<>()$`\\!\n\r*?{}[\]]/;

export interface ArgvParse {
  ok: true;
  argv: string[];
}

export interface ArgvError {
  ok: false;
  error: string;
}

/// Split a command line the way a shell would, minus everything a shell
/// does beyond splitting. Quotes group; nothing expands.
export function parseArgv(input: string): ArgvParse | ArgvError {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Nothing to run.' };

  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    // Outside quotes, shell syntax is a mistake rather than a feature: we
    // do not run a shell, so it would be passed through as a literal
    // argument and the user would be debugging a very confusing error.
    if (SHELL_METACHARACTERS.test(ch)) {
      return {
        ok: false,
        error:
          `\`${ch}\` is shell syntax, and overdb runs the command directly rather than through a shell — ` +
          'nothing here would interpret it. Wrap it in quotes to pass it as a literal argument, or put ' +
          'the pipeline in a script and name the script here.',
      };
    }
    current += ch;
    started = true;
  }

  if (quote) return { ok: false, error: `Unclosed ${quote === '"' ? 'double' : 'single'} quote.` };
  if (started) argv.push(current);
  if (argv.length === 0) return { ok: false, error: 'Nothing to run.' };
  return { ok: true, argv };
}

/// argv back to something a person reads, for redisplaying a saved
/// command in the form. Not a shell-safe quoting routine — nothing ever
/// feeds this back to a shell — just readable.
export function formatArgv(argv: string[]): string {
  return argv
    .map((a) => (a === '' ? "''" : /[ \t"']/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(' ');
}

/// `~` at the start of a path, which is the one shell expansion worth
/// doing ourselves: every credential helper lives at a path someone writes
/// with a tilde, and `~/bin/db-password` failing with ENOENT teaches
/// nothing.
export function expandHome(value: string, home: string | undefined): string {
  if (!home) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return home + value.slice(1);
  return value;
}
