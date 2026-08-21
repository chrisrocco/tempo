/**
 * @fileoverview
 * `signalWorkflow` at the server: what the two ends of one delivery record, and
 * the property that lets the sender's marker be written last.
 *
 * The marker ordering is the reason most of this exists. `signalWorkflow` writes
 * its marker *after* the delivery, like `startChild` and `cancelChild`, because
 * nothing re-drives a signal on restart — so replay re-emitting the command is
 * its only recovery, and a marker written first is precisely what would suppress
 * it (see `server_core`'s header). That ordering is only safe while the delivery
 * is idempotent, which is what `SignalSource` is for: the second test drives the
 * crash window directly, by applying the same command twice and asking the
 * target how many signals it got.
 *
 * The undelivered case is the other half. A sent signal parks nothing, so a
 * target that is gone cannot be reported by rejecting a promise — the marker's
 * `delivered: false` is where that fact lives instead.
 */

import {createLocalRuntime} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';
import type {SignalWorkflowCommand} from '../../src/protocol';
import {
  condition,
  setHandler,
  signalWorkflow,
  startChild,
  workflowInfo,
} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A headless core over in-memory ports: no worker loops, commands applied by hand. */
function headlessCore(historyStore: MemoryHistoryStore) {
  return createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue: new MemoryTaskQueue(),
    timerService: new MemoryTimerService(),
    launch: () => {},
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
}

/** One `signalWorkflow` command, as a task result carrying nothing else. */
function sending(command: SignalWorkflowCommand) {
  return {
    done: false,
    result: undefined,
    failed: false,
    failure: undefined,
    commands: [command],
  };
}

describe('a workflow signalling another workflow', () => {
  it('delivers to the target and records the dispatch on the sender', async () => {
    const item = 'item';
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('feeder', async () => {
        signalWorkflow(workflowInfo().parent!.workflowId, item, 'from-child');
        return 'sent';
      })
      .registerWorkflow('consumer', async () => {
        let got: string | undefined;
        setHandler(item, (payload: string) => {
          got = payload;
        });
        startChild('feeder', {workflowId: 'feeder-1'});
        await condition(() => got !== undefined);
        return got;
      });

    const handle = rt.start<string>('consumer', undefined, {workflowId: 'c-1'});
    await expectAsync(handle.result()).toBeResolvedTo('from-child');

    // The receiving end: an ordinary signal, seq-less like any other, with the
    // dispatch that produced it attached.
    expect((await store.get('c-1'))?.history).toContain(
      jasmine.objectContaining({
        type: 'signal',
        name: 'item',
        payload: 'from-child',
        source: {workflowId: 'feeder-1', runId: 0, seq: 0},
      }),
    );
    // The sending end: numbered, because it was a command.
    expect((await store.get('feeder-1'))?.history).toContain(
      jasmine.objectContaining({
        type: 'workflowSignaled',
        seq: 0,
        targetId: 'c-1',
        signalName: 'item',
        delivered: true,
      }),
    );
  });

  /**
   * The crash window, driven directly: the delivery landed, the process died
   * before the marker, and replay re-emits the command. Applying the same command
   * twice is exactly what the target sees in that case.
   */
  it('delivers once when the same dispatch is applied twice', async () => {
    const store = new MemoryHistoryStore();
    const core = headlessCore(store);
    await store.create('sender', 'w', []);
    await store.create('target', 'w', []);
    const command: SignalWorkflowCommand = {
      type: 'signalWorkflow',
      seq: 0,
      targetId: 'target',
      signalName: 'item',
      payload: 1,
    };

    await core.applyWorkflowTaskResult('sender', sending(command));
    await core.applyWorkflowTaskResult('sender', sending(command));

    const signals = (await store.get('target'))!.history.filter(
      (e) => e.type === 'signal',
    );
    expect(signals.length).toBe(1);
  });

  /**
   * The seq alone would not be enough to tell the two apart: a sender's counter
   * restarts at zero on continue-as-new, and the senders that use this most are
   * pollers, which roll over constantly.
   */
  it('treats the same seq in a later run of the sender as a new signal', async () => {
    const store = new MemoryHistoryStore();
    const core = headlessCore(store);
    await store.create('sender', 'w', []);
    await store.create('target', 'w', []);
    const command: SignalWorkflowCommand = {
      type: 'signalWorkflow',
      seq: 0,
      targetId: 'target',
      signalName: 'item',
      payload: 1,
    };

    await core.applyWorkflowTaskResult('sender', sending(command));
    await store.resetForContinueAsNew('sender', []); // runId 0 -> 1
    await core.applyWorkflowTaskResult('sender', sending(command));

    const signals = (await store.get('target'))!.history.filter(
      (e) => e.type === 'signal',
    );
    expect(signals.length).toBe(2);
  });

  /**
   * A target addressed by id keeps that id across its own rollover, so delivery
   * still finds it — the new run, since that is the only one there is.
   */
  it('delivers to the target’s current run after it has continued as new', async () => {
    const store = new MemoryHistoryStore();
    const core = headlessCore(store);
    await store.create('sender', 'w', []);
    await store.create('target', 'w', []);
    await store.resetForContinueAsNew('target', ['second run']);

    await core.applyWorkflowTaskResult(
      'sender',
      sending({
        type: 'signalWorkflow',
        seq: 0,
        targetId: 'target',
        signalName: 'item',
        payload: 1,
      }),
    );

    const target = (await store.get('target'))!;
    expect(target.runId).toBe(1);
    expect(target.history).toContain(
      jasmine.objectContaining({type: 'signal', name: 'item'}),
    );
  });

  it('records an undelivered signal rather than dropping it silently', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('shouter', async () => {
        signalWorkflow('nobody-is-here', 'item', 1);
        await wait(30);
        return 'shouted';
      })
      .start('shouter', undefined, {workflowId: 's-1'});
    await wait(200);

    expect((await store.get('s-1'))?.history).toContain(
      jasmine.objectContaining({
        type: 'workflowSignaled',
        seq: 0,
        targetId: 'nobody-is-here',
        delivered: false,
      }),
    );
  });

  /**
   * A settled target is as undeliverable as a missing one: nothing will replay
   * it, so an appended signal would sit in its history unread. Reporting that is
   * better than writing an event no code will ever see.
   */
  it('reports a settled target as undelivered', async () => {
    const store = new MemoryHistoryStore();
    const core = headlessCore(store);
    await store.create('sender', 'w', []);
    await store.create('target', 'w', []);
    await store.setStatus('target', 'completed', {result: 'done'});

    await core.applyWorkflowTaskResult(
      'sender',
      sending({
        type: 'signalWorkflow',
        seq: 0,
        targetId: 'target',
        signalName: 'item',
        payload: 1,
      }),
    );

    expect((await store.get('target'))!.history).toEqual([]);
    expect((await store.get('sender'))!.history).toContain(
      jasmine.objectContaining({type: 'workflowSignaled', delivered: false}),
    );
  });
});
