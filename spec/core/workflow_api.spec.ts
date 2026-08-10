/**
 * @fileoverview
 * The deterministic primitives, at the command level: what each one puts on the
 * command list, and the seq allocation that lets a completion find its way back.
 * Internals specs, for contributors.
 */

import {
  als,
  CancelledFailure,
  continueAsNew,
  createContext,
  defineSignal,
  drainMicrotasks,
  executeChild,
  proxyActivities,
  runActivity,
  signalWorkflow,
  sleep,
  startChild,
  workflowInfo,
} from '../../src/core';
import type {CancelChildCommand, StartChildCommand} from '../../src/protocol';

describe('core primitives — seq allocation', () => {
  /**
   * seq is assigned in call order across every primitive kind, and that ordering
   * is the whole correlation mechanism: a recorded completion carries the seq of
   * the command it answers.
   */
  it('numbers commands in call order regardless of their kind', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void runActivity('a');
      void sleep(5);
      void executeChild('c');
    });

    expect(ctx.commands.map((c) => [c.type, c.seq])).toEqual([
      ['scheduleActivity', 0],
      ['startTimer', 1],
      ['startChild', 2],
    ]);
  });

  it('parks a promise for each command it issues', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void runActivity('a');
      void sleep(5);
    });

    expect([...ctx.completions.keys()]).toEqual([0, 1]);
  });
});

describe('core primitives — command payloads', () => {
  it('carries the activity name and arguments on the command', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void runActivity('greet', 'world', 42);
    });

    expect(ctx.commands[0]).toEqual({
      type: 'scheduleActivity',
      name: 'greet',
      args: ['world', 42],
      options: {},
      seq: 0,
    });
  });

  it('carries the duration on a timer command', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void sleep(250);
    });

    expect(ctx.commands[0]).toEqual({type: 'startTimer', ms: 250, seq: 0});
  });

  /**
   * `proxyActivities` is a typed façade over `runActivity`. At runtime it is a
   * thin forwarder: the property name becomes the activity name, and the options
   * it was built with ride along on every command.
   */
  it('forwards a proxied call to the activity of the same name, with its options', () => {
    const ctx = createContext([], []);
    const act = proxyActivities<{greet(name: string): string}>({
      retry: {maximumAttempts: 3},
    });

    als.run(ctx, () => {
      void act.greet('world');
    });

    expect(ctx.commands[0]).toEqual({
      type: 'scheduleActivity',
      name: 'greet',
      args: ['world'],
      options: {retry: {maximumAttempts: 3}},
      seq: 0,
    });
  });
});

describe('core primitives — children', () => {
  it('marks an awaited child as blocking and a spawned child as detached', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void executeChild('blocking');
      startChild('detached');
    });

    expect((ctx.commands[0] as StartChildCommand).detached).toBeFalse();
    expect((ctx.commands[1] as StartChildCommand).detached).toBeTrue();
  });

  /**
   * Cancelling a detached child is itself replay-safe: the handle emits an
   * ordinary command, numbered like any other, pointing back at the child's seq.
   */
  it('cancels a detached child by emitting a command targeting its seq', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      const handle = startChild('detached');
      handle.cancel();
    });

    expect(ctx.commands.map((c) => c.type)).toEqual([
      'startChild',
      'cancelChild',
    ]);
    const cancel = ctx.commands[1] as CancelChildCommand;
    expect(cancel.targetSeq).toBe(0);
    expect(cancel.seq).toBe(1);
  });

  it('parks no waiter for a detached child, because no completion is coming', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      startChild('detached');
    });

    expect(ctx.completions.size).toBe(0);
  });
});

describe('core primitives — signalling another workflow', () => {
  it('carries the target, the signal name and the payload on the command', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      signalWorkflow('parent-1', defineSignal('comment'), {id: 7});
    });

    expect(ctx.commands[0]).toEqual({
      type: 'signalWorkflow',
      targetId: 'parent-1',
      signalName: 'comment',
      payload: {id: 7},
      seq: 0,
    });
  });

  /**
   * It takes a seq like any other command — that is what its marker is keyed by
   * — but parks nothing, because no completion is coming. Fire-and-forget in the
   * same sense a detached child is.
   */
  it('takes a seq but parks no waiter, since nothing is awaited', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      signalWorkflow('parent-1', defineSignal('comment'));
      void runActivity('after');
    });

    expect(ctx.commands.map((c) => [c.type, c.seq])).toEqual([
      ['signalWorkflow', 0],
      ['scheduleActivity', 1],
    ]);
    expect([...ctx.completions.keys()]).toEqual([1]);
  });

  /**
   * The reason it needs a marker at all. History holding the seq is the only
   * evidence replay has that the signal already went out; without this the next
   * replay would send it again, and the target would see the item twice.
   */
  it('does not re-send a signal history already holds the marker for', () => {
    const ctx = createContext(
      [],
      [
        {
          type: 'workflowSignaled',
          seq: 0,
          targetId: 'parent-1',
          signalName: 'comment',
          delivered: true,
        },
      ],
    );

    als.run(ctx, () => {
      signalWorkflow('parent-1', defineSignal('comment'), {id: 7});
    });

    expect(ctx.commands).toEqual([]);
    expect(ctx.requested.has(0)).toBeTrue(); // still claimed, so the marker is checked
  });

  it('sends nothing once the run is cancelled', () => {
    const ctx = createContext([], []);
    ctx.cancelled = true;

    als.run(ctx, () => {
      signalWorkflow('parent-1', defineSignal('comment'));
    });

    expect(ctx.commands).toEqual([]);
  });
});

describe('core primitives — workflowInfo', () => {
  /**
   * How a child addresses its parent: an id it was never handed as an argument,
   * and could not have derived, since the engine chose it from lineage.
   */
  it('reports the execution that started this one', () => {
    const child = createContext([], [], false, {}, {workflowId: 'p-1', seq: 3});
    const root = createContext([], []);

    expect(als.run(child, () => workflowInfo().parent)).toEqual({
      workflowId: 'p-1',
      seq: 3,
    });
    expect(als.run(root, () => workflowInfo().parent)).toBeUndefined();
  });

  it('hands back a copy, so a caller cannot write through it into the context', () => {
    const ctx = createContext([], [], false, {}, {workflowId: 'p-1', seq: 3});

    als.run(ctx, () => {
      const info = workflowInfo();
      info.parent!.workflowId = 'somewhere-else';
    });

    expect(ctx.parent?.workflowId).toBe('p-1');
  });
});

describe('core primitives — continueAsNew', () => {
  /**
   * Terminal: it emits the command and then halts the run, so nothing after it
   * executes. Actually starting the next run is the server's job, not the core's.
   */
  it('emits the command and never resolves, so no code runs after it', async () => {
    const ctx = createContext([], []);
    let reachedAfter = false;

    // Voided: the body parks and never settles — that is what is under test.
    void als.run(ctx, async () => {
      await continueAsNew('carried');
      reachedAfter = true;
    });
    await drainMicrotasks();

    expect(ctx.commands[0]).toEqual({
      type: 'continueAsNew',
      args: ['carried'],
      seq: 0,
    });
    expect(reachedAfter).toBeFalse();
  });

  it('reads the server-provided rollover hint off the context', () => {
    const suggested = createContext([], [], true);
    const notSuggested = createContext([], []);

    expect(
      als.run(suggested, () => workflowInfo().continueAsNewSuggested),
    ).toBeTrue();
    expect(
      als.run(notSuggested, () => workflowInfo().continueAsNewSuggested),
    ).toBeFalse();
  });
});

describe('core primitives — after cancellation', () => {
  it('refuses to start new work once the run is cancelled', async () => {
    const ctx = createContext([], []);
    ctx.cancelled = true;
    let error: unknown;

    await als.run(ctx, async () => {
      try {
        await runActivity('a');
      } catch (e) {
        error = e;
      }
    });

    expect(error).toBeInstanceOf(CancelledFailure);
    expect(ctx.commands).toEqual([]);
  });

  it('hands back an inert handle when a detached child is spawned after cancel', () => {
    const ctx = createContext([], []);
    ctx.cancelled = true;

    als.run(ctx, () => {
      const handle = startChild('detached');
      handle.cancel();
    });

    expect(ctx.commands).toEqual([]);
  });
});
