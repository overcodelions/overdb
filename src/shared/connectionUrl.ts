// A connection URL, taken apart into the fields this app has.
//
// Everybody has one of these in their hand already — in a .env, in a
// runbook, in the output of `heroku config` — and typing it back into six
// boxes is both tedious and where the typo comes from. So the form takes
// the whole string.
//
// Two things are easy to get wrong and are the reason this is a real parser
// rather than a regex at the call site:
//
//   1. Percent-encoding. A password with an `@` or a `/` in it MUST be
//      encoded in a URL, and a parser that does not decode hands the user a
//      password that is quietly wrong — which presents as "the server
//      rejected the password" and sends them hunting in the wrong place.
//   2. `sslmode`. It is in the URL, it maps onto a control in the form, and
//      dropping it means pasting a working URL produces a connection that
//      fails on TLS.
//
// Pure and shared: the renderer parses as you type, with no round trip.

import type { Engine, SslMode } from './types';
import type { Variant } from './engines';
import { parseJdbcUrl } from './jdbcUrl';

export interface ParsedConnectionUrl {
  engine: Engine;
  variant?: Variant;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /// Present only when the URL carried one. The caller decides where it
  /// goes; nothing here stores anything.
  password?: string;
  ssl?: SslMode;
  /// `?options=-csearch_path%3Danalytics`, and the Postgres `?schema=` that
  /// several ORMs write.
  defaultSchema?: string;
  /// The parts of the URL that were understood but have no home in this
  /// form, so the UI can say what it dropped rather than losing it
  /// silently.
  ignored: string[];
}

const DEFAULT_PORT: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  redshift: 5439,
  cockroachdb: 26257,
  mysql: 3306,
  mariadb: 3306,
};

/// Postgres spells it one way, MySQL another, and both appear in URLs
/// people paste. `prefer` and `allow` are mapped UP to require rather than
/// down to disable: they mean "TLS if available", and of the two ways to be
/// wrong, encrypting something that did not need it is the harmless one.
function sslFromParams(params: URLSearchParams): SslMode | undefined {
  const pg = params.get('sslmode')?.toLowerCase();
  if (pg) {
    if (pg === 'disable') return 'disable';
    if (pg === 'allow' || pg === 'prefer' || pg === 'require') return 'require';
    if (pg === 'verify-ca') return 'verify-ca';
    if (pg === 'verify-full') return 'verify-full';
  }
  const my = params.get('ssl-mode')?.toLowerCase() ?? params.get('sslmode')?.toLowerCase();
  if (my) {
    if (my === 'disabled') return 'disable';
    if (my === 'preferred' || my === 'required') return 'require';
    if (my === 'verify_ca') return 'verify-ca';
    if (my === 'verify_identity') return 'verify-full';
  }
  // `?ssl=true` — the Java and node-postgres shorthand.
  const flag = params.get('ssl')?.toLowerCase();
  if (flag === 'true' || flag === '1') return 'require';
  if (flag === 'false' || flag === '0') return 'disable';
  return undefined;
}

/// `-csearch_path=analytics`, which is how Postgres carries a schema in a
/// URL, plus the plain `?schema=` that Prisma and friends write.
function schemaFromParams(params: URLSearchParams): string | undefined {
  const plain = params.get('schema') ?? params.get('currentSchema');
  if (plain) return plain;
  const options = params.get('options');
  const m = options ? /-c\s*search_path\s*=\s*([^\s,]+)/i.exec(options) : null;
  return m ? m[1] : undefined;
}

function engineFor(scheme: string): { engine: Engine; variant?: Variant } | null {
  const s = scheme.toLowerCase();
  if (s === 'postgres' || s === 'postgresql') return { engine: 'postgres' };
  if (s === 'redshift') return { engine: 'postgres', variant: 'redshift' };
  if (s === 'cockroachdb' || s === 'cockroach') return { engine: 'postgres', variant: 'cockroach' };
  if (s === 'mysql') return { engine: 'mysql' };
  if (s === 'mariadb') return { engine: 'mysql', variant: 'mariadb' };
  if (s === 'sqlite' || s === 'file') return { engine: 'sqlite' };
  return null;
}

/// What the hostname gives away. A managed endpoint names itself, and
/// getting the variant right up front is what makes the port, the TLS
/// default and the dialect right too.
export function variantFromHost(host: string | undefined, engine: Engine): Variant | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  if (h.endsWith('.redshift.amazonaws.com') || h.endsWith('.redshift-serverless.amazonaws.com')) {
    return 'redshift';
  }
  if (/\.rds\.amazonaws\.com$/.test(h) && /cluster-/.test(h)) {
    return engine === 'mysql' ? 'aurora-mysql' : 'aurora-postgres';
  }
  if (h.endsWith('.cockroachlabs.cloud')) return 'cockroach';
  return undefined;
}

/// Which query parameters we understood. Everything else is reported back
/// so "I pasted a URL with `connect_timeout` in it" is visible.
const CONSUMED = new Set([
  'sslmode', 'ssl-mode', 'ssl', 'schema', 'currentschema', 'options',
  'user', 'username', 'password', 'dbname', 'database',
]);

export function parseConnectionUrl(input: string): ParsedConnectionUrl | null {
  const text = input.trim();
  if (!text) return null;

  // JDBC first: `jdbc:postgresql://…` is not a URL and the URL constructor
  // will happily half-parse it into nonsense.
  if (/^jdbc:/i.test(text)) {
    const jdbc = parseJdbcUrl(text);
    if (!jdbc?.engine) return null;
    const query = text.includes('?') ? new URLSearchParams(text.slice(text.indexOf('?') + 1)) : new URLSearchParams();
    return {
      engine: jdbc.engine,
      variant:
        (jdbc.viaCompatibleProtocol ? 'redshift' : undefined) ??
        variantFromHost(jdbc.host, jdbc.engine),
      host: jdbc.host,
      port: jdbc.port,
      database: jdbc.database,
      user: query.get('user') ?? query.get('username') ?? undefined,
      password: query.get('password') ?? undefined,
      ssl: sslFromParams(query),
      defaultSchema: schemaFromParams(query),
      ignored: [...query.keys()].filter((k) => !CONSUMED.has(k.toLowerCase())),
    };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1];
  if (!scheme) return null;
  const kind = engineFor(scheme);
  if (!kind) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const params = url.searchParams;
  const family = scheme.toLowerCase();

  if (kind.engine === 'sqlite') {
    return {
      engine: 'sqlite',
      database: decodeURIComponent(url.pathname),
      ignored: [...params.keys()].filter((k) => !CONSUMED.has(k.toLowerCase())),
    };
  }

  // URL leaves these percent-encoded; a password is the field most likely
  // to contain something that had to be encoded.
  const user = url.username ? safeDecode(url.username) : params.get('user') ?? params.get('username') ?? undefined;
  const password = url.password ? safeDecode(url.password) : params.get('password') ?? undefined;
  const database = url.pathname && url.pathname !== '/'
    ? safeDecode(url.pathname.replace(/^\//, ''))
    : params.get('dbname') ?? params.get('database') ?? undefined;

  // A Postgres URL with no host at all means a unix socket, which this
  // form cannot express — say so rather than inventing localhost.
  const host = url.hostname ? url.hostname.replace(/^\[|\]$/g, '') : undefined;

  return {
    engine: kind.engine,
    variant: kind.variant ?? variantFromHost(host, kind.engine),
    host,
    port: url.port ? Number(url.port) : DEFAULT_PORT[family],
    database: database || undefined,
    user: user || undefined,
    password: password || undefined,
    ssl: sslFromParams(params),
    defaultSchema: schemaFromParams(params),
    ignored: [...params.keys()].filter((k) => !CONSUMED.has(k.toLowerCase())),
  };
}

/// A `%` that is not part of a valid escape is a real character in some
/// passwords. Decoding must not throw over it.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
