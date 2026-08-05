/**
 * @fileoverview
 * A child execution knows where it came from.
 *
 * The parent's `childStarted` event has always recorded the relationship, but
 * only in one direction: opening a child gave no way back. The in-memory
 * `parentOfChild` map in `server_core` is not that answer either — it exists to
 * route a completion, so it holds only *blocking* children, only while they are
 * running, and only on the process that dispatched them.
 *
 * So the parent goes on the child's record at creation. The cases that matter
 * are the ones where the in-memory map would have been empty: a detached child,
 * which nothing is waiting on, and a settled one, which has already been
 * removed from it.
 */

import {promises as fs} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createLocalRuntime, FileHistoryStore} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {executeChild, startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('a child execution and its parent', () => {
  it('records the parent that started it', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('child', async () => 'done')
      .registerWorkflow('parent', async () =>
        executeChild('child', {workflowId: 'kid-1'}),
      )
      .start('parent', [], {workflowId: 'p-1'});
    await wait(150);

    expect((await store.get('kid-1'))?.parent).toEqual({
      workflowId: 'p-1',
      seq: 0,
    });
  });

  it('records it for a detached child, which nothing is waiting on', async () => {
    // The case the in-memory map never holds: a detached child reports nothing
    // back, so it is never entered there — but it still came from somewhere.
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('child', async () => 'done')
      .registerWorkflow('parent', async () => {
        startChild('child', {workflowId: 'kid-2'});
        await wait(30);
        return 'started it';
      })
      .start('parent', [], {workflowId: 'p-2'});
    await wait(200);

    expect((await store.get('kid-2'))?.parent).toEqual({
      workflowId: 'p-2',
      seq: 0,
    });
  });

  it('keeps it after the child has settled', async () => {
    // The other case the map loses: it is cleared once the completion is routed,
    // and a finished child is exactly what someone is reading in a postmortem.
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('child', async () => 'done')
      .registerWorkflow('parent', async () =>
        executeChild('child', {workflowId: 'kid-3'}),
      )
      .start('parent', [], {workflowId: 'p-3'});
    await wait(200);

    const child = await store.get('kid-3');
    expect(child?.status).toBe('completed');
    expect(child?.parent).toEqual({workflowId: 'p-3', seq: 0});
  });

  it('leaves it unset on an execution a client started directly', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('solo', async () => 'done')
      .start('solo', [], {workflowId: 'alone'});
    await wait(120);

    expect((await store.get('alone'))?.parent).toBeUndefined();
  });

  it('survives into a freshly-opened store on the same data dir', async () => {
    // The reason it is on the record rather than in memory. A restart is when a
    // parent link is most wanted and when an in-memory one is already gone.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-parent-'));
    const store = await FileHistoryStore.open(dir);
    try {
      createLocalRuntime({historyStore: store})
        .registerWorkflow('child', async () => 'done')
        .registerWorkflow('parent', async () =>
          executeChild('child', {workflowId: 'kid-4'}),
        )
        .start('parent', [], {workflowId: 'p-4'});
      await wait(250);
    } finally {
      await store.close();
    }

    const reopened = await FileHistoryStore.open(dir);
    try {
      expect((await reopened.get('kid-4'))?.parent).toEqual({
        workflowId: 'p-4',
        seq: 0,
      });
    } finally {
      await reopened.close();
    }
  });
});
