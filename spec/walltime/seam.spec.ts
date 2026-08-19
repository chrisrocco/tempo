/**
 * @fileoverview
 * The `walltime/` library's arm's-length contract, held mechanically.
 *
 * The library is internally owned but deliberately treated like a third-party
 * dependency: it knows nothing about the engine, and the engine touches it only
 * at named call sites. Two facts make that a real property rather than a hope,
 * and this file checks both against the actual tree:
 *
 * 1. **The library imports nothing.** Not engine layers, not Node builtins, not
 *    packages — a `walltime/` file may import only its own siblings. The moment
 *    an engine type leaks in, the library stops being removable.
 * 2. **The removal surface is a closed list.** Every `src/` file that imports
 *    the library is named below. Deleting the feature is: delete
 *    `src/walltime/`, revert these files to their numbers-only forms, delete
 *    the `calendar` member of `ScheduleSpec`. A new import site is allowed —
 *    but only by editing this list, which is the moment to ask whether the
 *    coupling is worth it.
 *
 * Static, by reading imports, for the same reason `client_entrypoint.spec.ts`
 * is: this is a property of the import graph, and nothing behavioural fails
 * when it erodes — it just quietly stops being true.
 */

import {readSourceFiles, stripCommentsAndStrings} from '../../tools/boundaries';
import {REPO_ROOT} from '../support/repo_root';
import * as path from 'node:path';

/**
 * Every import specifier in a file, type-only included — a type import is
 * erased at runtime but is still knowledge, and still breaks compilation when
 * the library is removed, so it belongs to the removal surface.
 */
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

const sources = readSourceFiles(REPO_ROOT, ['src']);

describe('the walltime library seam', () => {
  it('imports nothing from outside its own directory', () => {
    for (const file of sources) {
      if (!file.path.startsWith('src/walltime/')) continue;
      for (const specifier of importSpecifiers(file.text)) {
        const resolved = resolves(file.path, specifier);
        expect(resolved !== undefined && resolved.startsWith('src/walltime/'))
          .withContext(
            `${file.path} imports '${specifier}' — walltime/ is a library the engine ` +
              `treats as third-party, and a library that knows the engine cannot be removed`,
          )
          .toBe(true);
      }
    }
  });

  it('is imported only from the named removal surface', () => {
    const removalSurface = new Set([
      'src/core/workflow_api.ts', // sleep('30 minutes')
      'src/core/activity_options_input.ts', // Duration fields on activity options
      'src/schedule/next_fire.ts', // CalendarSpec -> WallClockRule dispatch
      'src/schedule/schedule_client.ts', // {every: '1 hour'} interval sugar
      'src/schedule/index.ts', // re-exports the Duration type
      'src/workflow.ts', // re-exports the Duration type
    ]);
    for (const file of sources) {
      if (file.path.startsWith('src/walltime/')) continue;
      const touches = importSpecifiers(file.text).some((specifier) =>
        resolves(file.path, specifier)?.startsWith('src/walltime'),
      );
      if (!touches) continue;
      expect(removalSurface.has(file.path))
        .withContext(
          `${file.path} imports walltime/ but is not on the removal surface — ` +
            `either the coupling is unintended, or add it here deliberately`,
        )
        .toBe(true);
    }
  });

  // The counterpart, so the list cannot rot into naming files that no longer
  // exist or no longer import the library — a stale surface overstates the
  // removal cost the same way a missing entry understates it.
  it('names no file that does not actually import it', () => {
    const byPath = new Map(sources.map((file) => [file.path, file]));
    for (const filePath of [
      'src/core/workflow_api.ts',
      'src/core/activity_options_input.ts',
      'src/schedule/next_fire.ts',
      'src/schedule/schedule_client.ts',
      'src/schedule/index.ts',
      'src/workflow.ts',
    ]) {
      const file = byPath.get(filePath);
      expect(file)
        .withContext(`${filePath} is gone — update the surface`)
        .toBeDefined();
      expect(
        importSpecifiers(file!.text).some((specifier) =>
          resolves(filePath, specifier)?.startsWith('src/walltime'),
        ),
      )
        .withContext(
          `${filePath} no longer imports walltime/ — shrink the surface`,
        )
        .toBe(true);
    }
  });
});
