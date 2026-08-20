/**
 * @fileoverview
 * A deliberately naive script: start a workflow that parks on a timer, then let
 * the script end. Run as a child process by
 * `spec/integration/process_lifetime.spec.ts`.
 *
 * It has to be a separate process, because the bug it exists to catch is
 * invisible from inside the suite. Jasmine's runner holds the event loop open
 * for the whole run, so a workflow timer that cannot keep a process alive on its
 * own still always gets to fire here. Only a process with nothing else in it
 * shows the difference.
 *
 * Note what is deliberately absent: no `shutdown()`, no keepalive interval, and
 * nothing awaiting the result. That is the shape of a scratch script someone
 * writes to try the engine out, and it is exactly the shape that exits silently
 * with code 0 before the timer ever fires if a parked timer cannot hold the
 * process open.
 */

import {createLocalRuntime} from '../../src';
import {runActivity, sleep} from '../../src/workflow';

const PARK_MS = 150;

const rt = createLocalRuntime()
  .registerActivity('report', () => {
    process.stdout.write('WORKFLOW_FINISHED\n');
    return 'ok';
  })
  .registerWorkflow('parked', async () => {
    await sleep(PARK_MS);
    await runActivity('report');
    return 'done';
  });

rt.start('parked', undefined, {workflowId: 'parked-1'});

process.stdout.write('SCRIPT_ENDED\n');
