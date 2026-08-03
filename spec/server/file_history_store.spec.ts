/**
 * @fileoverview
 * The durable filesystem store: workflows run against it just like the in-memory
 * one (behavior parity), state survives into a freshly-opened store on the same
 * data dir (the durability round-trip), and a second opener is refused (the
 * single-writer lock). Each test uses a throwaway temp dir.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalRuntime, FileHistoryStore } from '../../src';
import { runActivity } from '../../src/workflow';

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-fs-'));
}

describe('FileHistoryStore', () => {
  it('runs workflows against the durable store (behavior parity)', async () => {
    const dir = await tmpDir();
    const store = await FileHistoryStore.open(dir);
    try {
      const rt = createLocalRuntime({ historyStore: store })
        .registerActivity('greet', (n: string) => `hi ${n}`)
        .registerWorkflow('greeter', async () =>
          runActivity<string>('greet', 'world'),
        );

      await expectAsync(rt.start<string>('greeter').result()).toBeResolvedTo(
        'hi world',
      );
    } finally {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists an execution and reloads it in a fresh store on the same dir', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      const rt = createLocalRuntime({ historyStore: store1 })
        .registerActivity('double', (n: number) => n * 2)
        .registerWorkflow('doubler', async () =>
          runActivity<number>('double', 21),
        );

      await rt.start<number>('doubler', [], { workflowId: 'wf-1' }).result();
      await store1.close(); // flush + release lock

      // A brand-new store rebuilds its cache from disk — nothing in memory carried over.
      const store2 = await FileHistoryStore.open(dir);
      const rec = await store2.get('wf-1');
      expect(rec?.status).toBe('completed');
      expect(rec?.result).toBe(42);
      expect(rec?.history.some((e) => e.type === 'activityScheduled')).toBe(
        true,
      );
      expect(rec?.history.some((e) => e.type === 'activityCompleted')).toBe(
        true,
      );
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The reason the task-failure counter lives on the record instead of in the
   * queue: a restart is the first thing anyone tries on a stuck execution, and a
   * counter that reset there would make a poison task immortal — its backoff
   * would return to zero every time.
   */
  it('carries the workflow-task failure count across a restart', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('wf-1', 'w', []);
      await store1.recordTaskFailure('wf-1', 'nondeterminism at seq 0');
      await store1.recordTaskFailure('wf-1', 'nondeterminism at seq 0');
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const rec = await store2.get('wf-1');
      expect(rec?.taskFailures).toBe(2);
      expect(rec?.lastTaskFailure).toBe('nondeterminism at seq 0');
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('clears the failure count durably once a task succeeds', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('wf-1', 'w', []);
      await store1.recordTaskFailure('wf-1', 'boom');
      await store1.clearTaskFailures('wf-1');
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const rec = await store2.get('wf-1');
      expect(rec?.taskFailures).toBe(0);
      expect(rec?.lastTaskFailure).toBeUndefined();
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces a single writer via a lockfile', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await expectAsync(FileHistoryStore.open(dir)).toBeRejectedWithError(
        /locked/,
      );

      await store1.close(); // releasing the lock lets a fresh store open
      const store2 = await FileHistoryStore.open(dir);
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock left by a dead process (crash restart)', async () => {
    const dir = await tmpDir();
    try {
      // A crash leaves a lock file naming a pid that is no longer running.
      await fs.writeFile(path.join(dir, 'lock'), '999999999');
      // Open must reclaim it rather than refuse forever (else Restart=always loops).
      const store = await FileHistoryStore.open(dir);
      expect(await store.list()).toEqual([]);
      await store.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
