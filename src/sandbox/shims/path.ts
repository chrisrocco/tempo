/**
 * `node:path`, for a browser — see `fs.ts` for why this is here at all.
 *
 * Unlike the `fs` stub these are implemented rather than throwing: joining
 * strings is harmless, needs no disk, and a real implementation costs four
 * lines. Only the file store calls them, and only on a path the sandbox never
 * takes, but a working `join` cannot be the thing that breaks.
 */
export function join(...parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function dirname(p: string): string {
  const index = p.replace(/\/+$/, '').lastIndexOf('/');
  return index <= 0 ? '/' : p.slice(0, index);
}

export function resolve(...parts: string[]): string {
  return join(...parts);
}

export function basename(p: string): string {
  return p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1);
}

export default {join, dirname, resolve, basename};
