import { describe, expect, it } from 'vitest';
import { isServeMcp } from './serveArgs';

describe('isServeMcp', () => {
  it('finds the command in a packaged and a dev launch', () => {
    expect(isServeMcp(['/Applications/Overdb.app/Contents/MacOS/Overdb', 'serve', '--mcp'])).toBe(true);
    expect(isServeMcp(['/repo/node_modules/electron/dist/Electron', '.', 'serve', '--mcp'])).toBe(true);
  });

  it('is the app for anything else', () => {
    expect(isServeMcp(['/Applications/Overdb.app/Contents/MacOS/Overdb'])).toBe(false);
    expect(isServeMcp(['Overdb', 'serve'])).toBe(false);
    expect(isServeMcp(['Overdb', '--mcp', 'serve'])).toBe(false);
  });
});
