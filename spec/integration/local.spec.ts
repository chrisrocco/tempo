/**
 * @fileoverview
 * The canonical behavior spec: the whole author-facing programming model against
 * `createLocalRuntime`. **Start here to understand what the engine does** — these
 * tests are the executable documentation for behavior, so each `describe` names
 * one capability and each `it` states one guarantee as a sentence.
 *
 * It doubles as the characterization suite that locked the observable behavior
 * (activities, condition, signals, blocking children, timers) through the layered
 * restructure and the service-seam introduction, so each could be verified as
 * behavior-preserving.
 *
 * `createLocalRuntime` comes from the host entrypoint; the workflow primitives
 * come from the author entrypoint — mirroring how real host and workflow code
 * import them across the determinism boundary (see `src/workflow.ts`).
 */

import {createLocalRuntime} from '../../src';
import {cancellationRequested, heartbeat} from '../../src/activity';
import {
  CancelledFailure,
  condition,
  continueAsNew,
  executeChild,
  proxyActivities,
  runActivity,
  setHandler,
  signalWorkflow,
  sleep,
  startChild,
  workflowInfo,
} from '../../src/workflow';

// real-time wait, for letting async drives / timers make progress in a test
function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('local runtime — activities', () => {
  it('runs a single activity and returns its result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('greet', (name: string) => `hello ${name}`)
      .registerWorkflow('greeter', async () =>
        runActivity<string>('greet', 'world'),
      );

    const handle = rt.start<string>('greeter');
    await expectAsync(handle.result()).toBeResolvedTo('hello world');
    expect(handle.status()).toBe('completed');
  });

  it('runs activities sequentially in call order', async () => {
    const order: string[] = [];
    const rt = createLocalRuntime()
      .registerActivity('a', () => {
        order.push('a');
        return 1;
      })
      .registerActivity('b', () => {
        order.push('b');
        return 2;
      })
      .registerWorkflow('seq', async () => {
        const x = await runActivity<number>('a');
        const y = await runActivity<number>('b');
        return x + y;
      });

    await expectAsync(rt.start<number>('seq').result()).toBeResolvedTo(3);
    expect(order).toEqual(['a', 'b']);
  });

  it('runs concurrent activities and preserves deterministic seq ordering', async () => {
    const rt = createLocalRuntime()
      .registerActivity('double', (n: number) => n * 2)
      .registerWorkflow('fan', async () =>
        Promise.all([
          runActivity<number>('double', 1),
          runActivity<number>('double', 2),
          runActivity<number>('double', 3),
        ]),
      );

    await expectAsync(rt.start<number[]>('fan').result()).toBeResolvedTo([
      2, 4, 6,
    ]);
  });

  it('parks during a genuinely async activity and resumes on its reported result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('slow', async () => {
        await new Promise((r) => setTimeout(r, 15));
        return 'slow-result';
      })
      .registerWorkflow('wf', async () => runActivity<string>('slow'));

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'slow-result',
    );
  });

  it('drains concurrently-dispatched activities in FIFO (seq) order', async () => {
    const order: number[] = [];
    const rt = createLocalRuntime()
      .registerActivity('rec', (n: number) => {
        order.push(n);
        return n;
      })
      .registerWorkflow('fan', async () =>
        Promise.all([
          runActivity('rec', 1),
          runActivity('rec', 2),
          runActivity('rec', 3),
        ]),
      );

    await rt.start('fan').result();
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates an activity failure to the workflow result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => {
        throw new Error('kaboom');
      })
      .registerWorkflow('failing', async () => runActivity('boom'));

    const handle = rt.start('failing');
    await expectAsync(handle.result()).toBeRejectedWithError(/kaboom/);
    expect(handle.status()).toBe('failed');
  });

  it('lets the workflow catch an activity failure and continue', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => {
        throw new Error('kaboom');
      })
      .registerActivity('ok', () => 'recovered')
      .registerWorkflow('recovers', async () => {
        try {
          await runActivity('boom');
          return 'unreachable';
        } catch {
          return runActivity<string>('ok');
        }
      });

    await expectAsync(rt.start<string>('recovers').result()).toBeResolvedTo(
      'recovered',
    );
  });

  it('reports a missing activity as a failure', async () => {
    const rt = createLocalRuntime().registerWorkflow('missing', async () =>
      runActivity('does-not-exist'),
    );
    await expectAsync(rt.start('missing').result()).toBeRejectedWithError(
      /no activity does-not-exist/,
    );
  });
});

describe('local runtime — activity progress', () => {
  // The headline: `describe` — the call a dashboard makes — hands back where a
  // long activity has got to, while the attempt is still in flight.
  it('reports the checkpoint a running activity last heartbeated', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const rt = createLocalRuntime()
      .registerActivity('scan', async () => {
        heartbeat({jobId: 'q-8823', pct: 40});
        await blocked;
        return 'scanned';
      })
      .registerWorkflow('scanner', async () => runActivity<string>('scan'));

    const handle = rt.start<string>('scanner');
    await wait(20); // the attempt starts and beats

    const detail = await handle.describe();
    expect(detail!.pending.activities[0].checkpoint).toEqual({
      jobId: 'q-8823',
      pct: 40,
    });
    expect(detail!.pending.activities[0].checkpointAt).toBeDefined();

    release();
    await expectAsync(handle.result()).toBeResolvedTo('scanned');
  });

  it('stops reporting a checkpoint once the activity settles', async () => {
    const rt = createLocalRuntime()
      .registerActivity('scan', async () => {
        heartbeat({pct: 99});
        return 'scanned';
      })
      .registerWorkflow('scanner', async () => runActivity<string>('scan'));

    const handle = rt.start<string>('scanner');
    await expectAsync(handle.result()).toBeResolvedTo('scanned');

    const detail = await handle.describe();
    expect(detail!.pending.activities).toEqual([]);
  });
});

describe('local runtime — proxyActivities & retries', () => {
  it('calls activities through a typed proxy', async () => {
    const activities = {add: (a: number, b: number) => a + b};
    // Declared outside the workflow: this is a module-load declaration, not something
    // to re-run on every replay.
    const {add} = proxyActivities(activities);
    const rt = createLocalRuntime()
      .registerActivity('add', activities.add)
      .registerWorkflow('sum', async () => add(2, 3));

    await expectAsync(rt.start<number>('sum').result()).toBeResolvedTo(5);
  });

  it('proxies an activities module that also exports non-functions', async () => {
    // A real activities module exports constants alongside its activities; the
    // proxy takes the whole namespace and keeps only what it can call.
    const activities = {
      GREETING: 'Hello',
      greet: (name: string) => `Hello, ${name}!`,
    };
    const proxy = proxyActivities(activities);
    const rt = createLocalRuntime()
      .registerActivity('greet', activities.greet)
      .registerWorkflow('wf', async () => {
        // @ts-expect-error constants are not callable, so they are not proxied
        proxy.GREETING;
        return proxy.greet('world');
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'Hello, world!',
    );
  });

  it('does not retry by default (maximumAttempts defaults to 1)', async () => {
    let attempts = 0;
    const activities = {
      once: () => {
        attempts += 1;
        throw new Error('boom');
      },
    };
    const {once} = proxyActivities(activities);
    const rt = createLocalRuntime()
      .registerActivity('once', activities.once)
      .registerWorkflow('wf', async () => once());

    await expectAsync(rt.start('wf').result()).toBeRejectedWithError(/boom/);
    expect(attempts).toBe(1);
  });

  it('retries a flaky activity and succeeds within maximumAttempts', async () => {
    let attempts = 0;
    const activities = {
      flaky: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('not yet');
        return 'ok-after-retries';
      },
    };
    const flakyProxy = proxyActivities(activities, {
      retry: {maximumAttempts: 3},
    });
    const rt = createLocalRuntime()
      .registerActivity('flaky', activities.flaky)
      .registerWorkflow('wf', async () => flakyProxy.flaky());

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'ok-after-retries',
    );
    expect(attempts).toBe(3);
  });

  it('surfaces the failure after exhausting attempts', async () => {
    let attempts = 0;
    const activities = {
      always: () => {
        attempts += 1;
        throw new Error('persistent');
      },
    };
    const alwaysProxy = proxyActivities(activities, {
      retry: {maximumAttempts: 2},
    });
    const rt = createLocalRuntime()
      .registerActivity('always', activities.always)
      .registerWorkflow('wf', async () => alwaysProxy.always());

    await expectAsync(rt.start('wf').result()).toBeRejectedWithError(
      /persistent/,
    );
    expect(attempts).toBe(2);
  });
});

describe('local runtime — signals and condition', () => {
  it('parks on a condition and wakes when a signal makes it true', async () => {
    const rt = createLocalRuntime().registerWorkflow('waiter', async () => {
      let go = false;
      setHandler('go', () => {
        go = true;
      });
      await condition(() => go);
      return 'went';
    });

    const handle = rt.start<string>('waiter');
    expect(handle.status()).toBe('running');
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');
  });

  it('delivers the signal payload to the handler', async () => {
    const rt = createLocalRuntime().registerWorkflow('collector', async () => {
      let value: number | undefined;
      setHandler('set', (v: number) => {
        value = v;
      });
      await condition(() => value !== undefined);
      return value;
    });

    const handle = rt.start<number>('collector');
    handle.signal('set', 42);
    await expectAsync(handle.result()).toBeResolvedTo(42);
  });

  /**
   * The signal lands between the start and the worker's first poll, so task one
   * has a history of `[signal]` — and the workflow's first activity is reached
   * before any of it is consumed. Suppressing that activity leaves the run parked
   * on work nobody was asked to do, with nothing raised: `status` stays `running`
   * forever. Issue #39, at the layer an author would meet it.
   */
  it('runs its first activity when a signal arrives before the first task', async () => {
    const rt = createLocalRuntime()
      .registerActivity('work', () => 'done')
      .registerWorkflow('greeter', async () => {
        const seen: string[] = [];
        setHandler('ping', (p: string) => seen.push(p));
        const result = await runActivity<string>('work');
        return `${result}/${seen.join(',')}`;
      });

    const handle = rt.start<string>('greeter');
    await handle.signal('ping', 'early');

    await expectAsync(handle.result()).toBeResolvedTo('done/early');
  });

  it('accumulates repeated signals before the condition is satisfied', async () => {
    const rt = createLocalRuntime().registerWorkflow('adder', async () => {
      let total = 0;
      let count = 0;
      setHandler('add', (n: number) => {
        total += n;
        count += 1;
      });
      await condition(() => count >= 3);
      return total;
    });

    const handle = rt.start<number>('adder');
    handle.signal('add', 10);
    handle.signal('add', 20);
    handle.signal('add', 12);
    await expectAsync(handle.result()).toBeResolvedTo(42);
  });
});

describe('local runtime — child workflows', () => {
  it('runs a blocking child and returns its result to the parent', async () => {
    const rt = createLocalRuntime()
      .registerActivity('square', (n: number) => n * n)
      .registerWorkflow('child', async ({n}: {n: number}) =>
        runActivity<number>('square', n),
      )
      .registerWorkflow('parent', async () => {
        const a = await executeChild<number>('child', {props: {n: 3}});
        const b = await executeChild<number>('child', {props: {n: 4}});
        return a + b;
      });

    await expectAsync(rt.start<number>('parent').result()).toBeResolvedTo(25);
  });

  it('runs concurrent blocking children without double-dispatching them', async () => {
    const worked: number[] = [];
    const rt = createLocalRuntime()
      .registerActivity('work', (n: number) => {
        worked.push(n);
        return n * 10;
      })
      .registerWorkflow('child', async ({n}: {n: number}) =>
        runActivity<number>('work', n),
      )
      .registerWorkflow('parent', async () =>
        Promise.all([
          executeChild<number>('child', {props: {n: 1}}),
          executeChild<number>('child', {props: {n: 2}}),
        ]),
      );

    const result = await rt.start<number[]>('parent').result();
    expect(result).toEqual([10, 20]); // Promise.all preserves order
    expect(worked.sort()).toEqual([1, 2]); // each child ran exactly once (marker prevents re-launch)
  });

  it('propagates a child failure to the parent', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => {
        throw new Error('child-boom');
      })
      .registerWorkflow('child', async () => runActivity('boom'))
      .registerWorkflow('parent', async () => executeChild('child'));

    await expectAsync(rt.start('parent').result()).toBeRejectedWithError(
      /child-boom/,
    );
  });

  it('gives a child the workflow id the parent chose', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('child', async () => 'done')
      .registerWorkflow('parent', async () =>
        executeChild('child', {workflowId: 'plan-for-event-42'}),
      );

    await rt.start('parent').result();
    expect(rt.getHandle('plan-for-event-42').status()).toBe('completed');
  });

  /**
   * The point of choosing the id: it is a claim on one execution, so asking
   * twice for the same real-world thing gets the same child rather than a second
   * one. A scanner that sees the same calendar event on two consecutive polls
   * relies on this.
   */
  it('starts one child when the same workflow id is claimed twice', async () => {
    let started = 0;
    const rt = createLocalRuntime()
      .registerWorkflow('child', async () => {
        started += 1;
        return started;
      })
      .registerWorkflow('parent', async () => {
        const first = await executeChild<number>('child', {
          workflowId: 'once',
        });
        const second = await executeChild<number>('child', {
          workflowId: 'once',
        });
        return [first, second];
      });

    await expectAsync(rt.start('parent').result()).toBeResolvedTo([1, 1]);
    expect(started).toBe(1);
  });

  // The scanner shape: spawn-and-forget, keyed on the thing being planned, so
  // seeing the same item on two polls does not spawn two planners.
  it('starts one fire-and-forget child when the same id is claimed twice', async () => {
    let started = 0;
    const rt = createLocalRuntime()
      .registerWorkflow('planner', async () => {
        started += 1;
        return 'planned';
      })
      .registerWorkflow('scanner', async () => {
        startChild('planner', {workflowId: 'plan-for-event-42'});
        startChild('planner', {workflowId: 'plan-for-event-42'});
        await condition(() => false);
      });

    rt.start('scanner');
    await wait(40);

    expect(started).toBe(1);
    expect(rt.getHandle('plan-for-event-42').status()).toBe('completed');
  });

  it('delivers the result of an execution that already finished under that id', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('child', async () => 'earlier result')
      .registerWorkflow('parent', async () =>
        executeChild<string>('child', {workflowId: 'shared'}),
      );

    await rt.start('child', undefined, {workflowId: 'shared'}).result();

    await expectAsync(rt.start('parent').result()).toBeResolvedTo(
      'earlier result',
    );
  });
});

describe('local runtime — parent close policy', () => {
  /**
   * The default, and the leak it closes: a child started to serve its parent is
   * garbage the moment the parent is gone, and nothing else stops it.
   */
  it('terminates a child when its parent closes', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {workflowId: 'served-1'});
        await sleep(5);
        return 'done';
      });

    await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo(
      'done',
    );
    await wait(30);
    expect(rt.getHandle('served-1').status()).toBe('terminated');
  });

  it('leaves a child running when it is started to outlive its parent', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {
          workflowId: 'outliving-1',
          parentClosePolicy: 'abandon',
        });
        await sleep(5);
        return 'done';
      });

    await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo(
      'done',
    );
    await wait(30);
    expect(rt.getHandle('outliving-1').status()).toBe('running');
  });

  /**
   * `cancel` when the child has cleanup to do. It is the cooperative one, so a
   * child that declines to unwind keeps running — which is why it is not the
   * default.
   */
  it('lets a child unwind through its own cleanup when asked to cancel', async () => {
    const cleaned: string[] = [];
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        try {
          await condition(() => false);
          return 'unreachable';
        } finally {
          cleaned.push('ticker');
        }
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {
          workflowId: 'unwinding-1',
          parentClosePolicy: 'cancel',
        });
        await sleep(5);
        return 'done';
      });

    await rt.start('parent').result();
    await wait(50);
    expect(cleaned).toEqual(['ticker']);
  });
});

describe('local runtime — cancellation', () => {
  it('cancels a workflow parked on a condition', async () => {
    const rt = createLocalRuntime().registerWorkflow('waiter', async () => {
      await condition(() => false); // never true
      return 'never';
    });

    const handle = rt.start('waiter');
    await wait(5);
    handle.cancel();
    await expectAsync(handle.result()).toBeRejectedWithError(CancelledFailure);
  });

  it('lets a workflow catch CancelledFailure and finish cleanly', async () => {
    const rt = createLocalRuntime().registerWorkflow('graceful', async () => {
      try {
        await condition(() => false);
        return 'never';
      } catch (e) {
        if (e instanceof CancelledFailure) return 'cleaned up';
        throw e;
      }
    });

    const handle = rt.start<string>('graceful');
    await wait(5);
    handle.cancel();
    await expectAsync(handle.result()).toBeResolvedTo('cleaned up');
  });

  /**
   * Cancellation reaching the *activity*, not just the workflow. An agent loop
   * that heartbeats hears about the cancel on its next beat and stops; history
   * records the activity as cancelled the moment the cancel landed; and the
   * execution did not wait for the attempt — the workflow unwound as soon as
   * the cancel was applied.
   */
  it('reaches a running activity on its next heartbeat, and records that it stopped', async () => {
    let stopped = false;
    const activities = {
      agent: async () => {
        for (let i = 0; i < 500; i++) {
          heartbeat({turn: i});
          if (cancellationRequested()) {
            stopped = true;
            throw new Error('stopped: execution cancelled');
          }
          await wait(2);
        }
        return 'ran to the end';
      },
    };
    // A short heartbeat timeout sets the cadence cancellation travels at too.
    const {agent} = proxyActivities(activities, {heartbeatTimeoutMs: 10});
    const rt = createLocalRuntime()
      .registerActivity('agent', activities.agent)
      .registerWorkflow('wf', async () => agent());

    const handle = rt.start('wf');
    await wait(15);
    handle.cancel();
    await expectAsync(handle.result()).toBeRejectedWithError(CancelledFailure);

    // The attempt was still running when the execution settled; give it a
    // heartbeat window to hear and stop.
    await wait(40);
    expect(stopped).toBeTrue();
    const detail = await handle.describe();
    expect(detail!.history.map((e) => e.type)).toEqual([
      'activityScheduled',
      'activityStarted',
      'cancelRequested',
      'activityCancelled',
    ]);
    // Where it got to, on the event that stopped it: the last turn the agent
    // reported before the cancel landed.
    const cancelledEvent = detail!.history[3] as {checkpoint?: {turn: number}};
    expect(cancelledEvent.checkpoint?.turn).toBeGreaterThanOrEqual(0);
    rt.shutdown();
  });

  it('terminates a workflow outright, without giving it a chance to clean up', async () => {
    const rt = createLocalRuntime().registerWorkflow('stubborn', async () => {
      try {
        await condition(() => false);
        return 'never';
      } catch {
        return 'cleaned up'; // a cancel would land here; a terminate does not
      }
    });

    const handle = rt.start<string>('stubborn');
    await wait(5);
    handle.terminate('operator gave up');

    await expectAsync(handle.result()).toBeRejectedWithError(
      'operator gave up',
    );
    expect(handle.status()).toBe('terminated');
  });

  it('cancels a fire-and-forget child via its handle', async () => {
    const ticks: string[] = [];
    const rt = createLocalRuntime()
      .registerActivity('tick', (id: string) => {
        ticks.push(id);
        return ticks.length;
      })
      // loops forever until cancelled — if cancel is broken, this never terminates
      .registerWorkflow('ticker', async ({id}: {id: string}) => {
        while (true) {
          await runActivity('tick', id);
          await sleep(2);
        }
      })
      .registerWorkflow('parent', async () => {
        const child = startChild('ticker', {props: {id: 'c1'}});
        await sleep(15); // let the child tick a few times
        child.cancel();
        return 'parent-done';
      });

    await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo(
      'parent-done',
    );
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('cascades cancellation from a parent to its fire-and-forget children', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        while (true) {
          await sleep(2);
        }
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker');
        startChild('ticker');
        await condition(() => false); // park forever; cancel must unwind this
        return 'unreachable';
      });

    const handle = rt.start('parent');
    await wait(10); // let the children spawn and start ticking
    handle.cancel(); // cancels the parent; cascade cancels both children (else they tick forever)
    await expectAsync(handle.result()).toBeRejectedWithError(CancelledFailure);
  });

  /**
   * Both kinds of child, not only the detached ones. A parent unwinding through
   * a `CancelledFailure` is not going to consume the result it was awaiting, so
   * leaving the blocking child running would strand it — and cancellation is the
   * only thing that reaches a child at all (a parent that *completes* leaves
   * every child running; see `server_core`).
   */
  it('cascades cancellation to a blocking child too', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () =>
        executeChild('ticker', {workflowId: 'kid-1'}),
      );

    const handle = rt.start('parent', undefined, {workflowId: 'par-1'});
    await wait(10); // let the child start and park
    handle.cancel();
    await expectAsync(handle.result()).toBeRejectedWithError(CancelledFailure);

    await wait(10); // the child unwinds on its own next task
    expect(rt.getHandle('kid-1').status()).toBe('failed');
  });
});

describe('local runtime — signalling another workflow', () => {
  it('sends a signal to another execution by workflow id', async () => {
    const ping = 'ping';
    const rt = createLocalRuntime()
      .registerWorkflow('receiver', async () => {
        let heard: string | undefined;
        setHandler(ping, (word: string) => {
          heard = word;
        });
        await condition(() => heard !== undefined);
        return heard;
      })
      .registerWorkflow('sender', async () => {
        signalWorkflow('receiver-1', ping, 'hello');
        return 'sent';
      });

    const receiver = rt.start<string>('receiver', undefined, {
      workflowId: 'receiver-1',
    });
    rt.start('sender');

    await expectAsync(receiver.result()).toBeResolvedTo('hello');
  });

  /**
   * The shape this exists for: a child does the polling, so the cycles land in
   * *its* history and it sheds them by rolling over, while the parent pays one
   * event per item and reads them as ordinary control flow.
   */
  it('lets a child feed its parent items as they are found', async () => {
    const found = 'found';
    const rt = createLocalRuntime()
      .registerActivity('lookup', (from: number) => [from, from + 1])
      .registerWorkflow('finder', async () => {
        // `parent` is server-provided, so the child addresses an id it was never
        // handed — the engine derived it from lineage.
        const parent = workflowInfo().parent!.workflowId;
        for (const item of await runActivity<number[]>('lookup', 1))
          signalWorkflow(parent, found, item);
        return 'fed';
      })
      .registerWorkflow('collector', async () => {
        const items: number[] = [];
        setHandler(found, (item: number) => items.push(item));
        startChild('finder');
        await condition(() => items.length === 2);
        return items;
      });

    await expectAsync(rt.start<number[]>('collector').result()).toBeResolvedTo([
      1, 2,
    ]);
  });

  /**
   * Nothing is awaited, so a target that is gone cannot be caught. It is
   * recorded instead — `workflowSignaled` carries `delivered: false`, and the
   * server logs `signal.undelivered`.
   */
  it('carries on when the target does not exist', async () => {
    const rt = createLocalRuntime().registerWorkflow('shouter', async () => {
      signalWorkflow('nobody-1', 'ping', 'hello');
      return 'shouted';
    });

    await expectAsync(rt.start<string>('shouter').result()).toBeResolvedTo(
      'shouted',
    );
  });
});

describe('local runtime — continueAsNew', () => {
  it('ends a run and restarts fresh, carrying state forward', async () => {
    const rt = createLocalRuntime().registerWorkflow(
      'counter',
      async (n = 0) => {
        if (n >= 3) return `done at ${n}`;
        return continueAsNew(n + 1); // terminal: fresh run with the incremented count
      },
    );

    await expectAsync(rt.start<string>('counter', 0).result()).toBeResolvedTo(
      'done at 3',
    );
  });

  it('resolves the handle only when a later run actually completes', async () => {
    // Two rollovers then a real completion — the workflowId's result must reflect
    // the final run, not fire on the intermediate continue-as-news.
    const rt = createLocalRuntime()
      .registerActivity('tag', (n: number) => `run-${n}`)
      .registerWorkflow('rollup', async ({n = 0}: {n?: number} = {}) => {
        const tag = await runActivity<string>('tag', n);
        if (n >= 2) return tag;
        return continueAsNew({n: n + 1});
      });

    await expectAsync(
      rt.start<string>('rollup', {n: 0}).result(),
    ).toBeResolvedTo('run-2');
  });

  it('surfaces the server continue-as-new suggestion once history grows', async () => {
    // A small threshold, so this takes a handful of activities rather than the
    // ~2000 the real default would need. The default is deliberately production
    // sized (see DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD); tests that want to
    // reach it say so.
    const rt = createLocalRuntime({continueAsNewSuggestThreshold: 4})
      .registerActivity('noop', () => null)
      .registerWorkflow('grower', async () => {
        // do work until the server hints that we should roll over
        while (!workflowInfo().continueAsNewSuggested) {
          await runActivity('noop');
        }
        return 'suggested';
      });

    await expectAsync(rt.start<string>('grower').result()).toBeResolvedTo(
      'suggested',
    );
  });
});

describe('local runtime — timers', () => {
  it('resolves a sleep and continues', async () => {
    const rt = createLocalRuntime()
      .registerActivity('after', () => 'awake')
      .registerWorkflow('napper', async () => {
        await sleep(20);
        return runActivity<string>('after');
      });

    await expectAsync(rt.start<string>('napper').result()).toBeResolvedTo(
      'awake',
    );
  });

  it('fires concurrent timers in duration order, not scheduling order', async () => {
    const rt = createLocalRuntime()
      // `order` is declared INSIDE the workflow so it is rebuilt each cold replay;
      // its final contents come from the history order of the timerFired events,
      // which reflects the order the timers actually came due.
      .registerWorkflow('racers', async () => {
        const order: string[] = [];
        await Promise.all([
          sleep(60).then(() => order.push('long')),
          sleep(10).then(() => order.push('short')),
        ]);
        return order;
      });

    await expectAsync(rt.start<string[]>('racers').result()).toBeResolvedTo([
      'short',
      'long',
    ]);
  });

  it('honors sequential sleeps', async () => {
    const rt = createLocalRuntime().registerWorkflow('steps', async () => {
      const trail: number[] = [];
      await sleep(10);
      trail.push(1);
      await sleep(10);
      trail.push(2);
      return trail;
    });

    await expectAsync(rt.start<number[]>('steps').result()).toBeResolvedTo([
      1, 2,
    ]);
  });
});
