import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envForGroup, scanJetBrainsProjects } from './jetbrains';

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

describe('scanJetBrainsProjects', () => {
  it('finds a nested .idea/dataSources.xml without blocking synchronously', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overdb-jetbrains-'));
    try {
      const dir = path.join(root, 'service-a', '.idea');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'dataSources.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <project version="4">
          <component name="DataSourceManagerImpl">
            <data-source uuid="u1" name="orders">
              <jdbc-url>jdbc:postgresql://localhost:5432/orders</jdbc-url>
            </data-source>
          </component>
        </project>`,
      );

      const pending = scanJetBrainsProjects(root);
      // The walk is async now: the promise must not already carry a
      // resolved value on the same tick it was created.
      expect(pending).toBeInstanceOf(Promise);

      const candidates = await pending;
      expect(candidates.map((c) => c.name)).toEqual(['orders']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
