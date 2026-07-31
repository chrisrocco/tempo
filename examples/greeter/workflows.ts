/**
 * @fileoverview
 * The workflow half of the greeter worker: deterministic orchestration that
 * reaches I/O only through activities. `import type * as activities` is a
 * type-only import, so the activity implementations never enter the workflow
 * bundle while the compiler still checks every call against them.
 */

import { proxyActivities } from '../../src/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({
  retry: { maximumAttempts: 3 },
});

export async function greeter(name: string): Promise<string> {
  return greet(name);
}
