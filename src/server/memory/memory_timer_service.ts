// In-memory TimerService: a table of pending timers, each armed with a real
// `setTimeout`, so durations and firing *order* are honored (a 10ms timer fires
// before a 40ms one). The table stands in for the durable store a real adapter
// would persist; `recover()` re-arms it the way a server would sweep persisted
// timers on boot. Handles are `unref`'d so a stray timer can never keep the
// process alive.
import type { TimerService } from '../ports/timer_service';

interface TimerEntry {
  workflowId: string;
  seq: number;
  fireAt: number; // epoch ms — what a durable adapter would persist
  handle?: ReturnType<typeof setTimeout>;
}

export class MemoryTimerService implements TimerService {
  private readonly timers = new Map<string, TimerEntry>();
  private fireHandler: (workflowId: string, seq: number) => void = () => {};

  private key(workflowId: string, seq: number): string {
    return `${workflowId}:${seq}`;
  }

  onFire(handler: (workflowId: string, seq: number) => void): void {
    this.fireHandler = handler;
  }

  schedule(workflowId: string, seq: number, ms: number): void {
    const key = this.key(workflowId, seq);
    if (this.timers.has(key)) return; // already scheduled — idempotent safety
    const delay = Math.max(0, ms);
    const entry: TimerEntry = { workflowId, seq, fireAt: Date.now() + delay };
    entry.handle = setTimeout(() => this.fire(key), delay);
    entry.handle.unref?.();
    this.timers.set(key, entry);
  }

  cancel(workflowId: string, seq: number): void {
    const key = this.key(workflowId, seq);
    const entry = this.timers.get(key);
    if (!entry) return;
    if (entry.handle) clearTimeout(entry.handle);
    this.timers.delete(key);
  }

  recover(): void {
    const now = Date.now();
    for (const [key, entry] of [...this.timers]) {
      if (entry.handle) clearTimeout(entry.handle);
      const delay = Math.max(0, entry.fireAt - now); // past-due => 0 => fires ASAP
      entry.handle = setTimeout(() => this.fire(key), delay);
      entry.handle.unref?.();
    }
  }

  stop(): void {
    for (const entry of this.timers.values()) {
      if (entry.handle) clearTimeout(entry.handle);
    }
    this.timers.clear();
  }

  private fire(key: string): void {
    const entry = this.timers.get(key);
    if (!entry) return;
    this.timers.delete(key);
    this.fireHandler(entry.workflowId, entry.seq);
  }
}
