/**
 * @fileoverview
 * The internal-library seam, as a reusable check — the mechanics that held
 * `walltime/` at arm's length, generalized so every package under
 * `src/libraries/` is held to the same contract by the same code.
 *
 * An internal library is repo-owned code deliberately treated like a
 * third-party dependency. Two facts make that a real property rather than a
 * hope, and `describeLibrarySeam` checks both against the actual tree:
 *
 * 1. **The library imports nothing.** Not engine layers, not Node builtins,
 *    not packages — a library file may import only its own siblings. The
 *    moment an engine type leaks in, the library stops being removable.
 * 2. **The removal surface is a closed list.** Every `src/` file that imports
 *    the library is named by the caller, with why. Deleting the library is:
 *    delete its directory, revert those files. A new import site is allowed —
 *    but only by editing the list, which is the moment to ask whether the
 *    coupling is worth it. The list is checked both ways: a file that imports
 *    without being named fails, and a named file that no longer imports (or no
 *    longer exists) fails, because a stale surface overstates the removal cost
 *    the same way a missing entry understates it.
 *
 * A third check guards against a phantom: the library must actually exist
 * under `src/libraries/` — location is the declaration, so a seam spec for a
 * directory that is not there (moved, renamed, deleted) fails by name instead
 * of silently checking nothing. The imports-nothing half is also enforced
 * repo-wide by the checker's `library-boundary` rule; this spec restates it so
 * a library's whole contract fails in one place, with its removal surface.
 *
 * Static, by reading imports, for the same reason `client_entrypoint.spec.ts`
 * is: this is a property of the import graph, and nothing behavioural fails
 * when it erodes — it just quietly stops being true. Type-only imports count:
 * a type import is erased at runtime but is still knowledge, and still breaks
 * compilation when the library is removed, so it belongs to the surface.
 */

import * as path from 'node:path';
import {
  internalLibraries,
  readSourceFiles,
  stripCommentsAndStrings,
} from '../../tools/boundaries';
import {REPO_ROOT} from './repo_root';

/** One file allowed to import the library, and the coupling it pays for. */
export interface RemovalSite {
  readonly path: string;
  readonly why: string;
}

function importSpecifiers(text: string): string[] {
  const stripped = stripCommentsAndStrings(text);
  const specifiers: string[] = [];
  for (const match of stripped.matchAll(
    /(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g,
  ))
    if (match[1] !== undefined) specifiers.push(match[1]);
  return specifiers;
}

function resolves(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
}

/**
 * Register the seam suite for one internal library. Call at a spec file's top
 * level; the caller's fileoverview carries the library-specific story (what it
 * does, what deleting it costs), and this carries the checks.
 */
export function describeLibrarySeam(options: {
  /** The layer name under `src/`, e.g. `'walltime'`. */
  library: string;
  removalSurface: readonly RemovalSite[];
}): void {
  const {library, removalSurface} = options;
  const dir = `src/libraries/${library}/`;
  const sources = readSourceFiles(REPO_ROOT, ['src']);
  const importsLibrary = (file: {path: string; text: string}) =>
    importSpecifiers(file.text).some((specifier) =>
      resolves(file.path, specifier)?.startsWith(`src/libraries/${library}`),
    );

  describe(`the ${library} library seam`, () => {
    it('exists under src/libraries/, where location is the declaration', () => {
      expect(internalLibraries(sources))
        .withContext(
          `'${library}' has a seam spec but no package under src/libraries/ — moved, renamed, or deleted without its spec`,
        )
        .toContain(library);
    });

    it('imports nothing from outside its own directory', () => {
      for (const file of sources) {
        if (!file.path.startsWith(dir)) continue;
        for (const specifier of importSpecifiers(file.text)) {
          const resolved = resolves(file.path, specifier);
          expect(resolved !== undefined && resolved.startsWith(dir))
            .withContext(
              `${file.path} imports '${specifier}' — ${library}/ is a library the engine ` +
                `treats as third-party, and a library that knows the engine cannot be removed`,
            )
            .toBe(true);
        }
      }
    });

    it('is imported only from the named removal surface', () => {
      const allowed = new Set(removalSurface.map((site) => site.path));
      for (const file of sources) {
        if (file.path.startsWith(dir)) continue;
        if (!importsLibrary(file)) continue;
        expect(allowed.has(file.path))
          .withContext(
            `${file.path} imports ${library}/ but is not on the removal surface — ` +
              `either the coupling is unintended, or add it to this spec deliberately, with why`,
          )
          .toBe(true);
      }
    });

    // The counterpart, so the list cannot rot into naming files that no longer
    // exist or no longer import the library.
    it('names no file that does not actually import it', () => {
      const byPath = new Map(sources.map((file) => [file.path, file]));
      for (const site of removalSurface) {
        const file = byPath.get(site.path);
        expect(file)
          .withContext(`${site.path} is gone — update the surface`)
          .toBeDefined();
        expect(importsLibrary(file!))
          .withContext(
            `${site.path} no longer imports ${library}/ — shrink the surface`,
          )
          .toBe(true);
      }
    });
  });
}
