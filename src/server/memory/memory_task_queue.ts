// In-memory TaskQueue: a plain FIFO. No leasing or redelivery — in LocalService
// the server enqueues a task and polls it back synchronously in the same tick, so
// nothing is ever in flight. The lease/expiry machinery is added with the durable
// queue in Phase 5.
import type { ActivityTask } from '../../protocol';
import type { TaskQueue } from '../ports/task_queue';

export class MemoryTaskQueue implements TaskQueue {
  private readonly queue: ActivityTask[] = [];

  enqueue(task: ActivityTask): void {
    this.queue.push(task);
  }

  poll(): ActivityTask | undefined {
    return this.queue.shift();
  }
}
