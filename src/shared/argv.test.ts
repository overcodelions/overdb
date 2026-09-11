import { describe, expect, it } from 'vitest';
import { expandHome, formatArgv, parseArgv } from './argv';

describe('parseArgv', () => {
  it('splits on whitespace', () => {
    expect(parseArgv('vault kv get -field=password secret/db')).toEqual({
      ok: true,
      argv: ['vault', 'kv', 'get', '-field=password', 'secret/db'],
    });
  });

  it('keeps quoted groups together', () => {
    expect(parseArgv(`security find-generic-password -s "My DB" -w`)).toEqual({
      ok: true,
      argv: ['security', 'find-generic-password', '-s', 'My DB', '-w'],
    });
    expect(parseArgv(`aws --query 'SecretString'`)).toEqual({
      ok: true,
      argv: ['aws', '--query', 'SecretString'],
    });
  });

  it('keeps an explicitly empty argument', () => {
    const r = parseArgv(`helper "" --flag`);
    expect(r.ok && r.argv).toEqual(['helper', '', '--flag']);
  });

  // The security property this module exists for. Nothing runs a shell, so
  // a pipeline would be passed to the first program as literal arguments —
  // silently doing something else. Refusing is the only honest answer.
  it.each(['a | b', 'a > out', 'a && b', 'a; b', 'echo $(id)', 'echo `id`', 'a & b'])(
    'refuses shell syntax: %s',
    (input) => {
      const r = parseArgv(input);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/shell/i);
    },
  );

  it('allows shell characters inside quotes, as literals', () => {
    const r = parseArgv(`helper --filter "a|b"`);
    expect(r.ok && r.argv).toEqual(['helper', '--filter', 'a|b']);
  });

  it('rejects an unclosed quote rather than guessing', () => {
    const r = parseArgv(`helper "unterminated`);
    expect(r.ok).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(parseArgv('   ').ok).toBe(false);
  });
});

describe('formatArgv', () => {
  it('round-trips through parseArgv', () => {
    const argv = ['vault', 'kv', 'get', '-field=password', 'a b', ''];
    const parsed = parseArgv(formatArgv(argv));
    expect(parsed.ok && parsed.argv).toEqual(argv);
  });
});

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~/bin/pw', '/Users/me')).toBe('/Users/me/bin/pw');
    expect(expandHome('~', '/Users/me')).toBe('/Users/me');
    // Not a home reference: `~foo` means another user's home to a shell,
    // and guessing at it would produce a path that does not exist.
    expect(expandHome('~other/bin', '/Users/me')).toBe('~other/bin');
    expect(expandHome('/usr/bin/pw', '/Users/me')).toBe('/usr/bin/pw');
  });
});
