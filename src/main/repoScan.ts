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
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size > MAX_BYTES) return;
    const text = await fs.readFile(file, 'utf-8').catch(() => '');
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
