/**
 * @fileoverview
 * `heartbeat()` as an activity author meets it: ambient, callable as often as is
 * convenient, and inert outside an activity so an activity function stays an
 * ordinary function you can call from a test.
 */

import {
  createActivityRegistry,
  createActivityWorker,
  heartbeat,
} from '../../src/worker';
import type { ActivityTask } from '../../src/protocol';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function task(options: ActivityTask['options'] = {}): ActivityTask {
  return { workflowId: 'wf', seq: 0, name: 'agent', args: [], options };
}

describe('heartbeat from inside an activity', () => {
  it('reaches the worker while the activity is running', async () => {
    const beats: number[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      return 'done';
    });

    const result = await createActivityWorker(registry).runTask(task(), () =>
      beats.push(Date.now()),
    );

    expect(result).toEqual({ ok: true, result: 'done' });
    expect(beats.length).toBe(1);
  });

  it('reaches the worker from a callback several awaits deep', async () => {
    // AsyncLocalStorage is what makes this work: the context follows the
    // continuation, so a heartbeat inside a helper the activity awaited still
    // finds the attempt it belongs to.
    const beats: number[] = [];
    const registry = createActivityRegistry();
    const step = async (): Promise<void> => {
      await wait(1);
      heartbeat();
    };
    registry.set('agent', async () => {
      await step();
      await step();
      return 'done';
    });

    await createActivityWorker(registry).runTask(task({}), () =>
      beats.push(Date.now()),
    );

    expect(beats.length).toBeGreaterThan(0);
  });

  /**
   * An agent looping over a hundred documents will call this a hundred times.
   * The server only needs to hear often enough to keep the deadline from firing,
   * so the flood is absorbed here rather than turned into RPC.
   */
  it('throttles a chatty activity to far fewer sends than calls', async () => {
    let sends = 0;
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      for (let i = 0; i < 500; i++) heartbeat();
      return 'done';
    });

    await createActivityWorker(registry).runTask(
      task({ heartbeatTimeoutMs: 10_000 }),
      () => {
        sends += 1;
      },
    );

    expect(sends).toBe(1); // 500 calls, one send
  });

  it('sends again once the throttle window has passed', async () => {
    let sends = 0;
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      await wait(40);
      heartbeat();
      return 'done';
    });

    // Window is half the timeout, so 20ms — the 40ms wait clears it.
    await createActivityWorker(registry).runTask(
      task({ heartbeatTimeoutMs: 40 }),
      () => {
        sends += 1;
      },
    );

    expect(sends).toBe(2);
  });

  it('does nothing when an activity function is called outside the engine', () => {
    // Directly, as a unit test would — no worker, no context, no throw.
    expect(() => heartbeat()).not.toThrow();
  });

  it('discards heartbeats when the worker was given nowhere to send them', async () => {
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      return 'done';
    });

    const result = await createActivityWorker(registry).runTask(task());

    expect(result).toEqual({ ok: true, result: 'done' });
  });
});
