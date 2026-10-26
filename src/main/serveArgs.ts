// Whether this launch is `overdb serve --mcp` rather than the app.
//
// argv[0] is the binary and, in a dev run, argv[1] is the app folder (`.`),
// so the command is found rather than read from a fixed position. Electron-
// free, for the test.

export function isServeMcp(argv: readonly string[]): boolean {
  const at = argv.indexOf('serve');
  return at >= 0 && argv.slice(at + 1).includes('--mcp');
}
