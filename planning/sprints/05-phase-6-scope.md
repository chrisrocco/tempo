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
2. **The coherent unit of work cuts across the phase boundary.** Dead-lettering
   (Phase 6) and start-to-close timeouts (scheduled earlier, under "finishing
   distribution") are the same mechanism: the server gaining an opinion about
   attempts and about when work is beyond saving. Shipping either alone leaves the
   user-visible symptom — "this execution never finishes and nothing says why" —
   only half fixed.

So the sprint should be scoped by mechanism, not by phase membership.

## Sizing the phase

| Item                                 | Size | Risk   | Blocked on                          | Verdict            |
| ------------------------------------ | ---- | ------ | ----------------------------------- | ------------------ |
| Poison-task handling + dead-letter   | S    | low    | —                                   | **In**             |
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

**T1 — Dead-letter a poison workflow task.** Count deliveries; past a threshold,
stop redelivering and move the execution to a terminal state carrying a
diagnosable reason. Closes adoption blocker 2, the only blocker with no mitigation
at all.

**T2 — Per-execution inspection.** `tempo describe <id>` (status, history, current
parked state) and `tempo list`. This is the smaller half of the observability item
and it is a _prerequisite for T1 being usable_: a dead-letter you cannot inspect
just relocates the mystery.

**T3 — Activity start-to-close timeout.** Blocker 1, pulled forward from
"finishing distribution" because it shares T1's mechanism — server-side accounting
of an attempt and a terminal verdict on it. Doing them together is meaningfully
cheaper than doing them apart, and leaving it out means "stuck" still has an
unaddressed cause after a sprint themed on stuck executions. Full heartbeats can
stay deferred; the timeout is the part that ends the duplicate-concurrent-run
behavior.

**Stretch — structured event log.** Replace ad-hoc stderr writes with one
structured line per lifecycle event. No new dependency, and it is what the
deferred metrics work will aggregate later.

## Traps found while scoping

- **A delivery counter kept in the queue would be reset by a restart.** The queues
  are in-memory, and `resume()` re-enqueues from history — so an attempt count
  living in `LeaseTable` makes a poison task immortal across exactly the restart a
  frustrated operator will try. The counter has to be durable: either a field on
  `ExecutionRecord` or an event in history. History is more in keeping with the
  event-sourced design but grows it on every failed attempt; the record is cheaper
  and needs no protocol change. **Decide this first — everything in T1 hangs off
  it.**
- **`WorkflowTask` has nowhere to put an attempt count today.** It carries
  `{token, workflowId, name, args, history, continueAsNewSuggested}`
  ([`protocol/service.ts`](../../src/protocol/service.ts)). Adding to it is a
  change to a durable, serialized contract — ROADMAP invariant 4 applies.
- **`failed` currently conflates two things.** `ExecutionStatus` is
  `running | completed | failed`, and a dead-lettered execution is not the same as
  a workflow that threw: one is "your code raised", the other is "we gave up".
  Making them indistinguishable would defeat the point. Either a distinct status or
  a structured failure reason — again a wire-contract change.
- **Dead-lettering changes `getResult`'s contract.** It can now reject with an
  infrastructure failure rather than only a workflow failure, or hang forever. That
  is client-visible and needs saying in [`client/client.ts`](../../src/client/client.ts).
- **[Ticket 04](../tickets/04-validate-markers-against-commands.md) pairs with
  T1.** A dead-letter is only as useful as its reason, and 04 produces a
  `NondeterminismError` carrying `{seq, expected, actual}` — the single most likely
  reason a task is poison. Sequence 04 first, or accept a generic reason in T1 and
  enrich it later.
- **Inspection needs new RPCs.** `WorkflowService` exposes `getResult`/`getStatus`
  and nothing else — no history fetch, no execution list. T2 is a protocol
  addition, not just a CLI change.
- **Backpressure is genuinely blocked, not merely deprioritized.** Retry is
  worker-side today; throttling a retry storm means throttling a decision the
  server does not yet make. It has to follow server-decided retry.

## Acceptance criteria

- [ ] **T1:** a workflow whose replay always throws reaches a terminal state within
      a bounded number of deliveries instead of redelivering forever.
- [ ] **T1:** the terminal state is distinguishable from an ordinary workflow
      failure, and carries a reason naming why the task could not be applied.
- [ ] **T1:** the delivery count survives a server restart — a spec restarts the
      server mid-poison and asserts the execution still dead-letters.
- [ ] **T2:** `tempo describe <id>` prints status, history, and what the execution
      is parked on; `tempo list` enumerates executions with status.
- [ ] **T2:** a dead-lettered execution's reason is visible through `describe`.
- [ ] **T3:** an activity exceeding its start-to-close timeout is failed by the
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
