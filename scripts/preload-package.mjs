// The app is ES modules, but the sandboxed preload must be CommonJS: this marks its folder as such.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'preload');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
