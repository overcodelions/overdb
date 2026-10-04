import { describe, expect, it } from 'vitest';

describe('masking secrets in a failed statement', async () => {
  const { redactSecrets } = await import('./index');
  it.each([
    ["CREATE USER 'app'@'%' IDENTIFIED BY 's3cr\\'et'", "CREATE USER 'app'@'%' IDENTIFIED BY '…'"],
    ["CREATE USER 'a'@'%' IDENTIFIED WITH mysql_native_password AS '*ABC'", "CREATE USER 'a'@'%' IDENTIFIED WITH mysql_native_password AS '…'"],
    ["CREATE USER 'a'@'%' IDENTIFIED BY PASSWORD '*ABC'", "CREATE USER 'a'@'%' IDENTIFIED BY PASSWORD '…'"],
    ["CREATE USER 'a'@'%' IDENTIFIED VIA mysql_native_password USING '*ABC'", "CREATE USER 'a'@'%' IDENTIFIED VIA mysql_native_password USING '…'"],
    ["SET PASSWORD FOR 'a'@'%' = PASSWORD('x')", "SET PASSWORD FOR 'a'@'%' = PASSWORD('…')"],
  ])('%s', (sql, out) => expect(redactSecrets(sql)).toBe(out));
  it('leaves other statements alone', () => {
    expect(redactSecrets("SELECT * FROM t WHERE name = 'by'")).toBe("SELECT * FROM t WHERE name = 'by'");
  });
});
