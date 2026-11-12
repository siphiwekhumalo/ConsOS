/** Pure routing rules for the desktop shell (no Electron imports, so they can be unit tested). */
import { join, normalize, sep } from 'node:path';

export const SERVICE_PREFIXES = ['/api/', '/sync/', '/ai/'];

/** Paths the load balancer sends to a backend service rather than to the web app. */
export function isServicePath(pathname: string): boolean {
  return SERVICE_PREFIXES.some((p) => pathname.startsWith(p));
}

/** The server must be HTTPS; plain HTTP is only allowed to localhost for development. Returns the origin. */
export function validateServer(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`The ConstructOS server must use https:// (got ${raw})`);
  }
  return url.origin;
}

/**
 * Map a URL path to a file under the web root. Returns null if the path tries
 * to escape the root (e.g. /../../secret). Unknown paths fall back to
 * index.html (client-side routes) — the caller checks existence.
 */
export function resolveStatic(root: string, pathname: string): string | null {
  const base = normalize(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const joined = normalize(join(base, decoded));
  // Drop a trailing separator ("/" → the root itself), but never strip a filesystem root.
  const target = joined.length > base.length && /[\\/]$/.test(joined) ? joined.slice(0, -1) : joined;
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/** Request headers that must not be forwarded from the app origin to the server. */
export function forwardHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const h of ['origin', 'referer', 'host', 'cookie']) headers.delete(h);
  return headers;
}
