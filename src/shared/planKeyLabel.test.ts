import { describe, expect, it } from 'vitest';
import { keyLabel } from './plan';

describe('keyLabel', () => {
  it('names MySQL auto-generated temp-table indexes for what they are', () => {
    // These are not indexes anyone can look up in the schema, and printed
    // raw beside an alias they read as one.
    expect(keyLabel('<auto_key0>')).toBe('index built on the fly');
    expect(keyLabel('<auto_key>')).toBe('index built on the fly');
    expect(keyLabel('<auto_distinct_key>')).toBe('index built on the fly');
  });

  it('leaves a real index name exactly as the server said it', () => {
    expect(keyLabel('PRIMARY')).toBe('PRIMARY');
    expect(keyLabel('uq_partner_partner_id')).toBe('uq_partner_partner_id');
    // Not every angle-bracketed name is generated.
    expect(keyLabel('<union1,2>')).toBe('<union1,2>');
  });
});
