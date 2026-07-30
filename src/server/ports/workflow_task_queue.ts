// The queue of executions that need a workflow task run. It is the distributed
// replacement for `pump`: instead of a per-execution mutex + rerun flag held in
// one process, wakes enqueue an execution here, a worker polls it (taking a lease),
// and completion releases it. The in-memory adapter keeps `pump`'s two guarantees
// — at most one task in flight per execution (Job 1), and a wake arriving mid-task
// coalesces into exactly one more task (Job 2) — and adds a lease so a crashed
// worker's task redelivers on timeout (docs/architecture/task-execution-and-concurrency.md, distribution.md).
import type { TaskToken } from '../../protocol';

export interface WorkflowTaskQueue {
  /** Mark an execution as needing a task. If one is in flight, coalesce (run once more). */
  enqueue(workflowId: string): void;
  /** Take the next ready execution, leased with a token, or undefined if none. */
  poll(): { token: TaskToken; workflowId: string } | undefined;
  /** Ack a leased task; if a wake arrived while it was in-flight, re-enqueue it. */
  complete(token: TaskToken): void;
}
