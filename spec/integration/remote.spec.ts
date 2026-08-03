/**
 * @fileoverview
 * End to end over the RPC transport: a real HTTP server hosting the headless
 * server, workflow + activity workers polling it via RemoteService, and a client
 * starting + awaiting results — all over the wire (loopback). Slice 4 splits these
 * into separate processes; here they share one process but only touch each other
 * through HTTP.
 */

import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  runActivityWorker,
  runWorkflowWorker,
  type WorkerLoop,
} from '../../src/worker';
import {
  condition,
  defineSignal,
  runActivity,
  setHandler,
} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

interface Harness {
  service: ReturnType<typeof createRemoteService>;
  registerWorkflow: (
    name: string,
    fn: (...a: any[]) => Promise<unknown>,
  ) => void;
  registerActivity: (name: string, fn: (...a: any[]) => unknown) => void;
  teardown: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const host = createServerHost();
  const server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  const service = createRemoteService(`http://127.0.0.1:${port}`);

  const workflowRegistry = createWorkflowRegistry();
  const activityRegistry = createActivityRegistry();
  const loops: WorkerLoop[] = [
    runWorkflowWorker(service, createWorkflowWorker(workflowRegistry)),
    runActivityWorker(service, createActivityWorker(activityRegistry)),
  ];

  return {
    service,
    registerWorkflow: (name, fn) => workflowRegistry.set(name, fn),
    registerActivity: (name, fn) => activityRegistry.set(name, fn),
    teardown: async () => {
      await Promise.all(loops.map((l) => l.stop()));
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('distributed — client + workers over RPC', () => {
  it('runs an activity workflow across server and workers', async () => {
    const h = await startHarness();
    try {
      h.registerActivity('greet', (n: string) => `hi ${n}`);
      h.registerWorkflow('greeter', async () =>
        runActivity<string>('greet', 'world'),
      );

      const {workflowId} = h.service.start('greeter');
      await expectAsync(h.service.getResult(workflowId)).toBeResolvedTo(
        'hi world',
      );
    } finally {
      await h.teardown();
    }
  });

  // A workflow that throws must reach the client as its own message. The failure
  // crosses the wire as JSON, where an `Error` would serialize to `{}` and arrive
  // as "[object Object]" — so what travels has to be the message itself.
  it('surfaces a failing workflow to the client with its message intact', async () => {
    const h = await startHarness();
    try {
      h.registerWorkflow('boom', async () => {
        throw new Error('kaboom');
      });

      const {workflowId} = h.service.start('boom');
      await expectAsync(h.service.getResult(workflowId)).toBeRejectedWithError(
        /kaboom/,
      );
    } finally {
      await h.teardown();
    }
  });

  it('delivers a signal that unblocks a condition, over the wire', async () => {
    const h = await startHarness();
    try {
      h.registerWorkflow('waiter', async () => {
        let go = false;
        setHandler(defineSignal('go'), () => {
          go = true;
        });
        await condition(() => go);
        return 'went';
      });

      const {workflowId} = h.service.start('waiter');
      await wait(30); // let the execution be created + park before signalling
      h.service.signal(workflowId, 'go');

      await expectAsync(h.service.getResult(workflowId)).toBeResolvedTo('went');
    } finally {
      await h.teardown();
    }
  });
});
