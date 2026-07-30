// Characterization suite for the in-memory runtime. Locks the observable
// behavior of `createLocalRuntime` (activities, condition, signals, blocking
// children, timers) so the layered restructure and the service-seam introduction
// can each be verified as behavior-preserving. `createLocalRuntime` comes from the host entrypoint; the workflow
// primitives come from the author entrypoint — mirroring how real host and
// workflow code import them across the determinism boundary (doc 01).
import { createLocalRuntime } from '../../src';
import {
  runActivity,
  proxyActivities,
  sleep,
  executeChild,
  startChild,
  defineSignal,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  CancelledFailure,
} from '../../src/workflow';

// real-time wait, for letting async drives / timers make progress in a test
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('local runtime — activities', () => {
  it('runs a single activity and returns its result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('greet', (name: string) => `hello ${name}`)
      .registerWorkflow('greeter', async () => runActivity<string>('greet', 'world'));

    const handle = rt.start<string>('greeter');
    await expectAsync(handle.result()).toBeResolvedTo('hello world');
    expect(handle.status()).toBe('completed');
  });

  it('runs activities sequentially in call order', async () => {
    const order: string[] = [];
    const rt = createLocalRuntime()
      .registerActivity('a', () => { order.push('a'); return 1; })
      .registerActivity('b', () => { order.push('b'); return 2; })
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
        ]));

    await expectAsync(rt.start<number[]>('fan').result()).toBeResolvedTo([2, 4, 6]);
  });

  it('parks during a genuinely async activity and resumes on its reported result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('slow', async () => {
        await new Promise((r) => setTimeout(r, 15));
        return 'slow-result';
      })
      .registerWorkflow('wf', async () => runActivity<string>('slow'));

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo('slow-result');
  });

  it('drains concurrently-dispatched activities in FIFO (seq) order', async () => {
    const order: number[] = [];
    const rt = createLocalRuntime()
      .registerActivity('rec', (n: number) => { order.push(n); return n; })
      .registerWorkflow('fan', async () =>
        Promise.all([runActivity('rec', 1), runActivity('rec', 2), runActivity('rec', 3)]));

    await rt.start('fan').result();
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates an activity failure to the workflow result', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => { throw new Error('kaboom'); })
      .registerWorkflow('failing', async () => runActivity('boom'));

    const handle = rt.start('failing');
    await expectAsync(handle.result()).toBeRejectedWithError(/kaboom/);
    expect(handle.status()).toBe('failed');
  });

  it('lets the workflow catch an activity failure and continue', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => { throw new Error('kaboom'); })
      .registerActivity('ok', () => 'recovered')
      .registerWorkflow('recovers', async () => {
        try {
          await runActivity('boom');
          return 'unreachable';
        } catch {
          return runActivity<string>('ok');
        }
      });

    await expectAsync(rt.start<string>('recovers').result()).toBeResolvedTo('recovered');
  });

  it('reports a missing activity as a failure', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('missing', async () => runActivity('does-not-exist'));
    await expectAsync(rt.start('missing').result()).toBeRejectedWithError(/no activity does-not-exist/);
  });
});

describe('local runtime — proxyActivities & retries', () => {
  it('calls activities through a typed proxy', async () => {
    const activities = { add: (a: number, b: number) => a + b };
    const rt = createLocalRuntime()
      .registerActivity('add', activities.add)
      .registerWorkflow('sum', async () => {
        const { add } = proxyActivities<typeof activities>();
        return add(2, 3);
      });

    await expectAsync(rt.start<number>('sum').result()).toBeResolvedTo(5);
  });

  it('does not retry by default (maximumAttempts defaults to 1)', async () => {
    let attempts = 0;
    const activities = { once: () => { attempts += 1; throw new Error('boom'); } };
    const rt = createLocalRuntime()
      .registerActivity('once', activities.once)
      .registerWorkflow('wf', async () => proxyActivities<typeof activities>().once());

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
    const rt = createLocalRuntime()
      .registerActivity('flaky', activities.flaky)
      .registerWorkflow('wf', async () => {
        const { flaky } = proxyActivities<typeof activities>({ retry: { maximumAttempts: 3 } });
        return flaky();
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo('ok-after-retries');
    expect(attempts).toBe(3);
  });

  it('surfaces the failure after exhausting attempts', async () => {
    let attempts = 0;
    const activities = { always: () => { attempts += 1; throw new Error('persistent'); } };
    const rt = createLocalRuntime()
      .registerActivity('always', activities.always)
      .registerWorkflow('wf', async () => {
        const { always } = proxyActivities<typeof activities>({ retry: { maximumAttempts: 2 } });
        return always();
      });

    await expectAsync(rt.start('wf').result()).toBeRejectedWithError(/persistent/);
    expect(attempts).toBe(2);
  });
});

describe('local runtime — signals and condition', () => {
  it('parks on a condition and wakes when a signal makes it true', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('waiter', async () => {
        let go = false;
        setHandler(defineSignal('go'), () => { go = true; });
        await condition(() => go);
        return 'went';
      });

    const handle = rt.start<string>('waiter');
    expect(handle.status()).toBe('running');
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');
  });

  it('delivers the signal payload to the handler', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('collector', async () => {
        let value: number | undefined;
        setHandler(defineSignal('set'), (v: number) => { value = v; });
        await condition(() => value !== undefined);
        return value;
      });

    const handle = rt.start<number>('collector');
    handle.signal('set', 42);
    await expectAsync(handle.result()).toBeResolvedTo(42);
  });

  it('accumulates repeated signals before the condition is satisfied', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('adder', async () => {
        let total = 0;
        let count = 0;
        setHandler(defineSignal('add'), (n: number) => { total += n; count += 1; });
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
      .registerWorkflow('child', async (n: number) => runActivity<number>('square', n))
      .registerWorkflow('parent', async () => {
        const a = await executeChild<number>('child', 3);
        const b = await executeChild<number>('child', 4);
        return a + b;
      });

    await expectAsync(rt.start<number>('parent').result()).toBeResolvedTo(25);
  });

  it('runs concurrent blocking children without double-dispatching them', async () => {
    const worked: number[] = [];
    const rt = createLocalRuntime()
      .registerActivity('work', (n: number) => { worked.push(n); return n * 10; })
      .registerWorkflow('child', async (n: number) => runActivity<number>('work', n))
      .registerWorkflow('parent', async () =>
        Promise.all([executeChild<number>('child', 1), executeChild<number>('child', 2)]));

    const result = await rt.start<number[]>('parent').result();
    expect(result).toEqual([10, 20]);       // Promise.all preserves order
    expect(worked.sort()).toEqual([1, 2]);  // each child ran exactly once (marker prevents re-launch)
  });

  it('propagates a child failure to the parent', async () => {
    const rt = createLocalRuntime()
      .registerActivity('boom', () => { throw new Error('child-boom'); })
      .registerWorkflow('child', async () => runActivity('boom'))
      .registerWorkflow('parent', async () => executeChild('child'));

    await expectAsync(rt.start('parent').result()).toBeRejectedWithError(/child-boom/);
  });
});

describe('local runtime — cancellation', () => {
  it('cancels a workflow parked on a condition', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('waiter', async () => {
        await condition(() => false); // never true
        return 'never';
      });

    const handle = rt.start('waiter');
    await wait(5);
    handle.cancel();
    await expectAsync(handle.result()).toBeRejectedWithError(CancelledFailure);
  });

  it('lets a workflow catch CancelledFailure and finish cleanly', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('graceful', async () => {
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

  it('cancels a fire-and-forget child via its handle', async () => {
    const ticks: string[] = [];
    const rt = createLocalRuntime()
      .registerActivity('tick', (id: string) => { ticks.push(id); return ticks.length; })
      // loops forever until cancelled — if cancel is broken, this never terminates
      .registerWorkflow('ticker', async (id: string) => {
        for (;;) { await runActivity('tick', id); await sleep(2); }
      })
      .registerWorkflow('parent', async () => {
        const child = startChild('ticker', 'c1');
        await sleep(15); // let the child tick a few times
        child.cancel();
        return 'parent-done';
      });

    await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo('parent-done');
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('cascades cancellation from a parent to its fire-and-forget children', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => { for (;;) { await sleep(2); } })
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
});

describe('local runtime — continueAsNew', () => {
  it('ends a run and restarts fresh, carrying state forward', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('counter', async (n = 0) => {
        if (n >= 3) return `done at ${n}`;
        return continueAsNew(n + 1); // terminal: fresh run with the incremented count
      });

    await expectAsync(rt.start<string>('counter', [0]).result()).toBeResolvedTo('done at 3');
  });

  it('resolves the handle only when a later run actually completes', async () => {
    // Two rollovers then a real completion — the workflowId's result must reflect
    // the final run, not fire on the intermediate continue-as-news.
    const rt = createLocalRuntime()
      .registerActivity('tag', (n: number) => `run-${n}`)
      .registerWorkflow('rollup', async (n = 0) => {
        const tag = await runActivity<string>('tag', n);
        if (n >= 2) return tag;
        return continueAsNew(n + 1);
      });

    await expectAsync(rt.start<string>('rollup', [0]).result()).toBeResolvedTo('run-2');
  });

  it('surfaces the server continue-as-new suggestion once history grows', async () => {
    const rt = createLocalRuntime()
      .registerActivity('noop', () => null)
      .registerWorkflow('grower', async () => {
        // do work until the server hints that we should roll over
        while (!workflowInfo().continueAsNewSuggested) {
          await runActivity('noop');
        }
        return 'suggested';
      });

    await expectAsync(rt.start<string>('grower').result()).toBeResolvedTo('suggested');
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

    await expectAsync(rt.start<string>('napper').result()).toBeResolvedTo('awake');
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

    await expectAsync(rt.start<string[]>('racers').result()).toBeResolvedTo(['short', 'long']);
  });

  it('honors sequential sleeps', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('steps', async () => {
        const trail: number[] = [];
        await sleep(10); trail.push(1);
        await sleep(10); trail.push(2);
        return trail;
      });

    await expectAsync(rt.start<number[]>('steps').result()).toBeResolvedTo([1, 2]);
  });
});
