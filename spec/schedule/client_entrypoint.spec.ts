/**
 * @fileoverview
 * `workflow-engine/schedule` must stay safe to import from a browser.
 *
 * The property: nothing reachable from the client entrypoint evaluates workflow code.
 * The scheduler workflow calls `proxyActivities` at module scope, so importing it
 * registers activities into a process-global registry as a side effect — correct in a
 * worker binary, and wrong in a dashboard, which would also be pulling the engine's
 * runtime into its bundle to get a client.
 *
 * That is exactly what `src/schedule/index.ts` did for a day, and nothing failed: the
 * import graph is not something the compiler or the boundary checker has an opinion
 * about here, since these are all same-layer files. So it is checked by reading the
 * imports.
 *
 * Static rather than behavioural on purpose. The obvious runtime test — import the
 * client and assert the activity registry is untouched — cannot work in this suite: the
 * registry is process-global and other spec files load the workflow module at their own
 * import time, so the assertion would be about whichever file Jasmine reached first.
 */

import * as fs from 'node:fs';
import {stripCommentsAndStrings} from '../../tools/boundaries';
import {repoPath} from '../support/repo_root';

/** Runtime imports only — `import type` is erased and cannot pull anything in. */
function valueImports(file: string): string[] {
  const source = stripCommentsAndStrings(
    fs.readFileSync(repoPath(file), 'utf8'),
  );
  const specifiers: string[] = [];
  // `import ... from 'x'` and `export ... from 'x'`, skipping the type-only forms.
  const pattern =
    /(^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)from\s*'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const [, , , typeKeyword, clause, specifier] = match;
    if (typeKeyword !== undefined) continue; // `import type {...} from` — erased
    // A clause of only `type`-prefixed members is erased too: `export {type A} from`.
    const members = clause?.match(/\{([^}]*)\}/)?.[1];
    if (
      members !== undefined &&
      members
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
        .every((m) => m.startsWith('type '))
    )
      continue;
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe('the schedule client entrypoint', () => {
  it('does not reach the scheduler workflow at runtime', () => {
    expect(valueImports('src/schedule/index.ts')).not.toContain(
      './scheduler.workflow',
    );
  });

  /**
   * Transitively, too. `schedule_client.ts` may name the workflow's types — those are
   * erased — but must not import it for a value, and the arithmetic must stay pure.
   * `calendar.ts` is on the list on both sides: reachable (it is the calendar
   * arithmetic `next_fire.ts` dispatches to, and `Intl` is a browser global) and
   * checked (it may reach nothing but protocol itself).
   */
  it('reaches only protocol and pure arithmetic', () => {
    const allowed = new Set([
      '../protocol',
      './schedule_client',
      './next_fire',
      './calendar',
    ]);
    for (const file of [
      'src/schedule/index.ts',
      'src/schedule/schedule_client.ts',
      'src/schedule/next_fire.ts',
      'src/schedule/calendar.ts',
    ])
      for (const specifier of valueImports(file))
        expect(allowed.has(specifier))
          .withContext(`${file} imports ${specifier} at runtime`)
          .toBe(true);
  });

  // The counterpart, asserted so the split stays meaningful in both directions: the
  // worker path is where evaluating the workflow is correct.
  it('leaves the worker entrypoint free to import the workflow', () => {
    expect(valueImports('src/schedule/worker.ts')).toContain(
      './scheduler.workflow',
    );
  });
});
