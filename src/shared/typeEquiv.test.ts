import { describe, expect, it } from 'vitest';
import { canonicalType, equivalentSpelling, sameType } from './typeEquiv';

describe('canonicalType', () => {
  it('folds the names for one wall-clock timestamp together', () => {
    expect(canonicalType('datetime')).toBe(canonicalType('timestamp'));
  });

  it('keeps a zoned timestamp apart from an unzoned one', () => {
    expect(canonicalType('timestamptz')).not.toBe(canonicalType('timestamp'));
  });

  it('drops a MySQL integer display width', () => {
    expect(canonicalType('int(11)')).toBe(canonicalType('int4'));
    expect(canonicalType('bigint(20)')).toBe(canonicalType('int8'));
  });

  it('keeps the size on types where the size is the point', () => {
    expect(canonicalType('varchar(255)')).toBe('varchar(255)');
    expect(canonicalType('character varying(255)')).toBe('varchar(255)');
    expect(canonicalType('varchar(255)')).not.toBe(canonicalType('varchar(64)'));
    expect(canonicalType('decimal(10,2)')).not.toBe(canonicalType('decimal(10,4)'));
  });

  it('keeps unsigned, which is a real difference in range', () => {
    expect(canonicalType('int(11) unsigned')).not.toBe(canonicalType('int(11)'));
    expect(canonicalType('int(10) unsigned')).toBe('int unsigned');
  });

  it('reads tinyint(1) as the boolean it is', () => {
    expect(canonicalType('tinyint(1)')).toBe(canonicalType('boolean'));
    expect(canonicalType('tinyint(4)')).not.toBe(canonicalType('boolean'));
  });

  it('leaves a type it has never heard of alone', () => {
    expect(canonicalType('geography(Point,4326)')).toBe('geography(point,4326)');
  });
});

describe('sameType', () => {
  it('allows a spelling difference across two different variants', () => {
    expect(sameType('datetime', 'timestamp', 'mariadb', 'aurora-mysql')).toBe(true);
  });

  // The direction that matters most: this must never swallow real drift.
  it('refuses the same allowance within one variant', () => {
    expect(sameType('datetime', 'timestamp', 'mariadb', 'mariadb')).toBe(false);
  });

  it('still calls an identical name identical within one variant', () => {
    expect(sameType('datetime', 'datetime', 'mariadb', 'mariadb')).toBe(true);
  });

  it('reports a genuinely different type as different, across engines too', () => {
    expect(sameType('int(11)', 'varchar(16)', 'mariadb', 'aurora-mysql')).toBe(false);
  });

  it('allows the comparison when a variant is unknown', () => {
    expect(sameType('datetime', 'timestamp', undefined, 'postgres')).toBe(true);
  });
});

describe('equivalentSpelling', () => {
  it('is true only when the names differ but the type does not', () => {
    expect(equivalentSpelling('datetime', 'timestamp', 'mariadb', 'aurora-mysql')).toBe(true);
    expect(equivalentSpelling('datetime', 'datetime', 'mariadb', 'aurora-mysql')).toBe(false);
    expect(equivalentSpelling('int(11)', 'varchar(16)', 'mariadb', 'aurora-mysql')).toBe(false);
  });
});
