# Overview

## Where this came from

The project started as a concrete Temporal question: how to author a workflow
that monitors a bug hotlist, spawns a "bug fix" child workflow when a bug
appears, and cancels it when the bug disappears. Exploring that led to the
signal + `condition` + queue pattern, then to _how_ Temporal makes such a
workflow durable, and finally to building a small engine that demonstrates the
mechanism end to end. This documentation captures the design that resulted.

## What the engine is

A **durable workflow engine**. A _workflow_ is an ordinary async function whose
execution is made crash-proof by event sourcing: the engine never trusts the
function's in-memory state to survive: instead it records an **event history**
and can reconstruct any execution by **replaying** the function against that
history. The function must therefore be **deterministic** — the same history
always drives it to the same place.

Two roles of code run against the engine:

- **Workflow code** — deterministic orchestration. Calls primitives like
  `runActivity`, `sleep`, `condition`, `setHandler`. Never does I/O directly.
- **Activity code** — the non-deterministic work (network, disk, anything with
  side effects). Invoked _by_ the engine on the workflow's behalf.

## The mental model

1. Workflow code runs and, wherever it would do something durable (run an
   activity, start a timer, start a child), it emits a **command** and suspends.
2. The runtime executes commands against the outside world and records the
   results as **history events**.
3. To make progress, the runtime **replays** the workflow function against the
   accumulated history: recorded events resolve the promises the function is
   waiting on, fast-forwarding it to where it left off, at which point it emits
   the next command(s).
4. When history grows large, the workflow **continues as new** — a fresh run
   with empty history carrying forward only the state it needs.

Everything in this engine is an elaboration of that loop.

## What exists today

The concept docs describe the _design_. For the current build status — what's
implemented, what's deferred, and where the code has moved past these docs — see
[`PROJECT.md` §1](../../PROJECT.md), the maintained "you are here" for the
codebase. As of this writing the engine runs three ways (in-memory, durably on
disk, and distributed across processes), and the original bug-hotlist monitor
runs for real — see [getting started](../guides/getting-started.md).

## Glossary

- **Workflow** — a deterministic async function, made durable by replay.
- **Activity** — a unit of non-deterministic side-effecting work the workflow
  requests. The only place real I/O happens.
- **Command** — a request emitted by workflow code during a task
  (`scheduleActivity`, `startTimer`, `startChild`, `continueAsNew`). Carries a
  deterministic `seq`.
- **History event** — a durable record of something that happened
  (`activityCompleted`, `timerFired`, `signal`, …). History is the source of
  truth for an execution.
- **seq** — a deterministic sequence number assigned to each command in call
  order. It's how a completion event is routed back to the promise that awaits it.
- **Replay** — re-running the workflow function from the top against recorded
  history to reconstruct in-memory state that was lost or never held.
- **Activation / workflow task** — one batch of new events the runtime applies to
  advance a workflow. A signal, a timer firing, an activity completing each cause
  an activation.
- **Live edge** — the boundary between replaying recorded history and producing
  genuinely new commands. Commands before it are suppressed (already durable);
  commands after it are new work to dispatch.
- **Execution** — one running instance of a workflow, identified by a workflowId
  (and, across continue-as-new, a runId per run).
- **Determinism boundary** — the architectural line between the deterministic
  core and the non-deterministic runtime. See [the determinism
  boundary](determinism-boundary.md).
