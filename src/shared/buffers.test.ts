import { describe, expect, it } from 'vitest';
import {
  bufferKey,
  bufferLabel,
  buffersFor,
  nextBufferKey,
  ownsBuffer,
  relocate,
} from './buffers';

const C = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';

describe('buffersFor', () => {
  it('gives a connection one tab even when it has never been typed into', () => {
    expect(buffersFor(C, {})).toEqual([C]);
  });

  it('orders extras numerically, not lexically', () => {
    // '10' sorts before '2' as a string, which would put tab 10 second.
    const buffers = { [C]: '', [bufferKey(C, 10)]: '', [bufferKey(C, 2)]: '' };
    expect(buffersFor(C, buffers)).toEqual([C, bufferKey(C, 2), bufferKey(C, 10)]);
  });

  it('does not pick up another connection tabs', () => {
    const buffers = { [C]: '', [bufferKey(OTHER, 1)]: '' };
    expect(buffersFor(C, buffers)).toEqual([C]);
  });
});

describe('nextBufferKey', () => {
  it('goes past the highest in use rather than counting tabs', () => {
    // Tab 2 closed, tab 3 still open: reusing 2 would be fine, but reusing
    // 3 would silently adopt an open tab's text.
    const buffers = { [C]: '', [bufferKey(C, 3)]: '' };
    expect(nextBufferKey(C, buffers)).toBe(bufferKey(C, 4));
  });

  it('starts at 1 for a connection with only its base buffer', () => {
    expect(nextBufferKey(C, { [C]: 'select 1' })).toBe(bufferKey(C, 1));
  });
});

describe('ownsBuffer', () => {
  it('claims the base key and every suffix', () => {
    expect(ownsBuffer(C, C)).toBe(true);
    expect(ownsBuffer(C, bufferKey(C, 7))).toBe(true);
    expect(ownsBuffer(C, OTHER)).toBe(false);
  });
});

describe('bufferLabel', () => {
  it('names a tab by what it does and to what', () => {
    expect(bufferLabel('select * from acme.partner where x = 1')).toBe('select acme.partner');
    expect(bufferLabel('DELETE FROM flyway_schema_history')).toBe('delete flyway_schema_history');
  });

  it('looks past a leading comment', () => {
    // The comment is the question that produced the query, so every
    // translated tab would otherwise be called "find".
    expect(bufferLabel('-- find me the clients\nselect * from client')).toBe('select client');
  });

  it('says so when there is nothing in it', () => {
    expect(bufferLabel('   ')).toBe('Empty');
    expect(bufferLabel('-- just a note\n')).toBe('Empty');
  });
});

describe('relocate', () => {
  const text = 'select 1;\nselect 2;\n';

  it('keeps the offsets when the text has not moved', () => {
    expect(relocate(text, { from: 10, to: 19, was: 'select 2;' })).toEqual({ from: 10, to: 19 });
  });

  it('follows the text when an edit above it shifted everything down', () => {
    // Typing a comment on line one is enough to make every offset below it
    // wrong, and a translation in flight was measured before you typed it.
    const edited = '-- note\n' + text;
    expect(relocate(edited, { from: 10, to: 19, was: 'select 2;' })).toEqual({
      from: 18,
      to: 27,
    });
  });

  it('refuses when the text it was asked about is gone', () => {
    expect(relocate('select 3;', { from: 0, to: 9, was: 'select 2;' })).toBeNull();
  });

  it('refuses when the text moved and now appears more than once', () => {
    // Two candidates means no way to tell which one was asked about, and
    // replacing either is a coin flip with someone's editor. The offsets
    // themselves still win when they hold — a duplicate elsewhere in the
    // buffer is not a reason to distrust a span that never moved.
    const twice = '-- note\n' + text + 'select 2;';
    expect(relocate(twice, { from: 10, to: 19, was: 'select 2;' })).toBeNull();
  });
});
