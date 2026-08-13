/**
 * @fileoverview
 * Where a workflow is parked, and what it costs to know.
 *
 * A `condition()` writes no history event — that is what makes it free — so an
 * execution waiting on one is indistinguishable from one mid-task by looking at
 * the record. The site is captured by the worker that replayed it.
 *
 * Two properties matter more than the reporting itself, and both are easy to
 * lose in a later edit: the capture must not perturb replay, and it must not pay
 * for conditions that are not parked.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {condition, defineSignal, setHandler} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const go = defineSignal('go');

describe('a workflow parked on a condition', () => {
  it('reports the condition it is waiting on', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('waiter', async () => {
        let ready = false;
        setHandler(go, () => {
          ready = true;
        });
        await condition(() => ready);
        return 'went';
      })
      .start('waiter', [], {workflowId: 'p-1'});
    await wait(150);

    const rec = await store.get('p-1');
    expect(rec?.status).toBe('running');
    expect(rec?.parked?.length).toBe(1);
  });

  it('names the line the workflow is parked at', async () => {
    // The whole point: "running, nothing pending" is otherwise unactionable.
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('waiter', async () => {
        await condition(() => false);
        return 'never';
      })
      .start('waiter', [], {workflowId: 'p-2'});
    await wait(150);

    const site = (await store.get('p-2'))?.parked?.[0]?.site;
    expect(site).toBeDefined();
    // The top frame is the workflow's own call, not `condition` and not the
    // capture helper — which is what `captureStackTrace`'s cutoff buys.
    expect(site).toContain('parked_conditions.spec');
    expect(site?.split('\n')[0]).not.toContain('at condition');
  });

  it('shows the workflow frames without the engine ones below them', async () => {
    // Six frames of AsyncLocalStorage and replayTask around the one line that
    // matters is noise in a panel whose whole job is to point at that line.
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('nested', async () => {
        const waitForIt = async (): Promise<void> => {
          await condition(() => false);
        };
        await waitForIt();
        return 'never';
      })
      .start('nested', [], {workflowId: 'p-6'});
    await wait(150);

    const site = (await store.get('p-6'))!.parked![0]!.site!;
    // The workflow's own frames survive — the inner helper and the workflow.
    expect(site).toContain('parked_conditions.spec');
    // The engine's do not.
    expect(site).not.toContain('replay');
    expect(site).not.toContain('AsyncLocalStorage');
    expect(site).not.toContain('worker_loops');
  });

  it('forgets it once the condition holds', async () => {
    // Replaced wholesale rather than accumulated: a condition that unparked is
    // no longer where the workflow is.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'waiter',
      async () => {
        let ready = false;
        setHandler(go, () => {
          ready = true;
        });
        await condition(() => ready);
        return 'went';
      },
    );
    const handle = rt.start<string>('waiter', [], {workflowId: 'p-3'});
    await wait(150);
    expect((await store.get('p-3'))?.parked?.length).toBe(1);

    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');

    expect((await store.get('p-3'))?.parked ?? []).toEqual([]);
  });

  it('reports nothing for a workflow that never parks', async () => {
    // The common case, and the one the write is skipped for.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'plain',
      async () => 'done',
    );
    await expectAsync(
      rt.start<string>('plain', [], {workflowId: 'p-4'}).result(),
    ).toBeResolvedTo('done');

    expect((await store.get('p-4'))?.parked ?? []).toEqual([]);
  });

  it('reports every condition when more than one is outstanding', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('two', async () => {
        await Promise.all([condition(() => false), condition(() => false)]);
        return 'never';
      })
      .start('two', [], {workflowId: 'p-5'});
    await wait(150);

    const parked = (await store.get('p-5'))?.parked ?? [];
    expect(parked.length).toBe(2);
    // Distinct ids, from `condSeq` rather than the command counter.
    expect(new Set(parked.map((p) => p.seq)).size).toBe(2);
  });
});

describe('capturing a park site — what it must not do', () => {
  it('leaves the command sequence untouched', async () => {
    // `condSeq` is deliberately separate from the command `seq` counter so that
    // parking never perturbs command numbering. The capture must not change
    // that, and a history is where it would show.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 1)
      .registerWorkflow('mixed', async () => {
        let ready = false;
        setHandler(go, () => {
          ready = true;
        });
        await condition(() => ready);
        return 'went';
      });
    const handle = rt.start<string>('mixed', [], {workflowId: 'q-1'});
    await wait(150);
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');

    const history = (await store.get('q-1'))!.history;
    // No command was emitted, so no marker exists and the capture added none.
    // Asserted as "nothing here carries a command seq" rather than as the literal
    // event list, which is the invariant this test is actually about: the park
    // itself is now recorded (`conditionParked` / `conditionUnparked`, carrying a
    // `condSeq`), and that must stay true without ever entering command numbering.
    expect(history.some((e) => 'seq' in e)).toBe(false);
    expect(history.map((e) => e.type)).toEqual([
      'conditionParked',
      'signal',
      'conditionUnparked',
    ]);
  });

  it('restores the stack-trace limit it narrowed', async () => {
    // The capture lowers `Error.stackTraceLimit` to bound the frame walk. It is
    // a global, so failing to put it back would silently truncate every stack in
    // the process — including the failure stacks a client reads off a describe.
    const before = Error.stackTraceLimit;
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('waiter', async () => {
        await condition(() => false);
        return 'never';
      })
      .start('waiter', [], {workflowId: 'q-2'});
    await wait(150);

    expect(Error.stackTraceLimit).toBe(before);
  });

  it('does not capture for a predicate that is already true', async () => {
    // The eager fast-path returns before registering, so a condition that never
    // parks costs nothing — which is what makes this affordable on a hot path.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'immediate',
      async () => {
        await condition(() => true);
        return 'straight through';
      },
    );
    await expectAsync(
      rt.start<string>('immediate', [], {workflowId: 'q-3'}).result(),
    ).toBeResolvedTo('straight through');

    expect((await store.get('q-3'))?.parked ?? []).toEqual([]);
  });
});
