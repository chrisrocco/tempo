// The original motivating workflow, end to end. A "hotlist monitor" watches a
// stream of add/remove diffs and keeps one child monitor running per active bug:
// spawn a fire-and-forget child on add, cancel it on remove. This is the real
// spawn-and-cancel shape the project was designed around (doc 03) — it only
// became expressible once fire-and-forget children + cancellation landed
// (Phase 3, Slice 4). It runs entirely against LocalService.
import { createLocalRuntime, type Runtime } from '../src';
import {
  condition,
  defineSignal,
  setHandler,
  runActivity,
  sleep,
  startChild,
  type ChildHandle,
} from '../src/workflow';

export interface BugDiff {
  bugId: string;
  action: 'add' | 'remove';
}

export const diffSignal = defineSignal('diff');
export const stopSignal = defineSignal('stop');

// A per-bug monitor: "checks" the bug periodically until it is cancelled.
export async function bugMonitor(bugId: string): Promise<void> {
  for (;;) {
    await runActivity('checkBug', bugId);
    await sleep(5);
  }
}

// The hotlist monitor. The handler-only-enqueues discipline (doc 03) keeps the
// loop the single place that acts on diffs; each add spawns a child monitor, each
// remove cancels one, and `stop` tears the remaining monitors down and returns.
export async function hotlistMonitor(): Promise<string[]> {
  const queue: BugDiff[] = [];
  let stopped = false;
  const monitors = new Map<string, ChildHandle>();
  const everMonitored: string[] = [];

  setHandler(diffSignal, (d: BugDiff) => queue.push(d));
  setHandler(stopSignal, () => { stopped = true; });

  for (;;) {
    await condition(() => queue.length > 0 || stopped);

    while (queue.length > 0) {
      const diff = queue.shift()!;
      if (diff.action === 'add' && !monitors.has(diff.bugId)) {
        monitors.set(diff.bugId, startChild('bugMonitor', diff.bugId));
        everMonitored.push(diff.bugId);
      } else if (diff.action === 'remove') {
        monitors.get(diff.bugId)?.cancel();
        monitors.delete(diff.bugId);
      }
    }

    if (stopped) {
      for (const handle of monitors.values()) handle.cancel(); // clean up survivors
      monitors.clear();
      return everMonitored;
    }
  }
}

/** Wire a LocalService runtime with the monitor + its child, reporting each check. */
export function bugHotlistRuntime(onCheck: (bugId: string) => void = () => {}): Runtime {
  return createLocalRuntime()
    .registerActivity('checkBug', (bugId: string) => { onCheck(bugId); return true; })
    .registerWorkflow('bugMonitor', bugMonitor)
    .registerWorkflow('hotlistMonitor', hotlistMonitor);
}
