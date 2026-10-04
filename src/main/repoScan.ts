import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SchemaEvidence } from '../shared/repoLinks';

// Which schemas a repo's code uses, read from the repo itself: a service
// names its database in its datasource config, and its SQL and ORM mappings
// name tables as `schema.table`. Only file names and match counts leave
// here — never contents — and secrets files are never opened.

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', '.gradle', '.next', '.nuxt', 'coverage', '.terraform', 'bin', 'obj',
]);
const CONFIG = /\.(ya?ml|properties|toml|ini|conf|cfg|xml|json|hcl|tf)$/i;
const CODE = /\.(sql|prisma|[cm]?[jt]sx?|py|rb|java|kt|kts|scala|go|php|cs|ex|exs|rs|groovy|clj|erb|twig)$/i;
/// Never opened: secrets, whatever they are called.
const SECRET = /(^|\/)\.env|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)(secrets?|credentials)\b/i;

const MAX_FILES = 30_000;
const MAX_BYTES = 1_000_000;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function* walk(root: string): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) yield full;
    }
  }
}

/// A file's text when it is small enough to read, else ''. Sized and read
/// through one handle, so the file measured is the file read.
async function readSmall(file: string): Promise<string> {
  const h = await fs.open(file, 'r').catch(() => null);
  if (!h) return '';
  try {
    const stat = await h.stat();
    return stat.size > MAX_BYTES ? '' : await h.readFile('utf-8');
  } catch {
    return '';
  } finally {
    await h.close().catch(() => undefined);
  }
}

export async function scanRepoSchemas(repo: string, schemas: readonly string[]): Promise<Record<string, SchemaEvidence>> {
  const evidence: Record<string, SchemaEvidence> = Object.fromEntries(schemas.map((s) => [s, { config: 0, code: 0 }]));
  if (schemas.length === 0) return evidence;
  const any = new RegExp(`(${schemas.map(escape).join('|')})`, 'i');
  const tests = schemas.map((s) => {
    const e = escape(s);
    return {
      schema: s,
      // `jdbc:mysql://host/app?`, `database: app`, `DB_NAME=app`.
      config: new RegExp(`(^|[/=:'"\\s])${e}(?=$|[?'"\\s;&,/])`, 'im'),
      // `app.users`, or `'app'` on its own.
      code: new RegExp(`(\\b${e}\\.[A-Za-z_\`"\\[])|(['"\`]${e}['"\`])`, 'gi'),
    };
  });

  let seen = 0;
  const files: string[] = [];
  for await (const file of walk(repo)) {
    const rel = path.relative(repo, file);
    if (SECRET.test(rel) || !(CONFIG.test(file) || CODE.test(file))) continue;
    files.push(file);
    if (++seen >= MAX_FILES) break;
  }

  const one = async (file: string) => {
    const text = await readSmall(file);
    if (!any.test(text)) return;
    const isConfig = CONFIG.test(file);
    for (const t of tests) {
      if (isConfig && t.config.test(text)) evidence[t.schema].config += 1;
      if (!isConfig) evidence[t.schema].code += Math.min(5, text.match(t.code)?.length ?? 0);
    }
  };
  for (let i = 0; i < files.length; i += 64) await Promise.all(files.slice(i, i + 64).map(one));
  return evidence;
}

// What an ORM calls a table's class, past the table's own name:
// `CampaignAssetRepository` for `campaign_asset`.
const CLASS_SUFFIX = /(repository|repo|dao|entity|model|mapper|record|service|table|dto|controller|row|s)$/;
/// SQL, code, and the XML ORMs keep their mappings in. Configuration is
/// left out: a table named in a YAML file says little about how it is used.
const MENTION = /\.(sql|prisma|[cm]?[jt]sx?|py|rb|java|kt|kts|scala|go|php|cs|ex|exs|rs|groovy|clj|erb|twig|xml)$/i;

/// Which files name each table, so a mapping pass reads those files instead
/// of searching the whole repo for them, and tables nothing names are not
/// handed to claude at all. A table is named as written (`campaign_asset`)
/// or as the class mapped to it (`CampaignAsset`, `campaignAssets`,
/// `CampaignAssetDao`). Over-matching costs a few extra files; missing a
/// table costs its whole description, so the match is generous. Only paths
/// leave here, relative to the repo; secrets files are never opened.
export async function scanTableMentions(repo: string, tables: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  const bySnake = new Map<string, string[]>();
  const bySquash = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, t: string) => {
    if (k.length < 3) return;
    const list = m.get(k);
    if (list) list.includes(t) || list.push(t);
    else m.set(k, [t]);
  };
  for (const t of tables) {
    const name = (t.includes('.') ? t.slice(t.indexOf('.') + 1) : t).toLowerCase();
    add(bySnake, name, t);
    const squash = name.replace(/_/g, '');
    add(bySquash, squash, t);
    if (squash.endsWith('s')) add(bySquash, squash.slice(0, -1), t);
  }

  const files: string[] = [];
  for await (const file of walk(repo)) {
    const rel = path.relative(repo, file);
    if (SECRET.test(rel) || !MENTION.test(file)) continue;
    files.push(file);
    if (files.length >= MAX_FILES) break;
  }

  const one = async (file: string) => {
    const text = await readSmall(file);
    const rel = path.relative(repo, file);
    const seen = new Set<string>();
    for (const tok of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const lower = tok.toLowerCase();
      const hits = [...(bySnake.get(lower) ?? [])];
      if (!tok.includes('_')) {
        hits.push(...(bySquash.get(lower) ?? []));
        const bare = lower.replace(CLASS_SUFFIX, '');
        if (bare !== lower) hits.push(...(bySquash.get(bare) ?? []), ...(bySquash.get(bare.replace(CLASS_SUFFIX, '')) ?? []));
      }
      for (const t of hits) found.get(t)!.add(rel);
    }
  };
  for (let i = 0; i < files.length; i += 64) await Promise.all(files.slice(i, i + 64).map(one));
  return new Map([...found].map(([t, s]) => [t, [...s].sort()]));
}
