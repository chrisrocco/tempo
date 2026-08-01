# 05 — Scoping Phase 6

**Type:** scoping · **Input:** [`ROADMAP.md`](../../ROADMAP.md) Phase 6 and the
adoption-blocker ranking

## Objective

Decide how much of Phase 6 is one sprint. Short answer: **about a fifth of it**,
and the useful sprint boundary is not the phase boundary.

## The finding

Phase 6 is written as one list — "poison-task handling and dead-lettering;
retry-storm backpressure; observability; server HA and failover; auth and TLS;
load and soak tests" — but those items differ by an order of magnitude in size and
have a dependency order the list hides. Two things fall out of sizing them:

1. **Server HA is not a sprint item; it is a phase, and its first step is the last
   item in the list.** Everything else in Phase 6 is small by comparison.
2. **The coherent unit of work cuts across the phase boundary.** Poison-task
   handling (Phase 6) and start-to-close timeouts (scheduled earlier, under
   "finishing distribution") are the same mechanism: the server keeping a durable
   account of attempts. Shipping either alone leaves the user-visible symptom —
   "this execution never finishes and nothing says why" — only half fixed.

So the sprint should be scoped by mechanism, not by phase membership.

## Sizing the phase

| Item                                 | Size | Risk   | Blocked on                          | Verdict            |
| ------------------------------------ | ---- | ------ | ----------------------------------- | ------------------ |
| Poison-task handling + terminate     | S    | low    | —                                   | **In**             |
| Per-execution history inspection     | S    | low    | protocol addition                   | **In**             |
| Activity start-to-close timeout      | M    | low    | —                                   | **In** (see below) |
| Structured server/worker event log   | S    | low    | —                                   | Stretch            |
| Metrics + tracing                    | M    | medium | a sink decision (Prometheus? OTel?) | Out                |
| Retry-storm backpressure             | M    | medium | server-decided retry, not yet built | Out                |
| Auth + TLS on the RPC                | M    | low    | a deployment decision (see below)   | Out                |
| History store beyond one workstation | L    | high   | store interface review              | Out                |
| Server HA + failover                 | XL   | high   | durable queues + shared store       | Out                |
| Load + soak tests                    | M    | low    | metrics, to have anything to read   | Out                |

## Why HA is out, with evidence

HA reads like "run a second server," and the code says otherwise:

- **The queues are in-memory unconditionally.** `createServerHost` hardcodes
  `MemoryWorkflowTaskQueue`, `MemoryTaskQueue`, and `MemoryTimerService`
  ([`server_host.ts`](../../src/services/server_host.ts)); only the _history store_
  is swappable. Durability today comes from `resume()` rebuilding pending work by
  replaying history, not from anything the queues persist.
- **The correlation maps are process-local.** `childrenByParent` and
  `parentOfChild` live in `server_core`'s closure and are rebuilt only by
  `resumeFromHistory` ([`server_core.ts`](../../src/server/server_core.ts)). Two
  live servers would each hold half the truth.
- **The store forbids a second writer by design.** `FileHistoryStore` takes a
  single-writer lockfile on the data dir
  ([`file_history_store.ts`](../../src/server/file/file_history_store.ts)).

So HA is: a shared transactional store, durable shared queues, and leader election
for the timer sweep — three substitutions behind existing ports, which is the
project's stated strategy, but three, not one. Note the ordering consequence: **the
"history store beyond one workstation" item is a prerequisite for HA, not a
sibling of it.** The phase list has them in the wrong order.

Nothing here is urgent while the deployment target is a workstation
([sprint 01](01-deployment-api.md)).

## Why auth + TLS is out

It is small and self-contained, but it is a _deployment_ decision, not an
engineering one: it buys nothing while everything runs on one host behind a
loopback bind, and it is mandatory the moment the bind widens. Deferring is only
correct if the loopback constraint stays documented and enforced — it currently is
([`bin/server-main.ts`](../../bin/server-main.ts)). Revisit when a worker needs to
live on another machine, and treat that as the trigger rather than a schedule.

## Recommended sprint

**Theme: a stuck execution becomes impossible to miss, and possible to end.**

Today an execution can stop making progress for two unrelated reasons, and both
present identically as silence — `getResult` never returns, and the only trace is
backoff noise on stderr.

**T1 — Make a poison workflow task loud, bounded, and escapable.** _Policy
decided; see "The dead-letter question, settled" below._ The server learns that a
task failed, counts attempts durably, re-enqueues with backoff, and reports the
reason through `describe` — but never terminates the execution on its own. An
operator ends it explicitly with `terminate`. Closes adoption blocker 2, the only
blocker with no mitigation at all.

Three pieces, in dependency order:

1. **The worker must report the failure.** Today a replay that throws escapes
   `runPollLoop`, which logs to stderr and never calls `completeWorkflowTask` — so
   the task is never acked and the server never learns anything happened. It finds
   out only when the lease expires. A `failWorkflowTask(token, reason)` on the
   worker-facing seam is the prerequisite for everything else here.
2. **The server counts and backs off.** Attempts on the record, backoff on
   re-enqueue, the reason retained for inspection.
3. **`tempo terminate <id>`**, non-cooperative — see the trap below on why
   `cancel` cannot serve this.

**T2 — Per-execution inspection.** `tempo describe <id>` (status, history, current
parked state) and `tempo list`. This is the smaller half of the observability item
and it is a _prerequisite for T1 being usable_: under retry-forever, inspection is
the entire mitigation — a stuck execution nobody can examine is just a mystery
that now also never ends.

**T3 — Activity start-to-close timeout.** Blocker 1, pulled forward from
"finishing distribution" because it shares T1's mechanism — server-side accounting
of attempts, and a verdict on one that has run too long. Note the asymmetry the
policy introduces: an over-running _activity attempt_ is failed (its retry policy
then applies), while a failing _workflow task_ is only retried. Activities are
I/O the server dispatched and can safely give up on; workflow tasks are the
execution itself. Doing them together is meaningfully
cheaper than doing them apart, and leaving it out means "stuck" still has an
unaddressed cause after a sprint themed on stuck executions. Full heartbeats can
stay deferred; the timeout is the part that ends the duplicate-concurrent-run
behavior.

**Stretch — structured event log.** Replace ad-hoc stderr writes with one
structured line per lifecycle event. No new dependency, and it is what the
deferred metrics work will aggregate later.

## The dead-letter question, settled

The original plan was to settle a poison execution past a threshold. **We are
not doing that.** Temporal's design is the model: a failing workflow task retries
indefinitely with backoff, the execution stays open, and the failure is made
impossible to miss rather than fatal.

The reasoning that decided it: a workflow-task failure is almost always a _code_
bug, and workflow code is redeployable. Fix the bug, roll the workflow workers,
and the execution replays past the point that was throwing and carries on —
**work that auto-termination would have destroyed**. The failure is loud and
recoverable, which is a strictly better place to be than terminal and
diagnosable. That trade only holds if the loudness is real, which is what makes
the attempt count, the retained reason, and `describe` load-bearing rather than
nice-to-have.

Two consequences fall out and are now part of T1:

- **An explicit terminate is mandatory**, not optional. Retrying forever with no
  way out is worse than the bug.
- **Per-attempt history events are out.** Temporal keeps attempt counts in mutable
  state and treats retries as transient precisely to avoid history bloat, and the
  same argument applies here with extra force (see the trap below). The counter
  goes on `ExecutionRecord`; history records the _first_ failure so the log shows
  something went wrong, not one event per attempt.

## Traps found while scoping

- **`cancel` cannot unstick a poison execution — `terminate` is a different
  mechanism.** Cancellation is cooperative and delivered _through replay_:
  `requestCancel` appends `cancelRequested`, and the workflow unwinds when it next
  replays. If replay is what throws, the cancel is never applied. Terminate must
  settle the execution server-side without replaying it, which makes it the one
  client operation that deliberately bypasses the workflow function.
- **A delivery counter kept in the queue would be reset by a restart.** The queues
  are in-memory, and `resume()` re-enqueues from history — so an attempt count
  living in `LeaseTable` makes a poison task immortal across exactly the restart a
  frustrated operator will try. **Decided:** the counter is a field on
  `ExecutionRecord` (durable, not replayed, no wire-format change), following
  Temporal's mutable-state precedent.
- **Per-attempt events would poison the continue-as-new heuristic.** Beyond
  history bloat: `continueAsNewSuggested` fires on history _length_, so a task
  failing in a loop would push its own execution toward continue-as-new while
  making no progress. A second reason the counter does not belong in history.
- **`WorkflowTask` has nowhere to put an attempt count today.** It carries
  `{token, workflowId, name, args, history, continueAsNewSuggested}`
  ([`protocol/service.ts`](../../src/protocol/service.ts)). Adding to it is a
  change to a durable, serialized contract — ROADMAP invariant 4 applies.
- **`failed` will conflate two things once terminate exists.** `ExecutionStatus`
  is `running | completed | failed`, and an operator-terminated execution is not a
  workflow that threw: one is "we pulled the plug", the other is "your code
  raised". Folding them together loses the distinction exactly where a postmortem
  needs it. Either a distinct status or a structured reason — a wire-contract
  change either way, so ROADMAP invariant 4 applies.
- **`getResult` never returns for a wedged execution, and that is now permanent.**
  Under retry-forever it hangs until someone terminates, at which point it rejects.
  A caller with no timeout waits indefinitely by design — say so in
  [`client/client.ts`](../../src/client/client.ts) rather than leaving people to
  discover it.
- **[Ticket 04](../tickets/04-validate-markers-against-commands.md) pairs with
  T1.** The whole policy rests on the reported reason being good enough to act on,
  and 04 produces a `NondeterminismError` carrying `{seq, expected, actual}` — the
  single most likely reason a task is poison. Sequence 04 first, or accept a
  generic reason in T1 and enrich it later.
- ~~**Inspection needs new RPCs.**~~ Landed with T2: `describeExecution` /
  `listExecutions` are on the seam, and `describe` already has the section T1's
  attempt count and last failure belong in.
- **Backpressure is genuinely blocked, not merely deprioritized.** Retry is
  worker-side today; throttling a retry storm means throttling a decision the
  server does not yet make. It has to follow server-decided retry.

## Acceptance criteria

- [x] **T1:** a workflow whose replay throws has that failure _reported to the
      server_ rather than dropped on the floor — the worker calls
      `failWorkflowTask`, and the task is not left to expire silently.
- [x] **T1:** the execution stays `running` and keeps retrying. It is **not**
      auto-terminated, and a spec asserts that: this is the policy, and a future
      change that "helpfully" settles it should fail the suite.
- [x] **T1:** redelivery of a repeatedly failing task backs off rather than
      spinning at the lease interval.
- [x] **T1:** `describe` shows the attempt count and the last failure reason.
- [x] **T1:** the attempt count survives a server restart — a spec restarts the
      server mid-poison and asserts the count did not reset to zero.
- [x] **T1:** deploying a corrected workflow lets a wedged execution complete. This
      is the whole justification for the policy, so it is a spec, not a hope:
      replay against a registry that throws, then swap in one that does not, and
      assert the execution finishes.
- [x] **T1:** `tempo terminate <id>` settles a wedged execution _without_ replaying
      it, and a spec covers the case `cancel` cannot reach.
- [x] **T2:** `tempo describe <id>` prints status, history, and what the execution
      is parked on; `tempo list` enumerates executions with status.
- [x] **T3:** an activity exceeding its start-to-close timeout is failed by the
      server rather than left to duplicate on lease expiry; a spec asserts one
      run, not two.
- [ ] `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check` clean.

## Deferred, with the condition that unblocks each

| Deferred          | Unblocked by                                                |
| ----------------- | ----------------------------------------------------------- |
| Metrics + tracing | Choosing a sink; the structured event log gives it a source |
| Backpressure      | Server-decided retry landing                                |
| Auth + TLS        | The first non-loopback bind — a trigger, not a date         |
| Shared store      | A decision to pursue HA at all                              |
| Server HA         | Shared store + durable queues + timer leader election       |
| Load + soak       | Metrics, so a run produces a readable result                |

## Note

If the sprint has to shrink, ship **T1 + T2** and drop T3: the pair is coherent on
its own (a failure becomes terminal, and you can see it), while T3 alone leaves the
blocker with no mitigation still open. If it has to shrink further, the honest move
is to ship T2 first — inspection is what makes every other decision in this list
observable, and it is the only item here with no design questions attached.
