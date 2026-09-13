import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
fs.rmSync(dist, { recursive: true, force: true });
