// Engine vs variant.
//
// `Engine` is the DRIVER — which client library speaks to the server. It is
// deliberately small, and adding to it is expensive.
//
// `Variant` is the FLAVOUR — what the server actually is. Redshift, Aurora
// and CockroachDB all speak the Postgres wire protocol, so `pg` connects to
// them happily, but they are not Postgres: Redshift has no LATERAL and no
// indexes, CockroachDB has a different EXPLAIN, MariaDB and MySQL diverge on
// performance-schema views. Introspection, EXPLAIN and the perf work all
// need to know which one they are talking to, and so does the person
// choosing between six connections in a sidebar.
//
// Keeping them separate is what makes "support Redshift" a dialect change
// rather than a new adapter.

import type { SslMode } from './types';

export type Engine = 'postgres' | 'mysql' | 'sqlite' | 'dynamodb';

export type Variant =
  | 'postgres'
  | 'redshift'
  | 'aurora-postgres'
  | 'cockroach'
  | 'timescale'
  | 'mysql'
  | 'mariadb'
  | 'aurora-mysql'
  | 'sqlite'
  | 'dynamodb';

interface VariantInfo {
  engine: Engine;
  /// Full name, for tooltips and prompts.
  label: string;
  /// Sidebar badge. The product's actual name — `rs`, `apg` and `crdb`
  /// only ever existed because the badge used to be a fixed 38px pill, and
  /// a private code is a worse trade than four more pixels.
  tag: string;
}

export const VARIANTS: Record<Variant, VariantInfo> = {
  postgres: { engine: 'postgres', label: 'PostgreSQL', tag: 'Postgres' },
  redshift: { engine: 'postgres', label: 'Amazon Redshift', tag: 'Redshift' },
  'aurora-postgres': { engine: 'postgres', label: 'Aurora PostgreSQL', tag: 'Aurora' },
  cockroach: { engine: 'postgres', label: 'CockroachDB', tag: 'Cockroach' },
  timescale: { engine: 'postgres', label: 'TimescaleDB', tag: 'Timescale' },
  mysql: { engine: 'mysql', label: 'MySQL', tag: 'MySQL' },
  mariadb: { engine: 'mysql', label: 'MariaDB', tag: 'MariaDB' },
  'aurora-mysql': { engine: 'mysql', label: 'Aurora MySQL', tag: 'Aurora' },
  sqlite: { engine: 'sqlite', label: 'SQLite', tag: 'SQLite' },
  dynamodb: { engine: 'dynamodb', label: 'Amazon DynamoDB', tag: 'DynamoDB' },
};

/// What a connection to this flavour should start out as.
///
/// Not cosmetic. Redshift and Aurora sit behind managed endpoints that
/// refuse unencrypted connections outright, and the error they return for
/// that ("no pg_hba.conf entry ... SSL off") names a file the user cannot
/// see and does not mention TLS as the remedy. Defaulting these to
/// `require` is the difference between a connection that works when you
/// pick it and one that fails with an unreadable message.
///
/// Applied only when the TYPE is chosen — never retroactively to a saved
/// connection, whose settings are the user's, not ours.
export function variantDefaults(variant: Variant): { port?: number; ssl?: SslMode } {
  switch (variant) {
    case 'redshift':
      return { port: 5439, ssl: 'require' };
    case 'aurora-postgres':
      return { port: 5432, ssl: 'require' };
    case 'cockroach':
      return { port: 26257, ssl: 'require' };
    case 'timescale':
    case 'postgres':
      return { port: 5432, ssl: 'verify-full' };
    case 'aurora-mysql':
      return { port: 3306, ssl: 'require' };
    case 'mysql':
    case 'mariadb':
      return { port: 3306, ssl: 'verify-full' };
    default:
      return {};
  }
}

/// The type picker's own order: families together, the plain one first in
/// each. A list of ten flavours is only usable if it reads like the shelf
/// it is describing.
export const VARIANT_ORDER: Variant[] = [
  'postgres',
  'redshift',
  'aurora-postgres',
  'cockroach',
  'timescale',
  'mysql',
  'mariadb',
  'aurora-mysql',
  'sqlite',
  'dynamodb',
];

export function engineOf(variant: Variant): Engine {
  return VARIANTS[variant].engine;
}

export function variantLabel(variant: Variant | undefined, engine: Engine): string {
  return variant ? VARIANTS[variant].label : VARIANTS[engine].label;
}

export function variantTag(variant: Variant | undefined, engine: Engine): string {
  return variant ? VARIANTS[variant].tag : VARIANTS[engine].tag;
}

/// What the server said about itself. Every field is optional because each
/// one comes from a probe that is allowed to fail — `aurora_version()` does
/// not exist off Aurora, and asking is how we find out.
export interface VersionProbe {
  version?: string | null;
  versionComment?: string | null;
  auroraVersion?: string | null;
  hasTimescale?: boolean;
}

/// Which flavour we are actually connected to. Ordered most-specific first:
/// Redshift's version() string contains "PostgreSQL 8.0.2", so a naive
/// Postgres check matches it and every Redshift connection would report as
/// plain Postgres.
export function detectVariant(engine: Engine, probe: VersionProbe): Variant {
  const text = `${probe.version ?? ''} ${probe.versionComment ?? ''}`;

  if (engine === 'postgres') {
    if (/redshift/i.test(text)) return 'redshift';
    if (/cockroach/i.test(text)) return 'cockroach';
    if (probe.auroraVersion) return 'aurora-postgres';
    if (probe.hasTimescale) return 'timescale';
    return 'postgres';
  }

  if (engine === 'mysql') {
    // MariaDB puts its name in version() itself; Aurora MySQL reports a
    // stock MySQL version and is only identifiable by aurora_version().
    if (/mariadb/i.test(text)) return 'mariadb';
    if (probe.auroraVersion) return 'aurora-mysql';
    return 'mysql';
  }

  if (engine === 'dynamodb') return 'dynamodb';

  return 'sqlite';
}

/// Variant implied by a JDBC driver name, for imports — so six Redshift
/// connections are labelled correctly before any of them is opened.
export function variantFromDriver(driver: string): Variant | undefined {
  const d = driver.toLowerCase();
  if (d.includes('redshift')) return 'redshift';
  if (d.includes('cockroach')) return 'cockroach';
  if (d.includes('mariadb')) return 'mariadb';
  if (d.includes('aurora')) return undefined; // ambiguous: could be either family
  return undefined;
}

/// Redshift is a fork of PostgreSQL 8.0 and is missing a great deal of what
/// modern catalog queries assume: LATERAL, WITH ORDINALITY, and the whole
/// index concept (it has sort and distribution keys instead). Introspection
/// branches on this rather than on the engine.
export function isRedshift(variant: Variant | undefined): boolean {
  return variant === 'redshift';
}

/// DynamoDB is not a SQL database wearing a hat. It has no schema, no joins,
/// no server-side read-only mode, and its query language deliberately hides
/// the cost of what you asked for. Anywhere behaviour has to fork on that
/// rather than on dialect, it forks here.
export function isDocumentStore(engine: Engine): boolean {
  return engine === 'dynamodb';
}

/// What to call the language the user is writing. PartiQL is SQL-shaped, but
/// it is not SQL — telling a DynamoDB user we will "turn that into SQL"
/// promises a language their database does not speak, and then hands them
/// something that isn't it.
export function queryLanguage(engine: Engine): string {
  return engine === 'dynamodb' ? 'PartiQL' : 'SQL';
}
