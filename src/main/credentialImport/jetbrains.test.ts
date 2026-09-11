import { describe, expect, it } from 'vitest';
import { envForGroup } from './jetbrains';

describe('envForGroup', () => {
  it('files a sandbox as a sandbox, not as dev', () => {
    // Three real connections that all landed under DEV before sandbox was
    // its own tier.
    expect(envForGroup(undefined, 'Redshift - @Sbox')).toBe('sandbox');
    expect(envForGroup(undefined, 'Redshift - @Sbox [detailed]')).toBe('sandbox');
    expect(envForGroup(undefined, 'Sandbox Acme')).toBe('sandbox');
  });

  it('still recognises the other tiers', () => {
    expect(envForGroup(undefined, 'Acme @Prod [EU]')).toBe('prod');
    expect(envForGroup('Staging', 'stg.rds.eng.example.com')).toBe('staging');
    expect(envForGroup(undefined, 'localhost')).toBe('local');
    expect(envForGroup(undefined, 'dev box')).toBe('dev');
  });

  it('prefers the more specific tier when a name carries two', () => {
    // Production wins over everything: filing a prod connection anywhere
    // else is the one mistake with consequences.
    expect(envForGroup('Production', 'sandbox mirror')).toBe('prod');
    expect(envForGroup(undefined, 'staging sandbox')).toBe('staging');
  });

  it('falls back to other rather than guessing', () => {
    expect(envForGroup(undefined, 'reporting')).toBe('other');
  });
});
