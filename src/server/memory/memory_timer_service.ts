/**
 * @fileoverview
 * In-memory TimerService: a table of pending timers, each armed with a real
 * `setTimeout`, so durations and firing *order* are honored (a 10ms timer fires
 * before a 40ms one). The table stands in for the durable store a real adapter
 * would persist; `recover()` re-arms it the way a server would sweep persisted
 * timers on boot.
 *
 * ## Handles are ref'd, deliberately
 *
 * A pending timer here means a workflow is waiting on it, which is outstanding
 * work the process still owes someone — so it keeps the process alive, like any
 * other unfinished operation.
 *
 * `unref`'ing them — on the reasoning that a stray timer must never hold a
 * process open — buys a worse failure than the one it prevents: a script that
 * starts a workflow and lets it park exits **code 0 with no output**, having run
 * none of the workflow past its first `sleep`. Silence and success are the two
 * things a lost execution should never look like.
 *
 * The suite cannot see that failure — Jasmine's runner holds the event loop
 * open, so the timer fires anyway. `spec/integration/process_lifetime.spec.ts`
 * spawns a real process for exactly that reason.
 *
 * Nothing leaks: a fired timer stops holding the loop by itself, `cancel`
 * clears one, and `stop` clears all of them. Timers that merely *bound* other
 * work — activity attempt deadlines in `server_core` — stay unref'd, because
 * they interrupt work rather than produce it, and the work they are watching
 * holds the loop on its own.
 */

import type {TimerService} from '../ports/timer_service';

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

  schedule(workflowId: string, seq: number, fireAt: number): void {
    const key = this.key(workflowId, seq);
    if (this.timers.has(key)) return; // already scheduled — idempotent safety
    const delay = Math.max(0, fireAt - Date.now()); // past-due => fire ASAP
    const entry: TimerEntry = {workflowId, seq, fireAt};
    entry.handle = setTimeout(() => this.fire(key), delay);
    this.timers.set(key, entry);
  }

  cancel(workflowId: string, seq: number): void {
    const key = this.key(workflowId, seq);
    const entry = this.timers.get(key);
    if (!entry) return;
    if (entry.handle) clearTimeout(entry.handle);
    this.timers.delete(key);
  }

  cancelAll(workflowId: string): void {
    for (const [key, entry] of [...this.timers]) {
      if (entry.workflowId !== workflowId) continue;
      if (entry.handle) clearTimeout(entry.handle);
      this.timers.delete(key);
    }
  }

  recover(): void {
    const now = Date.now();
    for (const [key, entry] of [...this.timers]) {
      if (entry.handle) clearTimeout(entry.handle);
      const delay = Math.max(0, entry.fireAt - now); // past-due => 0 => fires ASAP
      entry.handle = setTimeout(() => this.fire(key), delay);
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
