// Parsing JDBC URLs, which are not URLs.
//
// `jdbc:mysql://host:3306/db` looks parseable by the URL constructor and
// isn't — the scheme is `jdbc`, and the part that matters is a second scheme
// nested inside it. Real-world files add more layers: `jdbc:mysql:aurora://`
// and `jdbc:aws-wrapper:mysql://` both appear in a normal JetBrains config,
// and both are just MySQL as far as a client is concerned.

import type { Engine } from './types';

export interface ParsedJdbc {
  engine: Engine | null;
  /// The driver family as written, for showing the user what was skipped.
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  /// True when the source speaks a wire protocol overdb supports under a
  /// different name — Redshift is Postgres on the wire.
  viaCompatibleProtocol?: boolean;
}

const DEFAULT_PORT: Record<string, number> = {
  mysql: 3306, mariadb: 3306, postgresql: 5432, postgres: 5432, redshift: 5439,
};

/// Strip the wrappers JetBrains and AWS layer on: `jdbc:`, `aws-wrapper:`,
/// and a trailing `:aurora`. What's left is the family we care about.
function driverFamily(url: string): { family: string; rest: string } | null {
  let rest = url.trim();
  if (!rest.toLowerCase().startsWith('jdbc:')) return null;
  rest = rest.slice(5);
  if (rest.toLowerCase().startsWith('aws-wrapper:')) rest = rest.slice('aws-wrapper:'.length);
  const m = /^([a-z0-9_+-]+)(?::[a-z0-9_+-]+)?:\/\/(.*)$/i.exec(rest);
  if (!m) {
    // sqlite and friends have no authority component: jdbc:sqlite:/path/db
    const file = /^sqlite:(.+)$/i.exec(rest);
    if (file) return { family: 'sqlite', rest: file[1] };
    return null;
  }
  return { family: m[1].toLowerCase(), rest: m[2] };
}

export function parseJdbcUrl(url: string): ParsedJdbc | null {
  const head = driverFamily(url);
  if (!head) return null;

  if (head.family === 'sqlite') {
    return { engine: 'sqlite', driver: 'sqlite', database: head.rest };
  }

  // host[:port]/database[?params]
  const m = /^([^/:?]+)(?::(\d+))?(?:\/([^?]*))?/.exec(head.rest);
  if (!m) return { engine: null, driver: head.family };

  const engine: Engine | null =
    head.family === 'mysql' || head.family === 'mariadb'
      ? 'mysql'
      : head.family === 'postgresql' || head.family === 'postgres' || head.family === 'redshift'
        ? 'postgres'
        : null;

  return {
    engine,
    driver: head.family,
    host: m[1],
    port: m[2] ? Number(m[2]) : DEFAULT_PORT[head.family],
    database: m[3] || undefined,
    // Redshift is Postgres on the wire, so the pg driver connects to it —
    // worth offering, worth labelling honestly.
    viaCompatibleProtocol: head.family === 'redshift',
  };
}
