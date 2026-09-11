import { describe, expect, it } from 'vitest';
import { parseDotenv } from './dotenv';

describe('parseDotenv', () => {
  it('reads plain assignments', () => {
    expect(parseDotenv('PGPASSWORD=hunter2\nDB_HOST=localhost')).toEqual({
      PGPASSWORD: 'hunter2',
      DB_HOST: 'localhost',
    });
  });

  it('handles the export prefix', () => {
    expect(parseDotenv('export PGPASSWORD=hunter2')).toEqual({ PGPASSWORD: 'hunter2' });
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# a note\n\n  \nA=1')).toEqual({ A: '1' });
  });

  // A password with a `#` in it is not rare, and a parser that treats the
  // quoted one as a comment hands back a credential that is quietly wrong.
  it('keeps a hash inside quotes and drops a trailing comment outside them', () => {
    expect(parseDotenv('A="pa#ss"')).toEqual({ A: 'pa#ss' });
    expect(parseDotenv('A=value # trailing')).toEqual({ A: 'value' });
    expect(parseDotenv('A=pa#ss')).toEqual({ A: 'pa#ss' });
  });

  it('unescapes only inside double quotes', () => {
    expect(parseDotenv('A="line\\nbreak"')).toEqual({ A: 'line\nbreak' });
    expect(parseDotenv("A='line\\nbreak'")).toEqual({ A: 'line\\nbreak' });
  });

  it('keeps spaces that quotes protect', () => {
    expect(parseDotenv('A=" padded "')).toEqual({ A: ' padded ' });
    expect(parseDotenv('A= unpadded ')).toEqual({ A: 'unpadded' });
  });

  it('does not interpolate — a $VAR is a literal', () => {
    expect(parseDotenv('A=$OTHER')).toEqual({ A: '$OTHER' });
  });

  it('ignores lines that are not assignments to a valid name', () => {
    expect(parseDotenv('not an assignment\n9BAD=1\n=novalue\nOK=1')).toEqual({ OK: '1' });
  });

  it('lets a later definition win, as every other reader does', () => {
    expect(parseDotenv('A=1\nA=2')).toEqual({ A: '2' });
  });
});
