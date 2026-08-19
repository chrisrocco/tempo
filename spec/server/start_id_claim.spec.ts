/**
 * @fileoverview
 * Starting under an id that already names an execution.
 *
 * A caller-chosen id ties an execution to something in the world — an order, a
 * ticket — so a second start under it is deduplication working rather than a
 * collision. The engine takes the same position for `startChild`: a claim on a
 * name, not a demand for a new execution.
 *
 * What has to be true is that the caller can *tell*. Returning the existing
 * execution is right; returning it while looking exactly like a fresh start is
 * how someone concludes their arguments took effect when they were discarded.
 */

import {MemoryHistoryStore} from '../../src/server';
import {createServerHost} from '../../src/services';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('starting under an id that is already taken', () => {
  it('returns the execution that holds the id rather than starting a second', async () => {
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      const first = await host.start('order', [{amount: 100}], {
        workflowId: 'order-42',
      });
      const second = await host.start('order', [{amount: 100}], {
        workflowId: 'order-42',
      });

      expect(first.workflowId).toBe('order-42');
      expect(second.workflowId).toBe('order-42');
      expect((await store.list()).length).toBe(1);
    } finally {
      host.shutdown();
    }
  });

  it('says which of the two happened', async () => {
    // The whole point. Without this the second call is indistinguishable from
    // the first, and a caller has no way to notice it started nothing.
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      expect(
        (await host.start('order', undefined, {workflowId: 'order-43'}))
          .created,
      ).toBeTrue();
      expect(
        (await host.start('order', undefined, {workflowId: 'order-43'}))
          .created,
      ).toBeFalse();
    } finally {
      host.shutdown();
    }
  });

  it('keeps the arguments the execution was started with', async () => {
    // The one genuine hazard, and it stays a hazard by design: the engine will
    // not arbitrate between two starts equally entitled to the name.
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      await host.start('order', [{amount: 100}], {workflowId: 'order-44'});
      await host.start('order', [{amount: 500}], {workflowId: 'order-44'});

      expect((await store.get('order-44'))?.args).toEqual([{amount: 100}]);
    } finally {
      host.shutdown();
    }
  });

  it('records whether the second request matched the first', async () => {
    // Behaviour does not change on a mismatch — but a discarded argument list
    // is a bug in the caller, and this is what makes it greppable.
    const lines: {event: string; data: Record<string, unknown> | undefined}[] =
      [];
    const host = createServerHost(new MemoryHistoryStore(), {
      log: (event, data) => lines.push({event, data}),
    });
    try {
      await host.start('order', [{amount: 100}], {workflowId: 'order-45'});
      await host.start('order', [{amount: 100}], {workflowId: 'order-45'});
      await host.start('order', [{amount: 500}], {workflowId: 'order-45'});

      const reused = lines
        .filter((l) => l.event === 'execution.start_reused')
        .map((l) => l.data?.['sameRequest']);
      expect(reused).toEqual([true, false]);
    } finally {
      host.shutdown();
    }
  });

  it('does not enqueue a second task for the execution it reused', async () => {
    // A reused id must not re-drive a settled execution, which is what an
    // unconditional enqueue would do.
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      await host.start('order', undefined, {workflowId: 'order-46'});
      await wait(20);
      const versionBefore = (await store.get('order-46'))!.version;

      await host.start('order', undefined, {workflowId: 'order-46'});
      await wait(20);

      expect((await store.get('order-46'))!.version).toBe(versionBefore);
    } finally {
      host.shutdown();
    }
  });

  it('still generates a fresh id when the caller does not choose one', async () => {
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      const a = await host.start('order');
      const b = await host.start('order');

      expect(a.workflowId).not.toBe(b.workflowId);
      expect(a.created).toBeTrue();
      expect(b.created).toBeTrue();
    } finally {
      host.shutdown();
    }
  });
});
