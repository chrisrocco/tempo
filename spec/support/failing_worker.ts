/**
 * @fileoverview
 * A worker entrypoint whose workflow settles as *failed*, for asserting that a
 * command's exit code follows the execution's outcome.
 *
 * It has to fail this particular way to be a useful fixture. An activity that
 * throws is reported as a failed activity, the workflow's await rejects, and the
 * execution settles as `failed` — a final state. The neighbouring failure, a
 * workflow that cannot be *replayed* at all (an unknown name, a throw in the
 * workflow body), is deliberately not final: the server records a task failure
 * and retries forever, because the fix is a redeploy (see
 * spec/server/task_failure.spec.ts). Only the first kind ever settles, so only
 * the first kind can be awaited by a caller that expects an answer.
 *
 * It lives in spec/support/ rather than examples/ because nothing about it is
 * exemplary — the reference worker is examples/greeter.ts.
 */

import {startWorker} from '../../src';
import {runActivity} from '../../src/workflow';

const activities = {
  boom: (): never => {
    throw new Error('activity exploded');
  },
};

const workflows = {
  // No catch: the activity failure propagates and settles the execution.
  failer: async (): Promise<unknown> => runActivity('boom'),
};

startWorker({name: 'failing', activities, workflows});
