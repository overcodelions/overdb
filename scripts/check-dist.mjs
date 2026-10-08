import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }

    const relative = path.relative(root, file);
    if (/\.test\.[cm]?js$/i.test(relative)) {
      failures.push(`${relative}: compiled test file`);
      continue;
    }

    if (!/\.(?:js|html|css|json)$/i.test(relative)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//.test(text) || /[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\/i.test(text)) {
      failures.push(`${relative}: absolute user-home path`);
    }
  }
}

if (!fs.existsSync(root)) {
  console.error('dist does not exist; run the build first.');
  process.exit(1);
}

walk(root);

// Every top-level folder the build writes has to be in the packaging list,
// or the installed app is missing code it loads at runtime. v0.2.0 shipped
// without dist/helper and dist/builder and crashed on launch.
const packaged = new Set(
  JSON.parse(fs.readFileSync('package.json', 'utf8'))
    .build.files.map((pattern) => pattern.match(/^dist\/([^/*]+)\//)?.[1])
    .filter(Boolean),
);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && !packaged.has(entry.name)) {
    failures.push(`dist/${entry.name}: built but not in package.json build.files, so the packaged app would not have it`);
  }
}
if (failures.length) {
  console.error('Unsafe files found in the distributable tree:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Distributable tree contains no compiled tests or absolute user-home paths, and every built folder is packaged.');
