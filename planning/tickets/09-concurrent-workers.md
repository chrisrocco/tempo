# 09 — A worker process runs one activity at a time

**Type:** gap (worker) · **Relates to:** ticket 02 Tier 3, which it would shrink

## Problem

The shared run-loop in [`worker_loops.ts`](../../src/worker/worker_loops.ts)
awaits each task before polling again:

    while (!stopped) {
      const didWork = await pollOnce();
      if (!didWork) await sleep(pollIntervalMs);
    }

For activities, `pollOnce` is `poll → await runTask → await completeActivityTask`.
So the next poll cannot happen until the current activity has finished and been
acked. **One activity at a time per process.** With `TEMPO_ROLE` unset both loops
run, giving one workflow task and one activity concurrently — never two
activities.

An activity is by definition the I/O and side-effect boundary: HTTP calls, DB
queries, LLM calls. That is what makes it an activity rather than workflow code.
Serializing them means a Node process sits idle awaiting one response while its
queue backs up — precisely the workload Node exists to overlap.

The [`activity_worker.ts`](../../src/worker/activity_worker.ts) fileoverview
names the motivating case itself, while explaining `heartbeatTimeoutMs`: "an
agent that may think for ten minutes". Under this loop, that process does
nothing else for ten minutes.

## Why this is a gap rather than a decision already taken

**It appears never to have been decided.** The sequential loop is stated as fact
in two comments — `isQueueServed` in
[`service.ts`](../../src/protocol/service.ts) and the
[`worker_registry.ts`](../../src/server/worker_registry.ts) fileoverview — and in
both it appears as a *limitation of something else* (why a busy worker looks
absent), never as a considered trade. Worker concurrency appears nowhere in
[`ROADMAP.md`](../../ROADMAP.md) or [sprint 01](../sprints/01-deployment-api.md).

The implicit answer today is horizontal: `tempo deploy --activity-replicas=N`,
default 2. That is a whole Node process to buy one more concurrent HTTP call.
For comparison, Temporal's default is on the order of 100 concurrent activity
task executions per worker.

## Why it is safe, which is the part that makes this worth doing

The machinery this needs is already in place, because the engine was built for
*distributed* workers and never assumed a worker runs one thing:

- **[`activity_context.ts`](../../src/worker/activity_context.ts) already uses
  `AsyncLocalStorage`**, and each `withActivityContext` call closes over its own
  throttle state. Concurrent attempts would not cross-talk; the context layer is
  concurrency-safe today.
- **Leases, task tokens, and heartbeat deadline timers are keyed per task.**
- **`appendIfVersion` is optimistic concurrency** — concurrent completions are
  the case it exists for.
- **The workflow task queue already holds a per-execution mutex**
  ([`memory_workflow_task_queue.ts`](../../src/server/memory/memory_workflow_task_queue.ts)),
  so same-execution serialization is enforced server-side rather than by the loop.

Which gives the decisive argument: **the server cannot distinguish "two
activities running in one process" from "one activity running in each of two
processes."** It already supports the second — that is what horizontal scaling
is. The run-loop is the only thing that makes them different.

Determinism is unaffected. Activities are the non-deterministic side already,
and nothing here touches workflow replay.

## Shape

A `maxConcurrentActivities` on `WorkerLoopOptions`; the loop dispatches without
awaiting while slots remain, and stops polling at zero slots — the backpressure
is the slot count, not the sleep.

## The three decisions in it

**1. What is the default?** `1` is surprising for an I/O engine, but raising it
changes memory, connection, and rate-limit behaviour for every existing
deployment on upgrade. Options: keep `1` and make concurrency opt-in; pick a
modest default; or default per context (in-process runtime stays `1`, deployed
workers get more). Whatever is chosen, `--activity-replicas` and this number now
interact, and `tempo deploy` should say which knob to reach for first.

**2. `stop()` must drain, not await one.** Today it awaits the single in-flight
iteration. With N in flight it has to wait for all of them, and decide whether a
stop still polls out the ones it has already claimed or lets their leases
expire. The second is correct-but-slow; the first is faster and has a shutdown
deadline problem.

**3. Error backoff is currently per-loop.** `consecutiveErrors` is loop state, so
one failed *poll* would back off attempts that are running perfectly well. Poll
failures and task failures stop being the same axis and need separating.

## Watch for

**Fairness across queues is not in scope and should stay out.** A worker serving
`ANY_TASK_QUEUE` with N slots could starve one queue under load. That is a real
problem and a different one; note it, do not solve it here.

**A slot held by a wedged activity is indistinguishable from a busy one** until
its lease or `startToCloseTimeoutMs` fires. That is already true with one slot;
concurrency makes it survivable rather than fatal, which is an argument for the
change rather than against it.

## Relation to ticket 02 Tier 3, and a sequencing argument

Tier 3 exists partly because the queues view cannot say whether an unserved
queue means "no worker" or "all of them busy". **A worker with spare slots keeps
polling while busy**, so this shrinks that ambiguity rather than reporting it
more precisely — and it is why Temporal's poller info works better for them than
the equivalent would for us.

It also changes what worker identity ought to report: a worker with slots is a
different thing to describe than a worker that *is* one slot. Doing this first
makes Tier 3 both smaller and better specified.

## Acceptance criteria

- [ ] An activity worker can run more than one attempt at a time, bounded.
- [ ] The default is recorded as a decision, including its effect on
      `--activity-replicas` guidance.
- [ ] `stop()` drains every in-flight attempt, and a spec proves it.
- [ ] A poll failure does not back off attempts already running.
- [ ] A spec covers concurrent attempts not cross-talking through the activity
      context — the `AsyncLocalStorage` guarantee, made executable.
- [ ] `npm run typecheck` clean; `npm test` green.