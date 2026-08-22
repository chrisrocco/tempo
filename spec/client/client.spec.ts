/**
 * @fileoverview
 * The client surface an operator tool is assembled from.
 *
 * Driven against a real server over the RPC rather than a stub, because the point
 * of these methods is that they reach the server's own derived views — a stub
 * would prove only that the wrapper forwards, which is the part that cannot break
 * interestingly.
 *
 * The last block is the one to read: it pins the **author/operator split**, which
 * is a decision rather than a shape, and the only thing standing between it and a
 * well-meaning tidy-up that moves `reset` onto the handle.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
  createRemoteClient,
  type Client,
  type RemoteClient,
} from '../../src/client';
import {createLocalRuntime} from '../../src';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';

const activities = {
  // Unique to this file — see worker_entrypoint.spec.ts on why fixtures cannot share
  // an activity name.
  greetForClient: (name: string): string => `Hello, ${name}!`,
};

const act = proxyActivities(activities, {retry: {maximumAttempts: 1}});

async function greeter(name: string): Promise<string> {
  return act.greetForClient(name);
}

const workflows = {greeter};

interface Harness {
  client: Client;
  /** The same client, typed as what an operator tool actually holds. */
  remote: RemoteClient;
  teardown: () => Promise<void>;
}

/** A server, a worker, and a client over the RPC — the deployed shape. */
async function startDeployment(): Promise<Harness> {
  const host = createServerHost();
  const server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const worker = startWorker({
    name: 'greeter',
    serverUrl: url,
    identity: 'spec-worker',
    workflows,
    activities,
  });

  const remote = createRemoteClient(createRemoteService(url));

  return {
    client: remote,
    remote,
    teardown: async () => {
      await worker.stop();
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Retry until a value appears — a worker's first poll is what registers it. */
async function pollUntil<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('client — one execution', () => {
  it('starts a workflow and awaits its result', async () => {
    const {client, teardown} = await startDeployment();
    try {
      const handle = client.start<string>('greeter', 'world');

      expect(handle.workflowId).toBeTruthy();
      await expectAsync(handle.result()).toBeResolvedTo('Hello, world!');
    } finally {
      await teardown();
    }
  }, 15000);

  it('describes an execution: its status, its history, and what it awaits', async () => {
    const {client, teardown} = await startDeployment();
    try {
      const handle = client.start<string>('greeter', 'ada');
      await handle.result();
      const detail = await handle.describe();

      expect(detail?.workflowId).toBe(handle.workflowId);
      expect(detail?.name).toBe('greeter');
      expect(detail?.status).toBe('completed');
      expect(detail?.history.length).toBeGreaterThan(0);
    } finally {
      await teardown();
    }
  }, 15000);

  // An id nobody started is a question with an answer, not an error.
  it('describes an unknown execution as undefined', async () => {
    const {client, teardown} = await startDeployment();
    try {
      await expectAsync(
        client.getHandle('no-such-execution').describe(),
      ).toBeResolvedTo(undefined);
    } finally {
      await teardown();
    }
  }, 15000);

  it('starts on the queue it was given', async () => {
    const {client, teardown} = await startDeployment();
    try {
      const handle = client.start('greeter', 'world', {
        taskQueue: 'other-pool',
      });
      const detail = await handle.describe();

      expect(detail?.taskQueue).toBe('other-pool');
    } finally {
      await teardown();
    }
  }, 15000);
});

describe('client — reading the whole server', () => {
  it('lists executions, newest first', async () => {
    const {client, teardown} = await startDeployment();
    try {
      const first = client.start<string>('greeter', 'one');
      await first.result();
      const second = client.start<string>('greeter', 'two');
      await second.result();

      const page = await client.list();
      expect(page.executions[0]?.workflowId).toBe(second.workflowId);
      expect(page.executions.length).toBe(2);
    } finally {
      await teardown();
    }
  }, 15000);

  // The filter goes to the server, which is the point of it existing.
  it('filters server-side rather than narrowing a full page here', async () => {
    const {client, teardown} = await startDeployment();
    try {
      await client.start<string>('greeter', 'one').result();
      client.start('greeter', 'two', {taskQueue: 'other-pool'});

      const page = await client.list({taskQueue: 'other-pool'});
      expect(page.executions.length).toBe(1);
      expect(page.executions[0]?.taskQueue).toBe('other-pool');
    } finally {
      await teardown();
    }
  }, 15000);

  /**
   * The one read not derived from history: worker liveness is an observation the
   * running server made, and nothing durable backs it.
   */
  it('reports which queues are polled, and by whom', async () => {
    const {client, teardown} = await startDeployment();
    try {
      const queues = await pollUntil(async () => {
        const all = await client.queues();
        return all.length > 0 ? all : undefined;
      });

      const queue = queues.find((q) => q.taskQueue === 'default');
      expect(queue?.workers.map((w) => w.identity)).toContain('spec-worker');
    } finally {
      await teardown();
    }
  }, 15000);

  it('counts executions by status, grouped by queue and by name', async () => {
    const {client, teardown} = await startDeployment();
    try {
      await client.start<string>('greeter', 'one').result();

      const counts = await client.counts();
      const byName = counts.byName.find((g) => g.key === 'greeter');
      expect(byName?.completed).toBe(1);
      expect(counts.byTaskQueue.find((g) => g.key === 'default')?.total).toBe(
        1,
      );
    } finally {
      await teardown();
    }
  }, 15000);
});

describe('remote client — liveness and what the server is', () => {
  /**
   * `health` is also the reachability probe, which is why there is no separate
   * `ping`: every write on a handle is fire-and-forget — `signal`, `cancel`, and
   * `terminate` all return `void` — so without one, "sent" and "dropped into a
   * closed port" are the same thing from here.
   */
  it('reports uptime and where state lives', async () => {
    const {remote, teardown} = await startDeployment();
    try {
      const health = await remote.health();

      expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof health.durable).toBe('boolean');
    } finally {
      await teardown();
    }
  }, 15000);

  /**
   * The field to read first. An in-memory server loses every execution on its next
   * restart while completing workflows normally and reading healthy to whatever
   * supervises it — catastrophic and invisible, and exactly what a server started
   * without `--data-dir` looks like.
   */
  it('says a server is not durable when it is keeping history in memory', async () => {
    const {remote, teardown} = await startDeployment();
    try {
      const health = await remote.health();

      expect(health.durable).toBe(false);
      expect(health.dataLocation).toBeUndefined();
    } finally {
      await teardown();
    }
  }, 15000);

  // Rejecting *is* the answer to "not reachable". A caller wanting a boolean
  // catches; one wanting to name the address it tried has the error to do it with.
  it('rejects for a closed port, which is what makes it a probe', async () => {
    const remote = createRemoteClient(
      createRemoteService('http://127.0.0.1:1'),
    );

    await expectAsync(remote.health()).toBeRejected();
  }, 15000);
});

/**
 * The author/operator split, which is a decision and not a shape.
 *
 * `createLocalRuntime` hands out `WorkflowHandle`s, so anything on the handle is
 * reachable by a workflow author writing tests. `reset` is destructive and whether
 * an author may rewind their own execution is a separate question from whether an
 * operator may — unanswered, and recorded in
 * `spec/server/reset_to_event.spec.ts`. These two cases exist so that moving
 * `reset` onto the handle for symmetry fails instead of quietly reversing it.
 */
describe('client — what the author-facing handle deliberately omits', () => {
  it('keeps reset off the handle, so the runtime does not expose it', () => {
    const runtime = createLocalRuntime().registerWorkflow(
      'wf',
      async () => 'done',
    );
    try {
      const handle = runtime.start('wf');

      expect('cancel' in handle).toBe(true);
      expect('terminate' in handle).toBe(true);
      expect('reset' in handle).toBe(false);
    } finally {
      runtime.shutdown();
    }
  });

  it('puts reset on the client, which only an operator holds', async () => {
    const {client, teardown} = await startDeployment();
    try {
      expect(typeof client.reset).toBe('function');
    } finally {
      await teardown();
    }
  }, 15000);
});
