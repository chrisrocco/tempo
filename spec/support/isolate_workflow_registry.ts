/**
 * @fileoverview
 * Scoped isolation for the process-global workflow registry — the twin of
 * `isolate_activity_registry.ts`, with its rules: **call inside a `describe`,
 * never at a file's top level** (a bare top-level `beforeEach` registers
 * globally in Jasmine and runs before every case in the suite), and restore
 * rather than clear, because a module-scope `createWorkflow` runs once per
 * process and a cleared registration cannot be recreated.
 */

import {
  createWorkflow,
  registeredWorkflowImpls,
  resetWorkflowRegistry,
} from '../../src/workflow_registry';
import type {AnyWorkflowFn} from '../../src/workflow_descriptor';

/** Give the enclosing `describe` an empty registry, and put the old one back after. */
export function isolateWorkflowRegistry(): void {
  let saved: ReturnType<typeof registeredWorkflowImpls> = [];

  beforeEach(() => {
    saved = registeredWorkflowImpls();
    resetWorkflowRegistry();
  });

  afterEach(() => {
    resetWorkflowRegistry();
    // Restored through `createWorkflow` (the references it mints go unused):
    // the registry was just cleared, and each saved name held one function, so
    // this re-records no conflicts — the same fidelity the activity helper has.
    for (const [key, fn] of saved)
      createWorkflow({key, run: fn as AnyWorkflowFn});
  });
}
