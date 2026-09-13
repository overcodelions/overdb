/// Driver errors carry stack noise and, on Postgres and MySQL, sometimes
/// echo connection parameters. Main scrubs known secret values on top of
/// this; here we just trim to the message.
///
/// The fallbacks are not defensive padding. mysql2 throws errors whose
/// `message` is empty and whose meaning lives in `code` and `errno`, and
/// an empty string is the one answer this must never give: it crosses the
/// wire, becomes `new Error('')` in main, and reaches the user as the
/// literal word "Error" — which says nothing, and looks like a bug in
/// overdb rather than a server that would not let it in.
export function cleanError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    // mysql2's shape. `sqlMessage` is the server's own words, which beat
    // anything reconstructed from a code.
    const driver = err as Error & {
      sqlMessage?: string;
      code?: string | number;
      errno?: number;
      syscall?: string;
      address?: string;
      port?: number;
    };
    if (driver.sqlMessage) return driver.sqlMessage;
    if (driver.code) {
      // `connect ECONNREFUSED 127.0.0.1:3306` is the shape node itself
      // uses, and it is the difference between "Error" and knowing the
      // server is not listening.
      const where = driver.address
        ? ` ${driver.address}${driver.port ? `:${driver.port}` : ''}`
        : '';
      return `${driver.syscall ? `${driver.syscall} ` : ''}${driver.code}${where}`;
    }
    if (driver.errno !== undefined) return `${err.name || 'Error'} ${driver.errno}`;
    return err.name || 'The driver failed without saying why.';
  }
  const text = String(err);
  return text === '' || text === '[object Object]'
    ? 'The driver failed without saying why.'
    : text;
}
