import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function fileAt(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built web app from `webDir`. A path that is not a file answers with index.html so the app can
 * handle its own addresses; a missing file with an extension (a script, a font) is a plain 404.
 */
export function staticHandler(webDir: string) {
  const root = resolve(webDir);
  return async (c: Context): Promise<Response> => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.notFound();
    }
    const target = resolve(join(root, path));
    // Never leave the web folder, whatever the path says.
    const inside = target === root || target.startsWith(root + sep);
    const direct = inside && !path.endsWith('/') ? await fileAt(target) : null;
    if (direct) {
      const ext = extname(target).toLowerCase();
      // Built files carry a hash in their name, so they never change.
      const cache = target.startsWith(join(root, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache';
      return new Response(new Uint8Array(direct), { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cache } });
    }
    if (extname(path) !== '') return c.notFound();
    const index = await fileAt(join(root, 'index.html'));
    if (!index) return c.notFound();
    return new Response(new Uint8Array(index), { headers: { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' } });
  };
}
