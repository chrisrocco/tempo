# Glossary

One term per concept. This file is the tiebreaker.

Where a concept has two names in circulation, the **Term** column is the one to use and
the retired name is listed at the bottom. Where a name is doing real work that a synonym
would blur — `execution` vs `run`, `marker` vs `informational event` — the entry says what
the distinction buys, because those two pairs are the ones most often collapsed by
accident.

This is a reference, not an explanation. Each entry points at the file whose comments own
the reasoning.

## What you build and run

| Term               | Meaning                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **worker binary**  | The built, runnable file whose body is one `startWorker({…})` call. Holds the workflow functions and activity functions it can run.                                                                                        |
| **server binary**  | The built, runnable file whose body is one `startServer({…})` call. Owns the history store; runs no workflow code.                                                                                                         |
| **worker process** | A running instance of the worker binary. One binary can be run many times — see **task queue** and **role**, which are chosen per process, not per binary.                                                                 |
| **deployment**     | The whole running arrangement: one server process and one or more worker processes, with the flags they were started with.                                                                                                 |
| **consumer**       | The application that uses tempo as a library, and whose author writes the two binaries. Nobody deploys this repo; a consumer deploys their own.                                                                            |
| **scenario**       | A named state a deployment can be in — `stuck`, `parked`, `unserved-queue` — that `startScenario` creates on a real server and waits for. A fixture for whoever is building a UI against this. `src/testing/scenarios.ts`. |

`src/server_main.ts` and `src/tempo.ts` own the two-binary reasoning.

## The execution model

| Term                     | Meaning                                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **workflow**             | A deterministic async function, registered under a name, whose progress survives a crash. Never touches the outside world directly.                                                                                                                                                                       |
| **activity**             | An ordinary async function that _does_ touch the outside world. Run by a worker on a workflow's behalf, at-least-once, with server-decided retry.                                                                                                                                                         |
| **execution**            | One durable instance of a workflow, identified by a `workflowId`. This is the unit that is started, signalled, cancelled, listed and described.                                                                                                                                                           |
| **run**                  | One attempt-span of an execution between rollovers. `continueAsNew` ends a run and begins a new one **on the same execution**. `runId` is a **counter, not an address** — `runId: 5` does not mean runs 0–4 can be fetched; the previous run's history is destroyed. See `server/ports/history_store.ts`. |
| **replay**               | Re-running a workflow function against its recorded history to rebuild its in-memory state. Happens on every task, not only after a crash.                                                                                                                                                                |
| **determinism boundary** | The rule that workflow code must produce the same commands given the same history. Enforced structurally: workflow modules may import only `src/workflow.ts`. `tools/boundaries.ts`.                                                                                                                      |
| **carryover**            | Small state a workflow hands to its own next run, since a rollover destroys history. Written with `setCarryover`, visible in `describe`. Read-per-run: a write lands at the next rollover, not immediately. Capped at `MAX_CARRYOVER_BYTES`. `src/core/carryover.ts`.                                     |
| **rollover**             | What `continueAsNew` does: same execution, new run, history emptied and reseeded with the carried args. Not a close — children survive it and no parent-close policy fires.                                                                                                                               |

## History

The durable log an execution is replayed against. Four families of event, and the
differences are load-bearing — `src/protocol/history_events.ts` and
`src/core/apply_event.ts` own the reasoning.

| Term                    | Meaning                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **command**             | What workflow code asks the runtime to do during a task: run an activity, start a timer, start a child, start a workflow, signal, record a patch, continue as new. Stamped with a `seq`.                                                                                                                                            |
| **seq**                 | A deterministic number assigned to each command in call order. How a later event is routed back to the thing waiting on it. Determinism is _about_ seqs: same history, same seqs.                                                                                                                                                   |
| **completion event**    | An event that settles a command and resolves what was waiting — `activityCompleted`, `timerFired`, `childFailed`. Carries the `seq` it completes.                                                                                                                                                                                   |
| **signal event**        | An externally injected input. Has no `seq`, because nothing dispatched it.                                                                                                                                                                                                                                                          |
| **marker**              | An event that carries a `seq` and completes nothing. Records that a command was _dispatched_, which is what stops replay dispatching it twice. Every command leaves one.                                                                                                                                                            |
| **informational event** | Carries no replay meaning at all: resolves nothing, suppresses nothing, and its absence from an older history is not a divergence. Written for whoever reads the execution later. `activityStarted`, `activityRetryScheduled`, `conditionParked`, `conditionUnparked`. **Several may share one `seq`** — unlike every other family. |
| **patch**               | A recorded decision about which side of a version branch an execution took, so replay reaches the same fork. `patched()` / `deprecatePatch()`. `src/core/workflow_api.ts`.                                                                                                                                                          |
| **divergence**          | History and code disagreeing — the failure `NondeterminismError` reports.                                                                                                                                                                                                                                                           |

## Dispatch

| Term           | Meaning                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **task**       | One unit of work handed to a worker process. A **workflow task** asks it to replay an execution and return commands; an **activity task** asks it to run one activity attempt.                                                                                                               |
| **task queue** | A named **pool**, not a capability. Chosen per worker process (`--queue`, defaulting to the binary's `taskQueue` option, then `default`). Two processes of one binary on two queues is how the same code serves different traffic. It does **not** describe what a worker can run — see #88. |
| **role**       | Which task kinds a worker process serves: `workflow`, `activity`, or both. Chosen per process with `--role`, and how activity capacity is scaled independently.                                                                                                                              |
| **lease**      | A worker's temporary claim on an activity task, renewed by `heartbeat()`. Expiry is how the server notices a dead worker and redelivers. `src/server/lease.ts`.                                                                                                                              |
| **poll**       | A worker asking for its next task. The server learns a worker exists only by being polled — it never calls out.                                                                                                                                                                              |
| **attempt**    | One execution of one activity by one worker. An activity with retries has several attempts under one `seq`.                                                                                                                                                                                  |

## Schedules

`src/schedule/` — see its `index.ts`.

| Term                    | Meaning                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **schedule**            | A recurring rule, _and_ the execution that implements it. One schedule is one execution of the `scheduler` workflow, whose id is the schedule's id.                                                                              |
| **scheduler**           | The workflow that implements a schedule. Registered by a consumer into their own worker binary via `scheduleWorkflows`.                                                                                                          |
| **spec**                | When a schedule fires — currently interval-only, with boundaries aligned to the epoch.                                                                                                                                           |
| **boundary**            | An instant the spec says to fire at. Absolute, so it cannot drift.                                                                                                                                                               |
| **nominal time**        | The boundary a particular firing belongs to, as opposed to when it actually ran. The fired execution's id is built from it, which is what makes a repeated firing claim one execution.                                           |
| **target**              | What a schedule starts: a workflow name, args, and the task queue its runs go to.                                                                                                                                                |
| **run** (of a schedule) | An execution the schedule started, named `<scheduleId>-<nominalTime>`. **Not** the same sense as **run** above — that ambiguity is unfortunate and is why this row exists. Prefer "scheduled run" where both senses are in play. |
| **trigger**             | Firing on demand, ignoring the spec and ignoring pause. Not deduplicated: asking twice runs twice.                                                                                                                               |

## Layers

Directories under `src/`, each declaring what it may import in `tools/boundaries.ts`.
Grouped by functionality; a new area of behaviour gets its own layer rather than a folder
inside an existing one.

`protocol` (pure data, no dependencies) · `core` (the deterministic engine) · `patterns`
(workflow-authoring helpers over `core`) · `schedule` (fire-time arithmetic) · `server`
(owns the store, runs no user code) · `worker` (runs `core`) · `client` (handles over a
service) · `services` (composes server and worker behind one seam)

## Retired terms

Left in place where they appear in existing comments; do not reach for them in new writing.

| Instead of                           | Use                                   | Why                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| artifact                             | **worker binary** / **server binary** | "Artifact" is the generic for both and reads as jargon where the specific one is meant. Roughly thirty existing prose uses still say it; aligning them is follow-up, not a reason to keep spreading it. |
| deploy / spin up / launch (a worker) | **start a worker process**            | `launch()` is also a real function in `server_core`, so the word is ambiguous in this repo specifically.                                                                                                |
| pool / lane                          | **task queue**                        |                                                                                                                                                                                                         |
| workflow instance                    | **execution**                         |                                                                                                                                                                                                         |
| child (of a schedule)                | **scheduled run**                     | A schedule's runs are deliberately _not_ children — that is what `startWorkflow` exists for. Calling them children invites the wrong mental model of cancellation.                                      |
