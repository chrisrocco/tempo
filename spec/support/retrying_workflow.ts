/**
 * @fileoverview
 * The other way a process can have pending work and not know it: an activity
 * waiting out a retry backoff, with no timer anywhere in the workflow.
 *
 * Same shape as `parked_workflow.ts` and the same reason for being a separate
 * process — see `spec/integration/process_lifetime.spec.ts`. The distinction
 * matters because the two are scheduled by different code: workflow `sleep`
 * goes through the `TimerService`, while a retry backoff is a bare `setTimeout`
 * inside `server_core`. Fixing one does nothing for the other.
 *
 * The first attempt fails, and the backoff is long enough that the process has
 * nothing else left to do while it waits.
 */

import {createLocalRuntime} from '../../src';
import {proxyActivities} from '../../src/workflow';

const BACKOFF_MS = 200;

let attempts = 0;

const activities = {
  flaky: () => {
    attempts++;
    if (attempts === 1) throw new Error('first attempt fails');
    process.stdout.write('WORKFLOW_FINISHED\n');
    return 'ok';
  },
};

const act = proxyActivities(activities, {
  retry: {maximumAttempts: 3, initialIntervalMs: BACKOFF_MS},
});

const rt = createLocalRuntime()
  .registerActivity('flaky', activities.flaky)
  .registerWorkflow('retrying', async () => act.flaky());

rt.start('retrying', undefined, {workflowId: 'retrying-1'});

process.stdout.write('SCRIPT_ENDED\n');
