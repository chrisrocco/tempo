/**
 * @fileoverview
 * Shutdown must be able to let go of a pending retry, not wait it out.
 *
 * The other side of ref'ing progress timers. Once a pending retry keeps the
 * process alive, an abandoned one would keep it alive *forever* — so a host has
 * to be able to drop them, which is what `ServerCore.stop` is for. Without it,
 * this script would sit here for the whole `BACKOFF_MS` after asking to stop.
 *
 * The backoff is deliberately far longer than the script's own patience, so the
 * assertion in `process_lifetime.spec.ts` can tell "released it" from "waited
 * it out" by elapsed time alone.
 */

import {createLocalRuntime} from '../../src';
import {proxyActivities} from '../../src/workflow';

const BACKOFF_MS = 30_000;

const activities = {
  alwaysFails: () => {
    process.stdout.write('ATTEMPTED\n');
    throw new Error('fails every time');
  },
};

const act = proxyActivities<typeof activities>({
  retry: {maximumAttempts: 5, initialIntervalMs: BACKOFF_MS},
});

const rt = createLocalRuntime()
  .registerActivity('alwaysFails', activities.alwaysFails)
  .registerWorkflow('doomed', async () => act.alwaysFails());

rt.start('doomed', [], {workflowId: 'doomed-1'});

// Long enough for the first attempt to fail and the backoff to be armed, short
// enough that it cannot be confused with waiting the backoff out.
setTimeout(() => {
  rt.shutdown();
  process.stdout.write('SHUTDOWN_CALLED\n');
}, 300);
