/**
 * @fileoverview
 * The worker run-loops: poll a service for a task, do the work, report back,
 * repeat. Written once against `WorkflowService`, so they run against `LocalService`
 * in-proc or a `RemoteService` over RPC — the same worker code either way.
 * A deployable worker (`startWorker`) runs these against a RemoteService.
 *
 * Failures are **reported and backed off**, never swallowed. A worker that cannot
 * reach its server is the single most likely deployment fault, and it is
 * otherwise invisible: a loop that caught everything, retried on the 5ms idle
 * interval and printed nothing would leave a misconfigured worker looking
 * healthy to its supervisor while doing no work and hammering a dead endpoint.
 */

import * as os from 'node:os';
import type {WorkflowService} from '../protocol';
import type {ActivityWorker} from './activity_worker';
import type {WorkflowWorker} from './workflow_worker';

/**
 * What this process calls itself when it asks for work.
 *
 * `${pid}@${hostname}`, which is the convention Temporal's SDKs use, and it is
 * chosen for what an operator does next: both halves are things you can act on
 * — ssh to the host, find the pid, read its logs — where a random id would only
 * be a handle to something you still have to locate.
 *
 * Computed here rather than anywhere lower down. `core/` may not read the
 * process or the clock at all, and identity is exactly the kind of ambient fact
 * that ban exists to keep out of replay; the worker is the outermost layer and
 * the only one that legitimately knows where it is running.
 *
 * Read once per process rather than per poll: `os.hostname()` can hit the
 * network on a misconfigured host, and this runs every few milliseconds.
 */
export const DEFAULT_IDENTITY = `${process.pid}@${os.hostname()}`;

// Ref'd on purpose: a worker process must stay alive between polls. The loops are
// bounded by an explicit stop(), so this never keeps a process alive spuriously.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WorkerLoop {
  /** Stop polling and wait for the in-flight iteration to finish. */
  stop(): Promise<void>;
}

export interface WorkerLoopOptions {
  /**
   * Which pool this worker serves. Every worker on a queue must be able to run
   * everything routed to it, so this is a claim about what the process contains.
   * Omitted means "any queue", which only the in-process runtime should use.
   */
  taskQueue?: string;
  /**
   * What this worker calls itself, sent on every poll so the server can count
   * and name the fleet. Defaults to `${pid}@${hostname}`.
   *
   * Worth overriding wherever the process is not where an operator would look —
   * a container id or a deployment name beats a pid on a host nobody can ssh
   * to. Not verified and not unique by construction: two processes claiming one
   * identity are counted once. See `WorkerInfo`.
   */
  identity?: string;
  /**
   * How many claimed tasks this loop may have in flight at once. Default 1,
   * which is the sequential loop this has always been.
   *
   * **The knob is for activities.** Their work is the consumer's I/O — an HTTP
   * call, a query, a model that thinks for thirty seconds — and a sequential
   * loop leaves the whole process idle for the duration of each one. Raising it
   * costs nothing but the concurrency the consumer's own code can stand.
   *
   * Raising it for *workflow* tasks is supported and rarely worth it. Replay is
   * CPU work on a single thread, so concurrency there buys no parallelism, only
   * the overlap of the poll and complete round trips. It is safe — `als` carries
   * each replay's context so two never see each other's, and the server will not
   * hand out two tasks for one execution — but measure before assuming it helps.
   *
   * Values below 1 are clamped, so `0` cannot silently stop a worker.
   */
  maxConcurrentTasks?: number;
  /** Backoff when a poll returns no task. */
  pollIntervalMs?: number;
  /** Delay after the first failure; doubles per consecutive failure. Default 50ms. */
  errorBackoffMs?: number;
  /** Ceiling for the error backoff. Default 5s. */
  maxErrorBackoffMs?: number;
  /**
   * A digest of what this worker has registered, from `startWorkflowReporter`.
   *
   * Optional, and a worker that omits it still gets tasks — it is only reported as
   * unknown rather than as serving nothing. See `PollRequest.servesHash`.
   */
  servesHash?: string;
  /** Where failures are reported. Defaults to a rate-limited stderr reporter. */
  onError?: (error: unknown, consecutive: number) => void;
}

/**
 * Exponential, capped. The idle interval is milliseconds — fine when the answer
 * is "no work", ruinous when the answer is a connection error, which would
 * otherwise be retried hundreds of times a second for as long as the fault lasts.
 */
export function errorBackoffMs(
  consecutive: number,
  initialMs: number,
  maxMs: number,
): number {
  return Math.min(initialMs * 2 ** (consecutive - 1), maxMs);
}

/**
 * Report the first failure, then on a doubling schedule (1st, 2nd, 4th, 8th…), and
 * always report a *different* message. A persistent outage stays visible in the
 * log without burying everything else in it.
 */
export function createErrorReporter(
  role: string,
  write: (line: string) => void = (line) => process.stderr.write(line),
): (error: unknown, consecutive: number) => void {
  let lastMessage: string | undefined;
  return (error, consecutive) => {
    const message = error instanceof Error ? error.message : String(error);
    const isDoubling = (consecutive & (consecutive - 1)) === 0;
    if (message === lastMessage && !isDoubling) return;
    lastMessage = message;
    write(`${role}: poll failed (${consecutive}x): ${message}\n`);
  };
}

/**
 * What a claimed task still has to do. Returned by the claim step rather than
 * performed inside it, which is the whole of how concurrency works here: the
 * loop starts this and goes back to polling instead of waiting for it.
 */
type TaskRunner = () => Promise<void>;

/**
 * The shared loop both workers are: claim a task, start it, poll again.
 *
 * `claim` returns `undefined` when there was nothing to take, which is how the
 * loop tells "idle" (back off briefly) from "took one" (poll again at once).
 *
 * ## Polling is serial; the work is not
 *
 * There is one poll outstanding at a time however wide `maxConcurrentTasks` is.
 * The alternative — N pollers — multiplies idle traffic by N against a queue
 * that is empty most of the time, and buys nothing: a poll is one round trip and
 * the work is what takes long enough to be worth overlapping.
 *
 * ## A slot is taken before the poll, never after
 *
 * `waitForSlot` runs *before* `claim`, so this never holds a task it has not
 * started. That ordering is the correctness of the whole change rather than a
 * tidiness: an activity task is leased from the moment it is handed over, and a
 * task sitting in a worker-side buffer is a lease ticking down against work that
 * has not begun. The server would redeliver it — to this worker or another —
 * while this process still holds it, and the activity would run twice for one
 * dispatch. Buffering here is the one thing this loop must not do.
 */
function runPollLoop(
  role: string,
  options: WorkerLoopOptions,
  claim: () => Promise<TaskRunner | undefined>,
): WorkerLoop {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const initialBackoff = options.errorBackoffMs ?? 50;
  const maxBackoff = options.maxErrorBackoffMs ?? 5000;
  // Clamped rather than validated: a `0` from a misread flag should run the
  // worker sequentially, not silently stop it from taking any work at all.
  const capacity = Math.max(1, Math.trunc(options.maxConcurrentTasks ?? 1));
  const report = options.onError ?? createErrorReporter(role);

  let stopped = false;
  let consecutiveErrors = 0;
  const active = new Set<Promise<void>>();

  /**
   * Block until one of the in-flight tasks finishes. A race over the live set
   * rather than a counter with a queue of waiters, because the set has to exist
   * anyway for `stop` to drain it, and nothing in it ever rejects — each entry
   * catches its own failure below.
   */
  async function waitForSlot(): Promise<void> {
    while (active.size >= capacity) await Promise.race(active);
  }

  function start(run: TaskRunner): void {
    const settled = (async () => {
      try {
        await run();
      } catch (e) {
        // Reported here rather than thrown, because the loop that started this
        // has already moved on to the next poll and has no frame left to catch
        // it in. An unreported failure is invisible to the supervisor, which is
        // the fault this loop exists to make loud.
        //
        // It does **not** reset `consecutiveErrors` on success, deliberately:
        // with several tasks in flight, a straggler completing while the server
        // is unreachable would zero the counter the poll path is using to back
        // off, and the worker would go back to hammering a dead endpoint.
        consecutiveErrors += 1;
        report(e, consecutiveErrors);
      }
    })();
    active.add(settled);
    // Fire-and-forget: the loop awaits `active` itself on the way out, so this
    // handle exists only to shrink the set. Registered rather than written as a
    // `finally` inside the task, which would have to name the promise it is
    // part of before that promise exists.
    void settled.then(() => active.delete(settled));
  }

  const done = (async () => {
    while (!stopped) {
      try {
        await waitForSlot();
        if (stopped) break; // a slot may have freed only because stop() was called
        const run = await claim();
        // Reset on the poll returning at all, not on it returning work: an idle
        // poll still proves the server is reachable, which is the only thing
        // this counter measures.
        consecutiveErrors = 0;
        if (!run) {
          await sleep(pollIntervalMs);
          continue;
        }
        start(run);
      } catch (e) {
        consecutiveErrors += 1;
        report(e, consecutiveErrors);
        await sleep(
          errorBackoffMs(consecutiveErrors, initialBackoff, maxBackoff),
        );
      }
    }
    // Stopping stops *polling*. Work already claimed still owes the server a
    // result, and dropping it here would leave the lease to expire and the task
    // to be redelivered — a clean shutdown that looks like a crash.
    await Promise.all([...active]);
  })();

  return {
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}

export function runWorkflowWorker(
  service: WorkflowService,
  worker: WorkflowWorker,
  options: WorkerLoopOptions = {},
): WorkerLoop {
  const identity = options.identity ?? DEFAULT_IDENTITY;
  return runPollLoop('workflow worker', options, async () => {
    const task = await service.pollWorkflowTask({
      taskQueue: options.taskQueue,
      identity,
      // Fixed for the life of the loop, because what a worker has registered is fixed
      // when the process starts. It rides every poll so a server that restarts learns of
      // this worker again without being asked.
      ...(options.servesHash === undefined
        ? {}
        : {servesHash: options.servesHash}),
    });
    if (!task) return undefined;
    return async () => {
      let result;
      try {
        result = await worker.replayTask(task);
      } catch (e) {
        // Replay itself broke — a nondeterminism error, or a throw from outside the
        // workflow's own control flow. Report it instead of letting it escape to
        // the loop's catch: an unreported task is invisible to the server, which
        // learns only when the lease expires and then knows nothing about *why*.
        // Reporting is what makes the failure countable, diagnosable, and paced.
        await service.failWorkflowTask(task.token, errorMessage(e));
        return;
      }
      await service.completeWorkflowTask(task.token, result);
    };
  });
}

export function runActivityWorker(
  service: WorkflowService,
  worker: ActivityWorker,
  options: WorkerLoopOptions = {},
): WorkerLoop {
  const identity = options.identity ?? DEFAULT_IDENTITY;
  return runPollLoop('activity worker', options, async () => {
    const task = await service.pollActivityTask({
      taskQueue: options.taskQueue,
      identity,
      ...(options.servesHash === undefined
        ? {}
        : {servesHash: options.servesHash}),
    });
    if (!task) return undefined;
    // One attempt per delivery; the lease redelivers on failure/crash
    // (at-least-once), unless the attempt heartbeats to keep its claim.
    return async () => {
      const result = await worker.runTask(task, () => {
        void service.heartbeatActivityTask(task.token).catch(() => {});
      });
      await service.completeActivityTask(task.token, result);
    };
  });
}
