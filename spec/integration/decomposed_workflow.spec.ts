/**
 * @fileoverview
 * The case `proxyActivities` exists for: a workflow decomposed across modules,
 * served by a worker that was never told about its activities.
 *
 * `spec/support/decomposed.workflow.ts` calls two activities through a helper and
 * declares them itself. The worker below passes `workflows` and **no `activities` at
 * all** — importing the workflow module is the entire wiring. With a flat list at the
 * entrypoint this is the case that goes wrong: someone has to remember that a helper
 * three files away reaches for `payment_activities`, and forgetting produces an
 * execution parked on an activity that retries forever rather than a configuration
 * error.
 *
 * **This file does not reset the activity registry, on purpose.** The declaration it
 * depends on happened once, when the module was imported, and a reset cannot be
 * undone — module evaluation is cached, so `decomposed.workflow.ts` will never run
 * its `proxyActivities` again. Cases that need an empty registry live in
 * `proxy_activities.spec.ts`.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker} from '../../src/tempo';
import * as workflows from '../support/decomposed.workflow';

describe('a decomposed workflow declares its own activities', () => {
  it('is served by a worker that was passed no activities at all', async () => {
    const host = createServerHost();
    const server = createRpcServer(host);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const {port} = server.address() as AddressInfo;
    const service = createRemoteService(`http://127.0.0.1:${port}`);

    const worker = startWorker({
      name: 'orders',
      serverUrl: `http://127.0.0.1:${port}`,
      workflows,
    });

    try {
      // Both roles, from a declaration the entrypoint never saw.
      expect(worker.roles).toEqual(['workflow', 'activity']);

      const {workflowId} = service.start('placeOrder', ['abc']);
      await expectAsync(service.getResult(workflowId)).toBeResolvedTo(
        'charged abc, then emailed abc',
      );
    } finally {
      await worker.stop();
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15000);
});
