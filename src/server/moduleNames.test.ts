// macOS and Windows ignore letter case in file names, so `./Dock.js` there can load `dock.ts`. Two modules in one
// folder whose names differ only by case build on Linux and break the installers on the other two.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function clashes(dir: string, found: string[]): string[] {
  const seen = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      clashes(path, found);
      continue;
    }
    const module = entry.name.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '').toLowerCase();
    const other = seen.get(module);
    if (other && other !== entry.name) found.push(`${relative(root, dir)}: ${other} and ${entry.name}`);
    else seen.set(module, entry.name);
  }
  return found;
}

describe('module names', () => {
  it('never differ only by letter case within a folder', () => {
    expect([...clashes(join(root, 'src'), []), ...clashes(join(root, 'electron'), [])]).toEqual([]);
  });
});
