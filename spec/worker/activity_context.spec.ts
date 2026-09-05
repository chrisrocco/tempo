/**
 * @fileoverview
 * `heartbeat()` as an activity author meets it: ambient, callable as often as is
 * convenient, and inert outside an activity so an activity function stays an
 * ordinary function you can call from a test. And its reply as the author meets
 * that: `cancellationRequested()` and `cancellationSignal()`, which flip on the
 * beat that hears the execution was cancelled and never otherwise.
 */

import type {ActivityTask, HeartbeatReply} from '../../src/protocol';
import {
  cancellationRequested,
  cancellationSignal,
  createActivityRegistry,
  createActivityWorker,
  heartbeat,
} from '../../src/worker';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function task(options: ActivityTask['options'] = {}): ActivityTask {
  return {workflowId: 'wf', seq: 0, name: 'agent', args: [], options};
}

describe('heartbeat from inside an activity', () => {
  it('reaches the worker while the activity is running', async () => {
    const beats: number[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      return 'done';
    });

    const result = await createActivityWorker(registry).runTask(task(), () => {
      beats.push(Date.now());
    });

    expect(result).toEqual({ok: true, result: 'done'});
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

    await createActivityWorker(registry).runTask(task({}), () => {
      beats.push(Date.now());
    });

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
      task({heartbeatTimeoutMs: 10_000}),
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

    // Window is a fifth of the timeout, so 8ms — the 40ms wait clears it.
    await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 40}),
      () => {
        sends += 1;
      },
    );

    expect(sends).toBe(2);
  });

  /**
   * The window is what stands between a live activity and a deadline that fires
   * on it, so its size is a guarantee rather than a tuning detail. Beats inside
   * it are dropped rather than deferred, which means the spacing between the
   * sends that leave reaches *twice* the window for an activity beating just
   * faster than it reopens — so only a window well under half the timeout keeps
   * that doubled gap clear of the deadline. A fifth doubles to 40% of it.
   */
  it('reopens the window a fifth of the way into the timeout', async () => {
    let sends = 0;
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      await wait(60);
      heartbeat();
      return 'done';
    });

    // 60ms clears a fifth of 200ms; it would not clear a half.
    await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 200}),
      () => {
        sends += 1;
      },
    );

    expect(sends).toBe(2);
  });

  it('carries a checkpoint through to the send', async () => {
    const sent: unknown[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat({jobId: 'q-8823', pct: 40});
      return 'done';
    });

    await createActivityWorker(registry).runTask(task(), (checkpoint) => {
      sent.push(checkpoint);
    });

    expect(sent).toEqual([{jobId: 'q-8823', pct: 40}]);
  });

  // Dropped outright rather than buffered — safe only because the one that gets
  // through is complete. An author reporting a delta would lose it here.
  it('drops a beat inside the window along with its checkpoint', async () => {
    const sent: unknown[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat({pct: 10});
      heartbeat({pct: 20});
      heartbeat({pct: 30});
      return 'done';
    });

    await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 10_000}),
      (checkpoint) => {
        sent.push(checkpoint);
      },
    );

    expect(sent).toEqual([{pct: 10}]); // the first survives, and it is complete
  });

  it('sends the checkpoint current at the moment the window reopens', async () => {
    const sent: unknown[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat({pct: 10});
      await wait(40);
      heartbeat({pct: 90});
      return 'done';
    });

    await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 40}),
      (checkpoint) => {
        sent.push(checkpoint);
      },
    );

    expect(sent).toEqual([{pct: 10}, {pct: 90}]);
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

    expect(result).toEqual({ok: true, result: 'done'});
  });
});

describe('cancellation from inside an activity', () => {
  /** A server that answers `cancelRequested` from the `n`th beat onward. */
  function serverCancellingAfter(beats: number): () => Promise<HeartbeatReply> {
    let sent = 0;
    return async () => ({cancelRequested: ++sent > beats});
  }

  /** Beats every few ms until told to stop, then throws — the shape of an agent loop. */
  function loopUntilCancelled(observed: {stoppedAfter?: number}) {
    return async (): Promise<string> => {
      for (let i = 0; i < 200; i++) {
        heartbeat();
        await wait(2);
        if (cancellationRequested()) {
          observed.stoppedAfter = i;
          throw new Error('stopped: execution cancelled');
        }
      }
      return 'ran to the end';
    };
  }

  it('flips cancellationRequested on the beat that hears it, and not before', async () => {
    const seen: boolean[] = [];
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      seen.push(cancellationRequested()); // before any beat
      heartbeat();
      await wait(5); // let the reply land
      seen.push(cancellationRequested());
      return 'done';
    });

    await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 4}),
      serverCancellingAfter(0),
    );

    expect(seen).toEqual([false, true]);
  });

  it('aborts cancellationSignal at the same moment', async () => {
    let aborted: boolean | undefined;
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      const signal = cancellationSignal();
      const before = signal.aborted;
      heartbeat();
      await wait(5);
      aborted = signal.aborted;
      return before;
    });

    const result = await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 4}),
      serverCancellingAfter(0),
    );

    expect(result).toEqual({ok: true, result: false}); // not aborted before the beat
    expect(aborted).toBeTrue();
  });

  /**
   * The point of the whole mechanism: a long loop that heartbeats stops within
   * one throttle window of the cancel, rather than running to the end.
   */
  it('lets a looping activity stop early, reported as cancelled rather than failed', async () => {
    const observed: {stoppedAfter?: number} = {};
    const registry = createActivityRegistry();
    registry.set('agent', loopUntilCancelled(observed));

    const result = await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 4}),
      serverCancellingAfter(2),
    );

    expect(result).toEqual(
      jasmine.objectContaining({
        ok: false,
        error: 'stopped: execution cancelled',
        cancelled: true,
      }),
    );
    expect(observed.stoppedAfter).toBeLessThan(200);
  });

  it('reports a throw before any cancellation as a plain failure', async () => {
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      throw new Error('boom');
    });

    const result = await createActivityWorker(registry).runTask(
      task(),
      serverCancellingAfter(99),
    );

    expect(result).toEqual(
      jasmine.objectContaining({ok: false, error: 'boom'}),
    );
    expect('cancelled' in result).toBeFalse();
  });

  /** The work happened; a return is a completion whatever the server said. */
  it('reports a return after cancellation as a completion', async () => {
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      await wait(5);
      return cancellationRequested() ? 'finished anyway' : 'never heard';
    });

    const result = await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 4}),
      serverCancellingAfter(0),
    );

    expect(result).toEqual({ok: true, result: 'finished anyway'});
  });

  it('never learns from a beat that failed to reach the server', async () => {
    const registry = createActivityRegistry();
    registry.set('agent', async () => {
      heartbeat();
      await wait(5);
      return cancellationRequested();
    });

    const result = await createActivityWorker(registry).runTask(
      task({heartbeatTimeoutMs: 4}),
      async () => undefined, // what the loop hands over when the RPC failed
    );

    expect(result).toEqual({ok: true, result: false});
  });

  it('is inert outside an activity: never cancelled, never aborted', () => {
    expect(cancellationRequested()).toBeFalse();
    expect(cancellationSignal().aborted).toBeFalse();
  });
});
