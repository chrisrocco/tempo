// ★ AUTHOR ENTRYPOINT — workflow code imports ONLY from here.
//
// This module re-exports exclusively the deterministic primitives from `core`.
// Nothing here touches I/O, the clock, or randomness, which is the whole point:
// the import-path lint rule (deferred to a later milestone) keys on this file to
// keep the determinism boundary enforced rather than merely documented. If you
// find yourself wanting to add a non-deterministic capability here, it belongs
// on the runtime/host side instead. See doc 01.
export {
  runActivity,
  proxyActivities,
  sleep,
  executeChild,
  startChild,
  type ChildHandle,
  continueAsNew,
  workflowInfo,
  type WorkflowInfo,
} from './core/workflow_api';
export { defineSignal, setHandler, type SignalDef } from './core/signals';
export { condition } from './core/condition';
export { CancelledFailure } from './core/errors';

// author-facing option types (erased at runtime; safe on the deterministic surface)
export type { ActivityOptions, RetryPolicy } from './protocol';
