/**
 * @fileoverview
 * The worker run-loops: poll a service for a task, do the work, report back,
 * repeat. Written once against `WorkflowService`, so they run against `LocalService`
 * in-proc or a `RemoteService` over RPC — the same worker code either way.
 * A deployable worker (`Tempo.startWorker`) runs these against a RemoteService.
 *
 * Failures are **reported and backed off**, never swallowed. A worker that cannot
 * reach its server is the single most likely deployment fault, and it used to be
 * invisible: the loop caught everything, retried on the 5ms idle interval, and
 * printed nothing — so a misconfigured worker looked healthy to its supervisor
 * while doing no work and hammering a dead endpoint. See planning/tickets/02.
 */

import type { WorkflowService } from '../protocol';
import type { ActivityWorker } from './activity_worker';
import type { WorkflowWorker } from './workflow_worker';

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
  /** Backoff when a poll returns no task. */
  pollIntervalMs?: number;
  /** Delay after the first failure; doubles per consecutive failure. Default 50ms. */
  errorBackoffMs?: number;
  /** Ceiling for the error backoff. Default 5s. */
  maxErrorBackoffMs?: number;
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
 * The shared loop both workers are. `pollOnce` returns whether it found work, so
 * the loop can tell "idle" (back off briefly) from "did a task" (poll again now).
 */
function runPollLoop(
  role: string,
  options: WorkerLoopOptions,
  pollOnce: () => Promise<boolean>,
): WorkerLoop {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const initialBackoff = options.errorBackoffMs ?? 50;
  const maxBackoff = options.maxErrorBackoffMs ?? 5000;
  const report = options.onError ?? createErrorReporter(role);

  let stopped = false;
  let consecutiveErrors = 0;

  const done = (async () => {
    while (!stopped) {
      try {
        const didWork = await pollOnce();
        consecutiveErrors = 0;
        if (!didWork) await sleep(pollIntervalMs);
      } catch (e) {
        consecutiveErrors += 1;
        report(e, consecutiveErrors);
        await sleep(
          errorBackoffMs(consecutiveErrors, initialBackoff, maxBackoff),
        );
      }
    }
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
  return runPollLoop('workflow worker', options, async () => {
    const task = await service.pollWorkflowTask(options.taskQueue);
    if (!task) return false;
    let result;
    try {
      result = await worker.replayTask(
        task.name,
        task.args,
        task.history,
        task.continueAsNewSuggested,
      );
    } catch (e) {
      // Replay itself broke — a nondeterminism error, or a throw from outside the
      // workflow's own control flow. Report it instead of letting it escape to
      // the loop's catch: an unreported task is invisible to the server, which
      // learns only when the lease expires and then knows nothing about *why*.
      // Reporting is what makes the failure countable, diagnosable, and paced.
      await service.failWorkflowTask(task.token, errorMessage(e));
      return true;
    }
    await service.completeWorkflowTask(task.token, result);
    return true;
  });
}

export function runActivityWorker(
  service: WorkflowService,
  worker: ActivityWorker,
  options: WorkerLoopOptions = {},
): WorkerLoop {
  return runPollLoop('activity worker', options, async () => {
    const task = await service.pollActivityTask(options.taskQueue);
    if (!task) return false;
    // One attempt per delivery; the lease redelivers on failure/crash
    // (at-least-once), unless the attempt heartbeats to keep its claim.
    const result = await worker.runTask(task, () => {
      void service.heartbeatActivityTask(task.token).catch(() => {});
    });
    await service.completeActivityTask(task.token, result);
    return true;
  });
}
