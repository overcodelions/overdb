// Connection URLs sitting in the environment.
//
// Read from overdb's OWN environment, which is worth being precise about: a
// GUI app launched from the Dock does not inherit your shell profile, so
// this finds things when overdb is started from a terminal and finds
// nothing when it isn't. The UI says so rather than leaving you wondering.

import type { Engine } from '../../shared/types';

export interface EnvCandidate {
  variable: string;
  engine: Engine | null;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  hasPassword: boolean;
}

const INTERESTING = /^(DATABASE_URL|.*_DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|PG_URL|MYSQL_URL|JDBC_URL|DB_URL)$/;

const DEFAULT_PORT: Record<string, number> = { postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306 };

export function parseConnectionUrl(value: string): Omit<EnvCandidate, 'variable'> | null {
  const m = /^([a-z0-9+]+):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?(?:\/([^?]*))?/i.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, scheme, user, password, host, port, database] = m;
  const family = scheme.toLowerCase();
  const engine: Engine | null =
    family.startsWith('postgres') ? 'postgres' : family.startsWith('mysql') || family === 'mariadb' ? 'mysql' : null;
  return {
    engine,
    host,
    port: port ? Number(port) : DEFAULT_PORT[family],
    database: database || undefined,
    user,
    hasPassword: !!password,
  };
}

export function scanEnvironment(env: NodeJS.ProcessEnv = process.env): EnvCandidate[] {
  const out: EnvCandidate[] = [];
  for (const [variable, value] of Object.entries(env)) {
    if (!value || !INTERESTING.test(variable)) continue;
    const parsed = parseConnectionUrl(value);
    if (parsed) out.push({ variable, ...parsed });
  }
  return out.sort((a, b) => a.variable.localeCompare(b.variable));
}
