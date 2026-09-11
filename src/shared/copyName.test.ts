import { describe, expect, it } from 'vitest';
import { copyName } from './copyName';

describe('copyName', () => {
  it('appends "copy" when nothing is in the way', () => {
    expect(copyName('redshift - @sbox', [])).toBe('redshift - @sbox copy');
  });

  it('numbers from 2 once the plain copy is taken', () => {
    const taken = ['acme', 'acme copy'];
    expect(copyName('acme', taken)).toBe('acme copy 2');
    expect(copyName('acme', [...taken, 'acme copy 2'])).toBe('acme copy 3');
  });

  it('fills a gap rather than always taking the highest', () => {
    expect(copyName('acme', ['acme copy', 'acme copy 3'])).toBe('acme copy 2');
  });

  it('copies a copy from the original name, not "copy copy"', () => {
    expect(copyName('acme copy', ['acme copy'])).toBe('acme copy 2');
    expect(copyName('acme copy 2', ['acme copy', 'acme copy 2'])).toBe('acme copy 3');
  });

  it('treats case as distinct — the sidebar shows both', () => {
    expect(copyName('Acme', ['acme copy'])).toBe('Acme copy');
  });
});
