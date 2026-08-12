/**
 * @fileoverview
 * Scoped isolation for the process-global activity registry.
 *
 * `defineActivities` writes to one map for the whole process, at module scope, so a
 * spec file that imports a workflow module declaring activities registers them for
 * every case in the suite. A file asserting "this worker has no activities" therefore
 * has to own the registry while it runs.
 *
 * **Call this inside a `describe`, never at a file's top level.** A bare
 * `beforeEach` at the top level of a spec file registers globally in Jasmine — it
 * runs before every case in the *suite*, not just that file. Doing this wrong is how
 * an isolation hook in one file silently cleared the load-time declaration another
 * file depended on, which passes in isolation and fails only in the full run.
 *
 * Restores what was there rather than leaving the registry empty, because a cleared
 * registration cannot be recreated: module evaluation is cached, so a workflow
 * module's declaration will never run a second time.
 */

import {
  registerActivityImpls,
  registeredActivityImpls,
  resetActivityRegistry,
} from '../../src/activity_registry';

/** Give the enclosing `describe` an empty registry, and put the old one back after. */
export function isolateActivityRegistry(): void {
  let saved: ReturnType<typeof registeredActivityImpls> = [];

  beforeEach(() => {
    saved = registeredActivityImpls();
    resetActivityRegistry();
  });

  afterEach(() => {
    resetActivityRegistry();
    registerActivityImpls(Object.fromEntries(saved));
  });
}
