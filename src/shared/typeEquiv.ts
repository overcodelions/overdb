// When two servers are saying the same thing in different words.
//
// A fan-out comparison reads column types across engines, and engines spell
// the same type differently: MariaDB calls it `datetime`, Aurora MySQL calls
// it `timestamp`, Postgres calls a 32-bit integer `int4` and MySQL calls it
// `int(11)`. Reported at the same volume as a column that only exists on one
// member, that noise trains you to ignore the verdict — which is the one
// failure mode a comparison tool cannot survive.
//
// So: two type names are EQUIVALENT when they mean the same thing and the
// two members are on different variants. The variant check is load-bearing
// in the other direction — `datetime` against `timestamp` on two MySQL
// servers of the SAME variant is not a spelling difference, it is a real
// schema difference, and this must not quietly swallow it.

import type { Variant } from './engines';

/// Names that mean the same thing, grouped. First entry names the group.
///
/// Deliberately conservative. A pair not listed here is reported as a
/// difference, which is the safe direction to be wrong in: a false finding
/// costs a glance, a swallowed one costs an incident.
const FAMILIES: string[][] = [
  // Wall-clock timestamp with no zone. Postgres `timestamp`, MySQL and
  // MariaDB `datetime`, and MySQL's own `timestamp` — which differs from
  // Postgres's in epoch range but not in what a column of it holds.
  ['timestamp', 'datetime'],
  // WITH time zone stays its own family: the difference between these two
  // is exactly the bug people fan out to find.
  ['timestamptz', 'timestamp with time zone'],
  ['date'],
  ['time', 'time without time zone'],
  ['smallint', 'int2'],
  ['int', 'int4', 'integer', 'mediumint'],
  ['bigint', 'int8'],
  ['bool', 'boolean', 'bit', 'tinyint(1)'],
  ['real', 'float4', 'float'],
  ['double', 'float8', 'double precision'],
  ['decimal', 'numeric'],
  ['varchar', 'character varying'],
  ['char', 'character', 'bpchar'],
  ['text', 'longtext', 'mediumtext', 'tinytext', 'clob'],
  ['json', 'jsonb'],
  ['bytes', 'bytea', 'blob', 'longblob', 'mediumblob', 'varbinary'],
  ['uuid'],
];

const CANON = new Map<string, string>();
for (const family of FAMILIES) {
  for (const name of family) CANON.set(name, family[0]);
}

/// Integer display widths — `int(11)` — are a MySQL-family artifact that
/// MySQL 8 itself dropped and MariaDB still reports. Stripped from integer
/// types only: on `varchar(255)` or `decimal(10,2)` the parenthesis carries
/// the actual size, and dropping it would hide a real difference.
const WIDTHLESS = /^(tinyint|smallint|mediumint|int|integer|bigint)\s*\(\s*\d+\s*\)/;

/// The type, reduced to what it means.
export function canonicalType(typeName: string): string {
  let name = typeName.trim().toLowerCase();

  // `int(11) unsigned` keeps the unsigned — the range genuinely differs.
  const unsigned = /\bunsigned\b/.test(name);
  name = name.replace(/\bunsigned\b/g, '').replace(/\s+/g, ' ').trim();

  // `tinyint(1)` is the MySQL boolean and has to be looked up before widths
  // are stripped, or it becomes an ordinary tinyint.
  const direct = CANON.get(name);
  if (direct) return unsigned ? `${direct} unsigned` : direct;

  if (WIDTHLESS.test(name)) name = name.replace(/\s*\(\s*\d+\s*\)/, '');

  // `character varying(255)` → family `varchar`, size kept.
  const size = name.match(/\(([^)]*)\)\s*$/)?.[1];
  const bare = size === undefined ? name : name.slice(0, name.lastIndexOf('(')).trim();
  const family = CANON.get(bare) ?? bare;
  const canon = size === undefined ? family : `${family}(${size.replace(/\s+/g, '')})`;
  return unsigned ? `${canon} unsigned` : canon;
}

/// Do these two type names describe the same column, allowing for the two
/// servers spelling it differently?
///
/// Same variant means no allowance: two MariaDB servers disagreeing about a
/// type name are disagreeing about the type.
export function sameType(
  a: string,
  b: string,
  variantA: Variant | undefined,
  variantB: Variant | undefined,
): boolean {
  if (a === b) return true;
  if (variantA !== undefined && variantA === variantB) return false;
  return canonicalType(a) === canonicalType(b);
}

/// Whether a difference in spelling is only that — for labelling a cell as
/// quiet rather than as drift.
export function equivalentSpelling(
  a: string,
  b: string,
  variantA: Variant | undefined,
  variantB: Variant | undefined,
): boolean {
  return a !== b && sameType(a, b, variantA, variantB);
}
