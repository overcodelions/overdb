import type { Engine } from './engines';
import { quoteIdent } from './orderBy';
import type { DriftFinding, SchemaDrift } from './schemaDiff';
import type { SchemaSnapshot, TableInfo } from './types';

/// Drift, turned into the DDL that would close it.
///
/// Two rules, and they are the whole design.
///
/// **Nothing destructive is ever generated as runnable text.** A column
/// this member has and the baseline does not could be a mistake or could be
/// the reason this environment exists; overdb does not know which, and a
/// `DROP COLUMN` sitting in an editor next to twenty additive statements is
/// one careless ⌘↵ away from being the worst thing this app has ever done.
/// Those findings come back commented, with the reason on the line above.
///
/// **It is proposed, never run.** The output is text that lands in the
/// editor, like everything the AI layer produces. There is no execute path
/// from here.

export interface Migration {
  /// The statements, in an order that applies cleanly: tables before the
  /// columns that go in them, columns before the indexes over them.
  sql: string;
  /// How many statements are actually runnable, as opposed to commented.
  statementCount: number;
  /// Findings this could not express as DDL, with why. Named rather than
  /// dropped — a migration that silently covers eleven of fourteen findings
  /// is worse than one that says which three it left.
  unhandled: Array<{ finding: DriftFinding; reason: string }>;
}

const DESTRUCTIVE = new Set<DriftFinding['kind']>([
  'table-extra',
  'column-extra',
  'index-extra',
  'foreign-key-extra',
]);

/// `direction` says which way to move.
///
/// `toward-baseline` — the usual one — writes DDL for the drifted member so
/// it ends up looking like the baseline.
export function buildMigration(
  drift: SchemaDrift,
  baseline: SchemaSnapshot,
  engine: Engine,
  options: { includeQuiet?: boolean } = {},
): Migration {
  const q = (name: string) => quoteIdent(name, engine);
  const qualified = (schema: string, table: string) =>
    // SQLite has no schemas worth qualifying with; anything else does.
    engine === 'sqlite' ? q(table) : `${q(schema)}.${q(table)}`;

  const lines: string[] = [];
  const unhandled: Migration['unhandled'] = [];
  let statementCount = 0;

  const push = (sql: string) => {
    lines.push(sql);
    statementCount++;
  };
  const comment = (text: string) => lines.push(text);

  const tableIn = (schema: string, name: string): TableInfo | undefined =>
    baseline.schemas.find((s) => s.name === schema)?.tables.find((t) => t.name === name);

  const findings = drift.findings.filter(
    (f) => options.includeQuiet || f.severity !== 'quiet',
  );

  // Missing tables first: every column, index and key below may belong to
  // one, and DDL that references a table created later does not apply.
  const created = new Set<string>();
  for (const f of findings) {
    if (f.kind !== 'table-missing') continue;
    const info = tableIn(f.schema, f.table);
    if (!info || info.columns.length === 0) {
      unhandled.push({ finding: f, reason: 'The baseline holds this table by name only — its columns were never read.' });
      continue;
    }
    if (info.kind !== 'table') {
      unhandled.push({ finding: f, reason: `Recreating a ${info.kind} needs its definition, which the catalog snapshot does not carry.` });
      continue;
    }
    created.add(`${f.schema}.${f.table}`);
    const cols = info.columns.map((c) => {
      const parts = [`  ${q(c.name)} ${c.typeName}`];
      if (!c.nullable) parts.push('not null');
      if (c.defaultExpr) parts.push(`default ${c.defaultExpr}`);
      return parts.join(' ');
    });
    if (info.primaryKey.length > 0) {
      cols.push(`  primary key (${info.primaryKey.map(q).join(', ')})`);
    }
    push(`create table ${qualified(f.schema, f.table)} (\n${cols.join(',\n')}\n);`);
  }

  for (const f of findings) {
    const table = qualified(f.schema, f.table);
    // Everything about a table we just created is already in the CREATE.
    if (created.has(`${f.schema}.${f.table}`) && f.kind !== 'table-missing') continue;

    if (DESTRUCTIVE.has(f.kind)) {
      comment(`-- ${f.sentence}`);
      comment(`-- Removing it would lose data, so overdb will not write that for you.`);
      comment(`-- ${destructiveHint(f, table, q)}`);
      continue;
    }

    switch (f.kind) {
      case 'table-missing':
        break;

      case 'column-missing': {
        const info = tableIn(f.schema, f.table);
        const col = info?.columns.find((c) => c.name === f.object);
        if (!col) {
          unhandled.push({ finding: f, reason: 'The baseline column was not in the snapshot.' });
          break;
        }
        // A NOT NULL column added to a table with rows in it needs a
        // default or it fails; saying so beats a migration that errors on
        // the environment it was written for.
        if (!col.nullable && col.defaultExpr === null) {
          comment(`-- ${f.object} is NOT NULL with no default; this fails if ${f.table} has rows.`);
          comment(`-- Add a default, or add it nullable, backfill, then set not null.`);
        }
        push(
          `alter table ${table} add column ${q(col.name)} ${col.typeName}` +
            `${col.nullable ? '' : ' not null'}${col.defaultExpr ? ` default ${col.defaultExpr}` : ''};`,
        );
        break;
      }

      case 'column-type': {
        if (f.severity === 'quiet') {
          comment(`-- ${f.sentence}`);
          break;
        }
        if (engine === 'sqlite') {
          unhandled.push({ finding: f, reason: 'SQLite cannot alter a column type; the table has to be rebuilt.' });
          break;
        }
        comment(`-- ${f.sentence}`);
        comment(`-- Check this one: a narrowing change fails on existing rows.`);
        push(
          engine === 'postgres'
            ? `alter table ${table} alter column ${q(f.object ?? '')} type ${f.baseline};`
            : `alter table ${table} modify column ${q(f.object ?? '')} ${f.baseline};`,
        );
        break;
      }

      case 'column-nullability': {
        if (engine === 'sqlite') {
          unhandled.push({ finding: f, reason: 'SQLite cannot change nullability in place.' });
          break;
        }
        const toNotNull = f.baseline === 'not null';
        if (toNotNull) {
          comment(`-- This fails while any row has ${f.object} null. Backfill first.`);
        }
        push(
          engine === 'postgres'
            ? `alter table ${table} alter column ${q(f.object ?? '')} ${toNotNull ? 'set' : 'drop'} not null;`
            : `-- MySQL needs the full column definition to change nullability:\nalter table ${table} modify column ${q(f.object ?? '')} <type> ${toNotNull ? 'not null' : 'null'};`,
        );
        break;
      }

      case 'column-default': {
        if (engine === 'sqlite') {
          unhandled.push({ finding: f, reason: 'SQLite cannot change a default in place.' });
          break;
        }
        push(
          f.baseline === null
            ? `alter table ${table} alter column ${q(f.object ?? '')} drop default;`
            : `alter table ${table} alter column ${q(f.object ?? '')} set default ${f.baseline};`,
        );
        break;
      }

      case 'index-missing': {
        const info = tableIn(f.schema, f.table);
        const ix = info?.indexes.find((i) => i.name === f.object);
        if (!ix) {
          unhandled.push({ finding: f, reason: 'The baseline index was not in the snapshot.' });
          break;
        }
        // Named after the baseline's index, so the two environments end up
        // with the same name as well as the same shape — which is what
        // makes the NEXT comparison say "match".
        push(
          `create ${ix.unique ? 'unique ' : ''}index ${q(ix.name)} on ${table} (${ix.columns.map(q).join(', ')});`,
        );
        break;
      }

      case 'foreign-key-missing': {
        const info = tableIn(f.schema, f.table);
        const fk = info?.foreignKeys.find((k) => k.name === f.object);
        if (!fk) {
          unhandled.push({ finding: f, reason: 'The baseline constraint was not in the snapshot.' });
          break;
        }
        comment(`-- This fails if ${f.table} already holds rows with no match in ${fk.refTable}.`);
        push(
          `alter table ${table} add constraint ${q(fk.name)} foreign key (${fk.columns.map(q).join(', ')}) ` +
            `references ${qualified(fk.refSchema ?? f.schema, fk.refTable)} (${fk.refColumns.map(q).join(', ')});`,
        );
        break;
      }

      case 'primary-key':
      case 'index-uniqueness':
      case 'foreign-key-target':
      case 'table-kind':
        // Each of these means dropping something before adding it back, and
        // the drop is the destructive half. Named, not written.
        unhandled.push({
          finding: f,
          reason: 'Closing this means dropping the existing one first, which overdb will not write.',
        });
        break;

      case 'column-order':
        unhandled.push({ finding: f, reason: 'Column order is not worth a table rebuild.' });
        break;

      default:
        unhandled.push({ finding: f, reason: 'No DDL for this kind of difference.' });
    }
  }

  const header = [
    `-- Proposed by overdb. Nothing here has run.`,
    `-- Bringing this connection in line with the baseline, as of ${new Date().toISOString()}.`,
    `-- Read every statement: overdb compared two catalogs, not two datasets.`,
    '',
  ];

  return {
    sql: statementCount === 0 && lines.length === 0
      ? `${header.join('\n')}-- Nothing to do — no difference here can be closed with DDL.\n`
      : `${header.join('\n')}${lines.join('\n\n')}\n`,
    statementCount,
    unhandled,
  };
}

function destructiveHint(
  f: DriftFinding,
  table: string,
  q: (name: string) => string,
): string {
  switch (f.kind) {
    case 'table-extra':
      return `If you are sure: drop table ${table};`;
    case 'column-extra':
      return `If you are sure: alter table ${table} drop column ${q(f.object ?? '')};`;
    case 'index-extra':
      return `If you are sure: drop index ${q(f.object ?? '')};`;
    case 'foreign-key-extra':
      return `If you are sure: alter table ${table} drop constraint ${q(f.object ?? '')};`;
    default:
      return '';
  }
}
