/**
 * @fileoverview
 * The durable filesystem store: workflows run against it just like the in-memory
 * one (behavior parity), state survives into a freshly-opened store on the same
 * data dir (the durability round-trip), and a second opener is refused (the
 * single-writer lock). Each test uses a throwaway temp dir.
 */

import {promises as fs} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createLocalRuntime, FileHistoryStore} from '../../src';
import {runActivity} from '../../src/workflow';

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-fs-'));
}

describe('FileHistoryStore', () => {
  it('runs workflows against the durable store (behavior parity)', async () => {
    const dir = await tmpDir();
    const store = await FileHistoryStore.open(dir);
    try {
      const rt = createLocalRuntime({historyStore: store})
        .registerActivity('greet', (n: string) => `hi ${n}`)
        .registerWorkflow('greeter', async () =>
          runActivity<string>('greet', 'world'),
        );

      await expectAsync(rt.start<string>('greeter').result()).toBeResolvedTo(
        'hi world',
      );
    } finally {
      await store.close();
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('persists an execution and reloads it in a fresh store on the same dir', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      const rt = createLocalRuntime({historyStore: store1})
        .registerActivity('double', (n: number) => n * 2)
        .registerWorkflow('doubler', async () =>
          runActivity<number>('double', 21),
        );

      await rt
        .start<number>('doubler', undefined, {workflowId: 'wf-1'})
        .result();
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
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  /**
   * The reason the task-failure counter lives on the record instead of in the
   * queue: a restart is the first thing anyone tries on a stuck execution, and a
   * counter that reset there would make a poison task immortal — its backoff
   * would return to zero every time.
   */
  it('deletes an execution durably, remembering its id suffix', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('greeter-4', 'greeter', {});
      await store1.delete('greeter-4');
      expect(await store1.get('greeter-4')).toBeUndefined();
      await store1.close();

      // Gone from disk, not merely from the cache — and the suffix floor is
      // the one thing the deletion leaves behind, for the id seeding that can
      // no longer read the id itself. See `HistoryStore.delete`.
      const store2 = await FileHistoryStore.open(dir);
      expect(await store2.get('greeter-4')).toBeUndefined();
      expect(store2.highestDeletedSuffix).toBe(4);
      await store2.close();
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('persists closedAt with the terminal status', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('wf-done', 'wf', {});
      await store1.setStatus('wf-done', 'completed', {result: 1});
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      expect((await store2.get('wf-done'))?.closedAt).toBeDefined();
      await store2.close();
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('carries the workflow-task failure count across a restart', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('wf-1', 'w', {});
      await store1.recordTaskFailure('wf-1', 'nondeterminism at seq 0');
      await store1.recordTaskFailure('wf-1', 'nondeterminism at seq 0');
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const rec = await store2.get('wf-1');
      expect(rec?.taskFailures).toBe(2);
      expect(rec?.lastTaskFailure).toBe('nondeterminism at seq 0');
      await store2.close();
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('clears the failure count durably once a task succeeds', async () => {
    const dir = await tmpDir();
    try {
      const store1 = await FileHistoryStore.open(dir);
      await store1.create('wf-1', 'w', {});
      await store1.recordTaskFailure('wf-1', 'boom');
      await store1.clearTaskFailures('wf-1');
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const rec = await store2.get('wf-1');
      expect(rec?.taskFailures).toBe(0);
      expect(rec?.lastTaskFailure).toBeUndefined();
      await store2.close();
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
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
      await fs.rm(dir, {recursive: true, force: true});
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
      await fs.rm(dir, {recursive: true, force: true});
    }
  });
});

describe('file store — a data directory from before props', () => {
  /**
   * The whole point of the guard. Every field is optional-shaped after
   * `JSON.parse`, so an old `meta.json` would otherwise load with
   * `props: undefined` and every execution would resume running against
   * nothing — a workflow that charged an order silently charging `undefined`.
   * Refusing the boot is the only honest option, since there is no migration.
   */
  it('refuses to open rather than reading every execution as propless', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-oldfmt-'));
    const exec = path.join(dir, 'executions', 'old');
    await fs.mkdir(exec, {recursive: true});
    await fs.writeFile(
      path.join(exec, 'meta.json'),
      JSON.stringify({
        workflowId: 'old',
        runId: 0,
        name: 'charge',
        args: [{amount: 100}], // the shape this release replaced
        status: 'running',
      }),
    );
    await fs.writeFile(path.join(exec, 'events.jsonl'), '');

    // Read off the message rather than matched against a pattern built from the
    // paths. A regex interpolating a directory is only literal where separators
    // are `/`: on Windows the same string carries `\w`, `\t`, `\d`, which are
    // character classes, so the pattern stops matching the very string it was
    // built from — passing on POSIX and failing here, for a message that is
    // correct either way.
    let error: Error | undefined;
    try {
      await FileHistoryStore.open(dir);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain('older format');
    // Names the record, one level down, so the reader can see what is wrong…
    expect(error?.message).toContain(exec);
    // …and names the *data* directory as the thing to delete. The comma is what
    // makes this discriminating: deleting only the record clears this one and
    // stops the next boot on the next.
    expect(error?.message).toContain(`delete ${dir},`);
    expect(error?.message).toContain('--data-dir');

    await fs.rm(dir, {recursive: true, force: true});
  });

  it('does not leave the dir locked when it refuses it', async () => {
    // The lock is taken before the load, so a refusal would otherwise outlive
    // the failed open and the *next* attempt would report `is locked` — burying
    // the reason under a complaint about the wreckage. The guard exists to be
    // read, so it has to survive being read twice.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-oldfmt-'));
    const exec = path.join(dir, 'executions', 'old');
    await fs.mkdir(exec, {recursive: true});
    await fs.writeFile(
      path.join(exec, 'meta.json'),
      JSON.stringify({
        workflowId: 'old',
        runId: 0,
        name: 'charge',
        args: [],
        status: 'running',
      }),
    );
    await fs.writeFile(path.join(exec, 'events.jsonl'), '');

    await expectAsync(FileHistoryStore.open(dir)).toBeRejected();
    await expectAsync(FileHistoryStore.open(dir)).toBeRejectedWithError(
      /older format/,
    );

    await fs.rm(dir, {recursive: true, force: true});
  });

  it('opens clean once the directory is gone, which is the documented fix', async () => {
    // The instruction the guard gives, carried out literally: delete the data
    // dir and start again. `open` recreates it, so nothing has to be
    // provisioned first — and the id the old record held is free, because the
    // claim lived in the record that went with it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-oldfmt-'));
    const exec = path.join(dir, 'executions', 'old');
    await fs.mkdir(exec, {recursive: true});
    await fs.writeFile(
      path.join(exec, 'meta.json'),
      JSON.stringify({
        workflowId: 'old',
        runId: 0,
        name: 'charge',
        args: [],
        status: 'running',
      }),
    );
    await fs.writeFile(path.join(exec, 'events.jsonl'), '');
    await expectAsync(FileHistoryStore.open(dir)).toBeRejected();

    await fs.rm(dir, {recursive: true, force: true});

    const store = await FileHistoryStore.open(dir);
    expect(await store.list()).toEqual([]);
    await store.create('old', 'charge', {amount: 100});
    expect((await store.get('old'))?.props).toEqual({amount: 100});
    await store.close();

    await fs.rm(dir, {recursive: true, force: true});
  });
});
