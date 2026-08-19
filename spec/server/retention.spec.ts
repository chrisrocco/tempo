/**
 * @fileoverview
 * Retention: closed executions are deleted after a window, and nothing else is.
 *
 * The properties worth the most care are the two ways a sweep could delete
 * something still owed: a running execution (never eligible, however old — an
 * execution waiting a year on a signal is the product working), and a settled
 * child whose running parent has not consumed its outcome, which `resume()`
 * would need the child's record to synthesize. The id floor gets its own
 * attention: deletion is what makes reissuing a generated id possible at all,
 * so the store must remember the suffix even though the record is gone.
 */

import {promises as fs} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {HistoryEvent} from '../../src/protocol';
import type {ExecutionRecord} from '../../src/server';
import {
  FileHistoryStore,
  MemoryHistoryStore,
  expiredExecutions,
} from '../../src/server';
import {createServerHost} from '../../src/services';

/** A terminal record, closed at t=1000 unless a test says otherwise. */
function record(
  overrides: Partial<ExecutionRecord> & {workflowId: string},
): ExecutionRecord {
  return {
    runId: 0,
    name: 'wf',
    args: [],
    taskQueue: 'default',
    createdAt: 500,
    closedAt: 1_000,
    history: [],
    version: 0,
    status: 'completed',
    carryover: {},
    taskFailures: 0,
    activityAttempts: {},
    ...overrides,
  };
}

const swept = (records: ExecutionRecord[], cutoff: number): string[] =>
  expiredExecutions(records, cutoff).map((r) => r.workflowId);

describe('expiredExecutions', () => {
  it('sweeps a terminal execution closed at or before the cutoff', () => {
    expect(swept([record({workflowId: 'a'})], 1_000)).toEqual(['a']);
  });

  it('keeps one closed after the cutoff', () => {
    expect(swept([record({workflowId: 'a', closedAt: 1_001})], 1_000)).toEqual(
      [],
    );
  });

  it('never sweeps a running execution, however old', () => {
    const rec = record({workflowId: 'a', status: 'running', createdAt: 0});
    delete rec.closedAt;
    expect(swept([rec], Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('sweeps failed and terminated executions like completed ones', () => {
    const records = [
      record({workflowId: 'f', status: 'failed'}),
      record({workflowId: 't', status: 'terminated'}),
    ];
    expect(swept(records, 1_000).sort()).toEqual(['f', 't']);
  });

  /**
   * Records from before `closedAt` existed still age out: the last event's
   * timestamp, then creation, stand in — both err toward *older*, which is the
   * honest direction for a record the store has not written since.
   */
  it('falls back to the last event timestamp when closedAt is absent', () => {
    const rec = record({
      workflowId: 'a',
      history: [{type: 'workflowStarted', ts: 900} as HistoryEvent],
    });
    delete rec.closedAt;
    expect(swept([rec], 899)).toEqual([]);
    expect(swept([rec], 900)).toEqual(['a']);
  });

  it('falls back to createdAt when there are no timestamps at all', () => {
    const rec = record({workflowId: 'a', createdAt: 700});
    delete rec.closedAt;
    expect(swept([rec], 700)).toEqual(['a']);
  });

  /**
   * The one correctness constraint. On a boot after a crash, `resume()` gives a
   * parent the outcome it missed by reading the settled child's own record —
   * so that record must outlive the window until the parent has it.
   */
  it('keeps a settled child while its running parent lacks the outcome', () => {
    const records = [
      record({
        workflowId: 'parent',
        status: 'running',
        history: [],
      }),
      record({workflowId: 'child', parent: {workflowId: 'parent', seq: 3}}),
    ];
    expect(swept(records, 1_000)).toEqual([]);
  });

  it('sweeps the child once the parent history holds its outcome', () => {
    const records = [
      record({
        workflowId: 'parent',
        status: 'running',
        history: [
          {type: 'childCompleted', seq: 3, result: null} as HistoryEvent,
        ],
      }),
      record({workflowId: 'child', parent: {workflowId: 'parent', seq: 3}}),
    ];
    expect(swept(records, 1_000)).toEqual(['child']);
  });

  it('holds the child on the outcome of its own seq, not a sibling’s', () => {
    const records = [
      record({
        workflowId: 'parent',
        status: 'running',
        history: [
          {type: 'childCompleted', seq: 7, result: null} as HistoryEvent,
        ],
      }),
      record({workflowId: 'child', parent: {workflowId: 'parent', seq: 3}}),
    ];
    expect(swept(records, 1_000)).toEqual([]);
  });

  // A closed or vanished parent will never ask for the outcome again.
  it('releases the child when the parent is terminal or gone', () => {
    const closedParent = [
      record({workflowId: 'parent', status: 'completed'}),
      record({workflowId: 'child', parent: {workflowId: 'parent', seq: 3}}),
    ];
    expect(swept(closedParent, 1_000).sort()).toEqual(['child', 'parent']);

    const orphan = [
      record({workflowId: 'child', parent: {workflowId: 'gone', seq: 3}}),
    ];
    expect(swept(orphan, 1_000)).toEqual(['child']);
  });
});

describe('closedAt', () => {
  it('is stamped by a terminal status and cleared by a revival', async () => {
    const store = new MemoryHistoryStore();
    await store.create('wf-1', 'wf', []);
    expect((await store.get('wf-1'))?.closedAt).toBeUndefined();

    await store.setStatus('wf-1', 'completed', {result: 42});
    expect((await store.get('wf-1'))?.closedAt).toBeDefined();

    // A reset revives the execution; a stale close time would age it toward
    // the very sweep the reset was rescuing it from.
    await store.setStatus('wf-1', 'running');
    expect((await store.get('wf-1'))?.closedAt).toBeUndefined();
  });
});

/**
 * Through the server host, because the rule being right is worth nothing if
 * nothing calls it: the sweep must actually run, delete, and release the id.
 */
describe('retention — through the server host', () => {
  async function until(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    throw new Error('condition not reached within 5s');
  }

  it('deletes a closed execution and releases its id', async () => {
    const store = new MemoryHistoryStore();
    const host = createServerHost(store, {
      retainClosedForMs: 0,
      retentionSweepIntervalMs: 20,
    });
    try {
      await host.start('wf', undefined, {workflowId: 'order-1'});
      await host.terminate('order-1', 'retention spec');

      await until(async () => (await store.get('order-1')) === undefined);

      // The claim went with the record: the same id now names a NEW execution
      // — the documented consequence of running with retention.
      const reclaimed = await host.start('wf', undefined, {
        workflowId: 'order-1',
      });
      expect(reclaimed.created).toBeTrue();
    } finally {
      host.shutdown();
    }
  });

  it('leaves running executions alone across sweeps', async () => {
    const host = createServerHost(new MemoryHistoryStore(), {
      retainClosedForMs: 0,
      retentionSweepIntervalMs: 20,
    });
    try {
      await host.start('wf', undefined, {workflowId: 'still-going'});
      // Two sweep intervals is plenty for a wrong implementation to show.
      await new Promise<void>((r) => setTimeout(r, 60));
      expect(
        (await host.listExecutions()).executions.map((e) => e.workflowId),
      ).toEqual(['still-going']);
    } finally {
      host.shutdown();
    }
  });

  it('sweeps nothing when no retention is configured', async () => {
    const store = new MemoryHistoryStore();
    const host = createServerHost(store);
    try {
      await host.start('wf', undefined, {workflowId: 'kept'});
      await host.terminate('kept', 'retention spec');
      await new Promise<void>((r) => setTimeout(r, 60));
      expect((await store.get('kept'))?.status).toBe('terminated');
    } finally {
      host.shutdown();
    }
  });

  /**
   * The id floor, across the restart that makes it matter. In one process the
   * counter is monotonic and cannot regress; it is the next boot — seeding
   * from a store the sweep has emptied — that would mint a second `greeter-1`
   * unless the store remembered what it deleted.
   */
  it('does not reissue a swept generated id after a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-retention-'));
    try {
      const store1 = await FileHistoryStore.open(dir);
      const host1 = createServerHost(store1, {
        retainClosedForMs: 0,
        retentionSweepIntervalMs: 20,
      });
      const first = await host1.start('greeter');
      await host1.terminate(first.workflowId, 'retention spec');
      await until(
        async () => (await store1.get(first.workflowId)) === undefined,
      );
      host1.shutdown();
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const host2 = createServerHost(store2);
      try {
        await host2.resume(); // seeds the counter — from an empty listing
        const second = await host2.start('greeter');
        expect(second.workflowId).not.toBe(first.workflowId);
      } finally {
        host2.shutdown();
        await store2.close();
      }
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });
});
