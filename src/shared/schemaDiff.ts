import type { Variant } from './engines';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, SchemaSnapshot, TableInfo } from './types';
import { equivalentSpelling, sameType } from './typeEquiv';

/// What has drifted between two environments.
///
/// This module is the point of the app. Everything else here can be got
/// somewhere else; "staging and prod no longer agree, and here is exactly
/// how" cannot, because no one-connection-at-a-time client is ever holding
/// both catalogs at once.
///
/// Three decisions shape all of it.
///
/// **Everything is against a baseline.** An N×N matrix of five environments
/// is unreadable. "prod is the truth, staging drifted" is a sentence, and
/// the direction is what makes each finding actionable.
///
/// **Severity is not decoration.** A column missing here that the baseline
/// has will break a query; a differently-spelled type name will not. Ranked
/// at equal weight, the second kind buries the first and trains people to
/// stop reading the panel — which is the one failure a comparison tool
/// cannot survive. So `quiet` findings exist, are counted, and are shown
/// folded away.
///
/// **Nothing is compared that was not read.** A table the snapshot holds by
/// name only — the schema tree does that for schemas you have not opened —
/// would otherwise report every one of its columns as missing. Those tables
/// are named as unread instead.

export type DriftSeverity = 'breaking' | 'notable' | 'quiet';

export type DriftKind =
  | 'table-missing'
  | 'table-extra'
  | 'table-kind'
  | 'column-missing'
  | 'column-extra'
  | 'column-type'
  | 'column-nullability'
  | 'column-default'
  | 'column-order'
  | 'primary-key'
  | 'index-missing'
  | 'index-extra'
  | 'index-uniqueness'
  | 'foreign-key-missing'
  | 'foreign-key-extra'
  | 'foreign-key-target';

export interface DriftFinding {
  kind: DriftKind;
  severity: DriftSeverity;
  schema: string;
  table: string;
  /// The column, index or constraint this is about, when it is about one.
  object: string | null;
  /// What the baseline has, and what this member has. Null on either side
  /// means "not present", which is different from an empty string.
  baseline: string | null;
  here: string | null;
  /// One sentence, written in the direction the reader is asking about:
  /// what is true HERE, compared to the baseline.
  sentence: string;
}

export interface SchemaDrift {
  findings: DriftFinding[];
  counts: Record<DriftSeverity, number>;
  /// `match` means nothing at all differs; `quiet` means the only
  /// differences are ones that change no behaviour.
  verdict: 'match' | 'quiet' | 'drift';
  /// Schemas present on both sides and therefore actually compared.
  comparedSchemas: string[];
  /// Schemas only one side has. Reported rather than diffed: a whole schema
  /// missing is usually a connection pointed at the wrong database, and
  /// listing its four hundred tables as findings hides that.
  onlyInBaseline: string[];
  onlyHere: string[];
  /// Tables whose columns were not read on one side or the other.
  unread: string[];
  /// Indexes and constraints whose column list the catalog would not give
  /// us — a MySQL functional index reports no column name at all. Dropped
  /// from the comparison and named here, because an index overdb cannot
  /// read is one it cannot honestly call present, missing or matching.
  unreadable: string[];
  /// True when the two snapshots come from different engines, in which case
  /// every finding is advisory: the two catalogs do not mean the same thing
  /// closely enough for a verdict.
  crossEngine: boolean;
}

export interface DiffOptions {
  /// Variants, so `datetime` against `timestamp` is read as a spelling
  /// difference across MariaDB and MySQL but as real drift between two
  /// servers of the same variant. See src/shared/typeEquiv.ts.
  baselineVariant?: Variant;
  hereVariant?: Variant;
  /// Column order matters on MySQL (it is part of the table's storage) and
  /// not on Postgres. Defaults to quiet.
  orderMatters?: boolean;
  /// Schemas to compare. Everything present on both sides, by default.
  schemas?: string[];
  /// Compare only these tables. Used by the fan-out, which asks a much
  /// narrower question than the drift panel: not "have these environments
  /// diverged" but "do the tables THIS statement just read have the same
  /// indexes", asked at the moment one member came back slower than
  /// another. A null schema means "whichever schema the table is in".
  tables?: Array<{ schema: string | null; table: string }>;
}

/// Cross-engine findings never claim to be breaking: the two catalogs
/// disagree about vocabulary before they disagree about anything real.
function cap(severity: DriftSeverity, crossEngine: boolean): DriftSeverity {
  return crossEngine && severity === 'breaking' ? 'notable' : severity;
}

export function diffSchemas(
  baseline: SchemaSnapshot,
  here: SchemaSnapshot,
  options: DiffOptions = {},
): SchemaDrift {
  const crossEngine = baseline.engine !== here.engine;
  const orderMatters = options.orderMatters ?? here.engine === 'mysql';

  const baseSchemas = new Map(baseline.schemas.map((s) => [s.name, s]));
  const hereSchemas = new Map(here.schemas.map((s) => [s.name, s]));

  const wanted = options.schemas && options.schemas.length > 0 ? new Set(options.schemas) : null;
  const names = [...new Set([...baseSchemas.keys(), ...hereSchemas.keys()])]
    .filter((n) => !wanted || wanted.has(n))
    .sort();

  const findings: DriftFinding[] = [];
  const compared: string[] = [];
  const onlyInBaseline: string[] = [];
  const onlyHere: string[] = [];
  const unread: string[] = [];
  const unreadable: string[] = [];

  for (const schema of names) {
    const a = baseSchemas.get(schema);
    const b = hereSchemas.get(schema);
    if (!a) {
      onlyHere.push(schema);
      continue;
    }
    if (!b) {
      onlyInBaseline.push(schema);
      continue;
    }
    compared.push(schema);

    const aTables = new Map(a.tables.map((t) => [t.name, t]));
    const bTables = new Map(b.tables.map((t) => [t.name, t]));

    // Table names are compared case-insensitively here because the source
    // of the list is often the SERVER's own answer about which table a
    // column came from, and MySQL will happily hand back a different case
    // than the one in the catalog depending on the platform.
    const onlyThese =
      options.tables && options.tables.length > 0
        ? new Set(
            options.tables
              .filter((t) => t.schema === null || t.schema === schema)
              .map((t) => t.table.toLowerCase()),
          )
        : null;

    for (const name of [...new Set([...aTables.keys(), ...bTables.keys()])].sort()) {
      if (onlyThese && !onlyThese.has(name.toLowerCase())) continue;
      const at = aTables.get(name);
      const bt = bTables.get(name);

      if (!bt) {
        findings.push({
          kind: 'table-missing',
          severity: cap('breaking', crossEngine),
          schema,
          table: name,
          object: null,
          baseline: at?.kind ?? 'table',
          here: null,
          sentence: `${name} does not exist here. The baseline has it.`,
        });
        continue;
      }
      if (!at) {
        findings.push({
          kind: 'table-extra',
          severity: 'notable',
          schema,
          table: name,
          object: null,
          baseline: null,
          here: bt.kind,
          sentence: `${name} exists only here — the baseline has no such ${bt.kind}.`,
        });
        continue;
      }

      // A snapshot can hold a table by name alone; comparing its columns
      // against a fully-read one would report the whole table as deleted.
      if (at.columns.length === 0 || bt.columns.length === 0) {
        unread.push(`${schema}.${name}`);
        continue;
      }

      if (at.kind !== bt.kind) {
        findings.push({
          kind: 'table-kind',
          severity: cap('breaking', crossEngine),
          schema,
          table: name,
          object: null,
          baseline: at.kind,
          here: bt.kind,
          sentence: `${name} is a ${bt.kind} here and a ${at.kind} on the baseline.`,
        });
      }

      findings.push(
        ...diffColumns(schema, at, bt, { crossEngine, orderMatters, ...options }),
        ...diffKeys(schema, at, bt, crossEngine),
        ...diffIndexes(schema, at, bt, crossEngine, unreadable),
        ...diffForeignKeys(schema, at, bt, crossEngine, unreadable),
      );
    }
  }

  const counts: Record<DriftSeverity, number> = { breaking: 0, notable: 0, quiet: 0 };
  for (const f of findings) counts[f.severity]++;

  const verdict: SchemaDrift['verdict'] =
    findings.length === 0
      ? 'match'
      : counts.breaking === 0 && counts.notable === 0
        ? 'quiet'
        : 'drift';

  return {
    findings: findings.sort(bySeverity),
    counts,
    verdict,
    comparedSchemas: compared,
    onlyInBaseline,
    onlyHere,
    unread,
    unreadable: [...new Set(unreadable)].sort(),
    crossEngine,
  };
}

const RANK: Record<DriftSeverity, number> = { breaking: 0, notable: 1, quiet: 2 };

function bySeverity(a: DriftFinding, b: DriftFinding): number {
  return (
    RANK[a.severity] - RANK[b.severity] ||
    a.schema.localeCompare(b.schema) ||
    a.table.localeCompare(b.table) ||
    (a.object ?? '').localeCompare(b.object ?? '')
  );
}

function diffColumns(
  schema: string,
  at: TableInfo,
  bt: TableInfo,
  opts: DiffOptions & { crossEngine: boolean; orderMatters: boolean },
): DriftFinding[] {
  const out: DriftFinding[] = [];
  const aCols = new Map(at.columns.map((c) => [c.name, c]));
  const bCols = new Map(bt.columns.map((c) => [c.name, c]));
  const base = (severity: DriftSeverity) => cap(severity, opts.crossEngine);

  for (const [name, a] of aCols) {
    const b = bCols.get(name);
    if (!b) {
      out.push({
        kind: 'column-missing',
        severity: base('breaking'),
        schema,
        table: at.name,
        object: name,
        baseline: describeColumn(a),
        here: null,
        sentence: `${at.name}.${name} is missing here. Anything selecting it against the baseline will fail on this one.`,
      });
      continue;
    }

    if (!sameType(a.typeName, b.typeName, opts.baselineVariant, opts.hereVariant)) {
      out.push({
        kind: 'column-type',
        severity: base('breaking'),
        schema,
        table: at.name,
        object: name,
        baseline: a.typeName,
        here: b.typeName,
        sentence: `${at.name}.${name} is ${b.typeName} here and ${a.typeName} on the baseline.`,
      });
    } else if (equivalentSpelling(a.typeName, b.typeName, opts.baselineVariant, opts.hereVariant)) {
      // Same type, different word for it. Kept visible but quiet — see the
      // header of typeEquiv.ts for why this class exists at all.
      out.push({
        kind: 'column-type',
        severity: 'quiet',
        schema,
        table: at.name,
        object: name,
        baseline: a.typeName,
        here: b.typeName,
        sentence: `${at.name}.${name} is spelled ${b.typeName} here and ${a.typeName} on the baseline — the same type, two vocabularies.`,
      });
    }

    if (a.nullable !== b.nullable) {
      // Which direction breaks depends on which way you are moving. A
      // column that is NOT NULL here and nullable on the baseline rejects
      // rows the baseline accepts, which is the one that bites in a deploy.
      out.push({
        kind: 'column-nullability',
        severity: base(b.nullable ? 'notable' : 'breaking'),
        schema,
        table: at.name,
        object: name,
        baseline: a.nullable ? 'nullable' : 'not null',
        here: b.nullable ? 'nullable' : 'not null',
        sentence: b.nullable
          ? `${at.name}.${name} accepts nulls here; the baseline does not.`
          : `${at.name}.${name} rejects nulls here; the baseline accepts them. An insert that works there fails here.`,
      });
    }

    if (normalizeDefault(a.defaultExpr) !== normalizeDefault(b.defaultExpr)) {
      out.push({
        kind: 'column-default',
        severity: 'notable',
        schema,
        table: at.name,
        object: name,
        baseline: a.defaultExpr,
        here: b.defaultExpr,
        sentence: `${at.name}.${name} defaults to ${b.defaultExpr ?? 'nothing'} here and ${a.defaultExpr ?? 'nothing'} on the baseline.`,
      });
    }

    if (opts.orderMatters && a.ordinal !== b.ordinal) {
      out.push({
        kind: 'column-order',
        severity: 'quiet',
        schema,
        table: at.name,
        object: name,
        baseline: `position ${a.ordinal}`,
        here: `position ${b.ordinal}`,
        sentence: `${at.name}.${name} sits at position ${b.ordinal} here and ${a.ordinal} on the baseline.`,
      });
    }
  }

  for (const [name, b] of bCols) {
    if (aCols.has(name)) continue;
    out.push({
      kind: 'column-extra',
      severity: b.nullable || b.defaultExpr !== null ? 'notable' : base('breaking'),
      schema,
      table: at.name,
      object: name,
      baseline: null,
      here: describeColumn(b),
      // A NOT NULL column with no default that the baseline does not have
      // is not a harmless extra: an insert written against the baseline
      // has nothing to put in it.
      sentence:
        b.nullable || b.defaultExpr !== null
          ? `${at.name}.${name} exists only here.`
          : `${at.name}.${name} exists only here, and is NOT NULL with no default — an insert written against the baseline cannot satisfy it.`,
    });
  }

  return out;
}

function describeColumn(c: ColumnInfo): string {
  return `${c.typeName}${c.nullable ? '' : ' not null'}${c.defaultExpr ? ` default ${c.defaultExpr}` : ''}`;
}

/// Defaults are compared loosely on purpose.
///
/// Engines echo the same default back in different shapes — `'a'::text` vs
/// `'a'`, `now()` vs `CURRENT_TIMESTAMP` — and reporting each as drift is
/// exactly the noise that makes a panel unreadable. What survives
/// normalisation is a genuinely different value.
export function normalizeDefault(expr: string | null): string | null {
  if (expr === null) return null;
  let text = expr.trim().toLowerCase();
  // Postgres appends the type to a literal default.
  text = text.replace(/::[a-z_ ]+(\(\d+(,\s*\d+)?\))?$/, '');
  text = text.replace(/^\((.*)\)$/, '$1');
  text = text.replace(/\s+/g, ' ');
  if (text === 'current_timestamp()' || text === 'now()') text = 'current_timestamp';
  if (text === "''" || text === '') return null;
  if (text === 'null') return null;
  return text;
}

function diffKeys(
  schema: string,
  at: TableInfo,
  bt: TableInfo,
  crossEngine: boolean,
): DriftFinding[] {
  const a = at.primaryKey.join(', ');
  const b = bt.primaryKey.join(', ');
  if (a === b) return [];
  return [
    {
      kind: 'primary-key',
      severity: cap('breaking', crossEngine),
      schema,
      table: at.name,
      object: null,
      baseline: a === '' ? null : a,
      here: b === '' ? null : b,
      sentence:
        b === ''
          ? `${at.name} has no primary key here. The baseline keys it on (${a}) — rows here cannot be addressed, so inline editing is off.`
          : a === ''
            ? `${at.name} is keyed on (${b}) here; the baseline has no primary key.`
            : `${at.name} is keyed on (${b}) here and (${a}) on the baseline.`,
    },
  ];
}

/// Indexes are matched by the columns they cover, not by name.
///
/// Auto-generated index names differ between servers that were built by
/// different migrations, and matching on them reports every index as both
/// missing and extra. What an index IS, is its columns and its uniqueness.
function indexKey(ix: IndexInfo): string {
  return ix.columns.map(columnKey).join(',');
}

/// One column name, folded for comparison.
///
/// Null-tolerant on purpose. `IndexInfo.columns` is a shared type any
/// adapter fills in, and a catalog can genuinely hand back a null column
/// name — MySQL does it for every functional index, where the expression
/// lives in a different column entirely. A comparison that crashes on one
/// unusual index takes the whole drift panel with it, which is a far worse
/// outcome than not knowing about that index.
function columnKey(name: string | null | undefined): string {
  return (name ?? '').toLowerCase();
}

/// Whether every column of this index or constraint could actually be read.
///
/// One that could not is dropped from the comparison and named, rather than
/// keyed as an empty string — two unreadable indexes on the same table would
/// otherwise key identically and be reported as matching each other, which
/// is a claim overdb cannot make.
function readable(columns: Array<string | null | undefined>): boolean {
  return columns.length > 0 && columns.every((c) => typeof c === 'string' && c !== '');
}

function diffIndexes(
  schema: string,
  at: TableInfo,
  bt: TableInfo,
  crossEngine: boolean,
  unreadable: string[],
): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const ix of [...at.indexes, ...bt.indexes]) {
    if (!readable(ix.columns)) unreadable.push(`${schema}.${at.name} index ${ix.name}`);
  }
  const aIx = new Map(
    at.indexes.filter((ix) => readable(ix.columns)).map((ix) => [indexKey(ix), ix]),
  );
  const bIx = new Map(
    bt.indexes.filter((ix) => readable(ix.columns)).map((ix) => [indexKey(ix), ix]),
  );

  for (const [key, a] of aIx) {
    const b = bIx.get(key);
    if (!b) {
      out.push({
        kind: 'index-missing',
        severity: a.unique ? cap('breaking', crossEngine) : 'notable',
        schema,
        table: at.name,
        object: a.name,
        baseline: `${a.unique ? 'unique ' : ''}(${a.columns.join(', ')})`,
        here: null,
        // A missing plain index is a performance difference — and the
        // commonest cause of "prod seq-scans where staging index-scans".
        // A missing UNIQUE index is a correctness difference.
        sentence: a.unique
          ? `${at.name} has no unique index on (${a.columns.join(', ')}) here. Duplicates the baseline rejects are possible on this one.`
          : `${at.name} has no index on (${a.columns.join(', ')}) here. The baseline does — expect a different plan.`,
      });
      continue;
    }
    if (a.unique !== b.unique) {
      out.push({
        kind: 'index-uniqueness',
        severity: cap('breaking', crossEngine),
        schema,
        table: at.name,
        object: b.name,
        baseline: a.unique ? 'unique' : 'not unique',
        here: b.unique ? 'unique' : 'not unique',
        sentence: `The index on (${a.columns.join(', ')}) is ${b.unique ? 'unique' : 'not unique'} here and ${a.unique ? 'unique' : 'not unique'} on the baseline.`,
      });
    }
  }

  for (const [key, b] of bIx) {
    if (aIx.has(key)) continue;
    out.push({
      kind: 'index-extra',
      severity: 'quiet',
      schema,
      table: at.name,
      object: b.name,
      baseline: null,
      here: `${b.unique ? 'unique ' : ''}(${b.columns.join(', ')})`,
      // An extra index costs writes, not correctness — worth seeing, not
      // worth shouting about.
      sentence: `${at.name} has an index on (${b.columns.join(', ')}) that the baseline does not.`,
    });
  }

  return out;
}

/// Foreign keys, matched on what they connect rather than on their name —
/// same reasoning as indexes.
function fkKey(fk: ForeignKeyInfo): string {
  return fk.columns.map(columnKey).join(',');
}

function diffForeignKeys(
  schema: string,
  at: TableInfo,
  bt: TableInfo,
  crossEngine: boolean,
  unreadable: string[],
): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const fk of [...at.foreignKeys, ...bt.foreignKeys]) {
    if (!readable(fk.columns)) unreadable.push(`${schema}.${at.name} constraint ${fk.name}`);
  }
  const aFk = new Map(
    at.foreignKeys.filter((fk) => readable(fk.columns)).map((fk) => [fkKey(fk), fk]),
  );
  const bFk = new Map(
    bt.foreignKeys.filter((fk) => readable(fk.columns)).map((fk) => [fkKey(fk), fk]),
  );

  for (const [key, a] of aFk) {
    const b = bFk.get(key);
    if (!b) {
      out.push({
        kind: 'foreign-key-missing',
        severity: 'notable',
        schema,
        table: at.name,
        object: a.name,
        baseline: `(${a.columns.join(', ')}) → ${a.refTable}(${a.refColumns.join(', ')})`,
        here: null,
        sentence: `${at.name}.(${a.columns.join(', ')}) is not a foreign key here. The baseline points it at ${a.refTable} — orphans are possible on this one.`,
      });
      continue;
    }
    const aTarget = `${a.refSchema ?? schema}.${a.refTable}(${a.refColumns.join(', ')})`;
    const bTarget = `${b.refSchema ?? schema}.${b.refTable}(${b.refColumns.join(', ')})`;
    if (aTarget !== bTarget) {
      out.push({
        kind: 'foreign-key-target',
        severity: cap('breaking', crossEngine),
        schema,
        table: at.name,
        object: b.name,
        baseline: aTarget,
        here: bTarget,
        sentence: `${at.name}.(${a.columns.join(', ')}) points at ${bTarget} here and ${aTarget} on the baseline.`,
      });
    }
  }

  for (const [key, b] of bFk) {
    if (aFk.has(key)) continue;
    out.push({
      kind: 'foreign-key-extra',
      severity: 'notable',
      schema,
      table: at.name,
      object: b.name,
      baseline: null,
      here: `(${b.columns.join(', ')}) → ${b.refTable}(${b.refColumns.join(', ')})`,
      sentence: `${at.name}.(${b.columns.join(', ')}) is a foreign key here and not on the baseline — an insert the baseline accepts can be rejected here.`,
    });
  }

  return out;
}

/// One line for a sidebar badge or a summary row.
export function driftSummary(drift: SchemaDrift, memberName: string): string {
  if (drift.verdict === 'match') return `${memberName} matches the baseline.`;
  if (drift.verdict === 'quiet') {
    return `${memberName} matches the baseline — ${drift.counts.quiet} difference${drift.counts.quiet === 1 ? '' : 's'} that change nothing.`;
  }
  const parts: string[] = [];
  if (drift.counts.breaking > 0) parts.push(`${drift.counts.breaking} breaking`);
  if (drift.counts.notable > 0) parts.push(`${drift.counts.notable} notable`);
  const advisory = drift.crossEngine ? ' (different engines — advisory only)' : '';
  return `${memberName}: ${parts.join(', ')}${advisory}.`;
}
