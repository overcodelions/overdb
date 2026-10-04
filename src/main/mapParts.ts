// Splitting a database map into the passes that write it.
//
// One pass can only describe so many tables, and every pass used to search
// the whole repo for its own share of names: a few hundred tables meant
// fifteen passes each rereading everything. Here the scan has already said
// which files name each table, so a pass is a set of tables that live in
// the same part of the code, handed the files that name them. Tables no
// file names are left out — there is nothing in the code to describe — and
// the schemas a seed works in go first, so the map is usable before the
// rest is done.

export interface MapPart {
  /// `schema.table`, the tables this pass describes.
  tables: string[];
  /// The files that name them, the likeliest data-layer files first.
  files: string[];
  /// How many more files name them than are listed.
  moreFiles: number;
  /// In a schema mapped first.
  first: boolean;
}

export interface PartPlan {
  parts: MapPart[];
  /// Named by no file.
  leftOut: string[];
}

/// Files that usually hold what a table means: mappings, migrations, SQL.
const DATA_LAYER = /(entit|model|repositor|dao|migrat|schema|mapper|domain|persist|\.sql$|\.prisma$)/i;

function schemaOf(table: string): string {
  return table.includes('.') ? table.slice(0, table.indexOf('.')) : '';
}

/// The folder most of a table's files are in, three levels deep: the area
/// of the code that owns it.
function areaOf(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = f.split('/').slice(0, -1).slice(0, 3).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function rank(files: string[]): string[] {
  return [...files].sort((a, b) => Number(DATA_LAYER.test(b)) - Number(DATA_LAYER.test(a)) || a.localeCompare(b));
}

export function planMapParts(input: {
  tables: readonly string[];
  mentions: ReadonlyMap<string, readonly string[]>;
  /// Schemas to map first.
  first?: readonly string[];
  maxTables?: number;
  maxFiles?: number;
}): PartPlan {
  const maxTables = input.maxTables ?? 40;
  const maxFiles = input.maxFiles ?? 120;
  // A table named everywhere (`users`) would fill a part on its own; what
  // it adds to a part's reading is capped, preferring its mapping files.
  const perTable = Math.max(1, Math.floor(maxFiles / 4));
  const first = new Set(input.first ?? []);

  const leftOut: string[] = [];
  const named: Array<{ table: string; files: string[]; area: string; first: boolean }> = [];
  for (const table of input.tables) {
    const files = rank([...(input.mentions.get(table) ?? [])]);
    if (files.length === 0) leftOut.push(table);
    else named.push({ table, files, area: areaOf(files), first: first.has(schemaOf(table)) });
  }
  // First schemas, then by area so neighbours share a pass, then by name.
  named.sort((a, b) => Number(b.first) - Number(a.first) || a.area.localeCompare(b.area) || a.table.localeCompare(b.table));

  const parts: MapPart[] = [];
  let cur: { tables: string[]; files: Map<string, number>; all: Set<string>; first: boolean } | null = null;
  const close = () => {
    if (!cur) return;
    // Files naming more of the pass's tables first, mapping files breaking ties.
    const ordered = rank([...cur.files.keys()]).sort((a, b) => cur!.files.get(b)! - cur!.files.get(a)!);
    const files = ordered.slice(0, maxFiles);
    parts.push({ tables: cur.tables, files, moreFiles: cur.all.size - files.length, first: cur.first });
    cur = null;
  };
  for (const t of named) {
    const reading = t.files.slice(0, perTable);
    const grows = cur ? reading.filter((f) => !cur!.files.has(f)).length : 0;
    if (cur && (cur.first !== t.first || cur.tables.length >= maxTables || cur.files.size + grows > maxFiles)) close();
    if (!cur) cur = { tables: [], files: new Map(), all: new Set(), first: t.first };
    cur.tables.push(t.table);
    for (const f of reading) cur.files.set(f, (cur.files.get(f) ?? 0) + 1);
    for (const f of t.files) cur.all.add(f);
  }
  close();
  return { parts, leftOut };
}
