// Crash recovery end to end: start a workflow, drop the runtime mid-flight (while
// it's parked on a timer / activity / child), then open a *fresh* runtime + store
// on the same data dir and let `resume()` carry it to completion from history.
// A `shutdown()` (stopping timers) + `close()` stands in for the process dying.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalRuntime, FileHistoryStore, type Runtime } from '../../src';
import { runActivity, sleep, executeChild } from '../../src/workflow';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'wf-resume-'));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('crash recovery — resume from a durable store', () => {
  it('resumes a workflow parked on a timer', async () => {
    const dir = await tmpDir();
    const napper = async () => {
      await sleep(30);
      return 'awake';
    };
    try {
      // process 1: dispatch the timer, then "crash"
      const store1 = await FileHistoryStore.open(dir);
      const rt1 = createLocalRuntime({ historyStore: store1 }).registerWorkflow(
        'napper',
        napper,
      );
      rt1.start('napper', [], { workflowId: 'nap-1' });
      await wait(15); // let timerStarted persist
      rt1.shutdown();
      await store1.close();

      // process 2: fresh runtime rebuilds from disk and re-arms the timer
      const store2 = await FileHistoryStore.open(dir);
      const rt2 = createLocalRuntime({ historyStore: store2 }).registerWorkflow(
        'napper',
        napper,
      );
      await rt2.resume();

      await expectAsync(rt2.getHandle<string>('nap-1').result()).toBeResolvedTo(
        'awake',
      );
      rt2.shutdown();
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resumes and re-dispatches a pending activity', async () => {
    const dir = await tmpDir();
    const doer = async () => runActivity<string>('work');
    try {
      const store1 = await FileHistoryStore.open(dir);
      const rt1 = createLocalRuntime({ historyStore: store1 })
        .registerActivity('work', () => new Promise<string>(() => {})) // never settles: crash mid-activity
        .registerWorkflow('doer', doer);
      rt1.start('doer', [], { workflowId: 'do-1' });
      await wait(15); // let activityScheduled persist
      rt1.shutdown();
      await store1.close();

      let ran = 0;
      const store2 = await FileHistoryStore.open(dir);
      const rt2 = createLocalRuntime({ historyStore: store2 })
        .registerActivity('work', () => {
          ran += 1;
          return 'worked';
        })
        .registerWorkflow('doer', doer);
      await rt2.resume();

      await expectAsync(rt2.getHandle<string>('do-1').result()).toBeResolvedTo(
        'worked',
      );
      expect(ran).toBe(1); // re-dispatched exactly once (from the activityScheduled marker)
      rt2.shutdown();
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resumes a parent blocked on a child, rebuilding the correlation', async () => {
    const dir = await tmpDir();
    const child = async (n: number) => {
      await sleep(30);
      return n;
    };
    const parent = async () => (await executeChild<number>('child', 5)) * 2;
    try {
      const store1 = await FileHistoryStore.open(dir);
      const rt1 = createLocalRuntime({ historyStore: store1 })
        .registerWorkflow('child', child)
        .registerWorkflow('parent', parent);
      rt1.start('parent', [], { workflowId: 'par-1' });
      await wait(15); // let childStarted (parent) + timerStarted (child) persist
      rt1.shutdown();
      await store1.close();

      const store2 = await FileHistoryStore.open(dir);
      const rt2 = createLocalRuntime({ historyStore: store2 })
        .registerWorkflow('child', child)
        .registerWorkflow('parent', parent);
      await rt2.resume(); // rebuilds parent<->child link, re-arms the child's timer

      await expectAsync(rt2.getHandle<number>('par-1').result()).toBeResolvedTo(
        10,
      );
      rt2.shutdown();
      await store2.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
