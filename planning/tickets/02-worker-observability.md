# 02 — Workers are invisible: no health signal, and poll failures are silent

**Type:** gap (protocol + operability) · **Blocks:** `tempo status` in
[`planning/sprints/01-deployment-api.md`](../sprints/01-deployment-api.md)

## Problem

Three compounding gaps mean a broken worker looks healthy.

**1. The server has no concept of a worker.** Workers poll anonymously — there is
no registration, no heartbeat, no worker identity anywhere in the protocol. The
server cannot report "4 activity workers connected" because it does not know
workers exist.

**2. There is no health or stats RPC.**
[`src/protocol/rpc.ts:23`](../../src/protocol/rpc.ts:23) has eight methods, all
work-carrying: `start`, `signal`, `cancel`, `getOutcome`, and the four
poll/complete pairs. Nothing asks the server about itself. The only available
liveness probe is calling `getOutcome` on a nonexistent id and relying on
[`server_host.ts:118`](../../src/services/server_host.ts:118) returning
`{status: 'running'}` for unknown ids — an accident of the polling contract, not
a health check.

**3. The poll loops swallow every error and hot-retry.**
[`src/worker/worker_loops.ts:52`](../../src/worker/worker_loops.ts:52) and
[`:83`](../../src/worker/worker_loops.ts:83):

```ts
} catch {
  await sleep(pollIntervalMs); // transient (server restart / network) — retry
}
```

`pollIntervalMs` defaults to **5ms**, and the error path reuses it with no
backoff. A worker pointed at a dead or wrong server retries roughly 200×/second,
forever, printing nothing.

## Impact

A worker with a misconfigured `TEMPO_SERVER_URL`:

- systemd reports `ActiveState=active`
- `tempo status` reports green (it has nothing better to read)
- zero work is performed
- no log line anywhere says why
- the process busy-loops against a dead endpoint

This is the worst failure shape available: silent, invisible, and expensive.

## Proposed work, in tiers

Each tier stands alone and ships value; take them in order.

**Tier 1 — make failure visible (no protocol change). ✅ Done.** Poll failures are
reported to stderr and the error path backs off exponentially (50ms doubling to a
5s ceiling) instead of reusing the 5ms idle interval; the reporter repeats on a
doubling schedule so a persistent outage stays visible without flooding. A worker
pointed at a closed port now logs:

```text
workflow worker: poll failed (1x): fetch failed
activity worker: poll failed (1x): fetch failed
workflow worker: poll failed (2x): fetch failed
...
```

Roughly 8 attempts in 12s, where it previously managed ~2,400 silently.

**Tier 2 — a real server health probe.** Add a `health` method to `RpcRequest`
returning server liveness plus whatever is already cheap to read (uptime, durable
vs. in-memory, data dir). Lets `tempo status` report the server honestly instead
of abusing `getOutcome`.

> **Tier 2 landed.** `{method: 'health'}` on the RPC surface, `ServerHost.health()`,
> and `RemoteService.health()` returning
> [`ServerHealth`](../../src/protocol/service.ts) — `uptimeMs`, `durable`, and an
> optional `dataLocation`.
>
> Three decisions taken while implementing:
>
> - **`durable` is read off the `HistoryStore`, not passed in.** The port gained
>   `durable` and `location`, so each adapter answers for itself. The
>   alternative — `bin/server-main` telling the host what it configured — is a
>   second source of truth that can disagree with the store actually in use, and
>   a probe reporting durability it does not have is worse than one reporting
>   nothing.
> - **No `ok` field.** Liveness is carried by the reply arriving; a boolean that
>   is `true` in every receivable response invites branching on nothing. A spec
>   pins the key set so one cannot be added back casually.
> - **`health()` is synchronous on the host, and nothing on `ServerHealth` may
>   require a store scan.** A probe that walks every execution falls over on
>   exactly the server that most needs probing. Execution counts stay
>   `groupExecutions`' job.
>
> **`health` has no caller in the repo yet** — `tempo status` does not exist, and
> `assertReachable` in [`cli/client.ts`](../../src/cli/client.ts) was left alone
> on purpose: it is deliberately body-agnostic, and switching it to `health`
> would make an older server that does not know the method report as
> unreachable. T3 is the tier that gives `tempo status` something to say about
> workers.

**Tier 3 — worker identity and heartbeat.** Give workers an identity (name, role,
pid) that rides along with polls or a dedicated register call; have the server
track last-seen per worker. This is what `tempo status` needs to report connected
worker counts and staleness, and the foundation for queue depth / lease age
stats. Largest change: touches `protocol`, `server_host`, and `worker_loops`.

> **Tier 3 landed — identity on the poll, joined to the lease table.** Polls
> carry an `identity` (`${pid}@${hostname}` by default, the convention Temporal
> uses); `worker_registry` keeps a row per worker per role; `WorkerInfo` carries
> it on `QueueWorkers`, and `workersServing` sits beside `isQueueServed` so the
> CLI and dashboard cannot drift.
>
> **The choice the ticket left open was "rides along with polls _or_ a dedicated
> register call", and the answer is that identity-on-poll alone would not have
> fixed what T3 was raised for.** The motivating complaint is that a quiet queue
> could mean "no worker" or "all of them busy". Adding identity gives the names
> of the workers you cannot account for without saying why — a busy worker still
> stops polling, and our activity loop is sequential, so one 60-second activity
> makes a worker invisible. Temporal has the same ambiguity from poller info
> alone, and answered it years later with a separate 60-second worker heartbeat
> (`temporal worker list`).
>
> A heartbeat was not needed here, because the missing evidence already existed:
> `LeaseTable` backs both task queues, so the server always knew which tasks
> were claimed — it just did not know by whom. Recording the holder closes it.
> Silent **and** holding a live lease is busy; silent and holding nothing is
> gone. One field on the poll, one on the lease.
>
> Three decisions:
>
> - **`busy` is decided in `server_core`, not the registry.** The registry
>   watches polls, the lease tables watch claims, and neither should learn about
>   the other. `listQueues` is the only thing holding both.
> - **A process running both loops is two rows.** They poll and fail
>   independently; a wedged activity loop beside a healthy workflow loop is a
>   real state a merged row would hide.
> - **`isQueueServed` counts a busy worker as serving.** The recency test stays
>   for the idle case, which is the common one. `holders()` filters by deadline
>   rather than trusting the table, because expired leases are only swept on the
>   next poll — on an idle queue a dead worker's lease would otherwise vouch for
>   it forever.
>
> **Not done:** no capacity or saturation reporting, which is the other half of
> Temporal's heartbeat. The activity loop is strictly sequential, so "available
> task slots" is always 1 or 0 and would say nothing that `busy` does not. And a
> worker that crashes _before its first poll_ is still invisible — there is no
> registration, so that stays `tempo status` reading process state, which is the
> deployment API's job.

## Acceptance criteria

- [x] **T1:** a worker that cannot reach its server logs a distinguishable error
      and backs off; verified by pointing one at a closed port.
- [x] **T1:** error-path backoff is exponential and capped; idle polling cadence
      is unchanged.
- [x] **T2:** `health` exists on the RPC surface and `RemoteService` exposes it.
- [x] **T3:** the server can enumerate live workers by role with a last-seen
      timestamp.
- [ ] `npm run typecheck` clean; `npm test` green.

## Note for the deployment API

`tempo status` can now report **systemd process state** per replica, a real
`health` probe of the server (T2 — uptime, durable vs. in-memory, data dir), and
connected worker counts with staleness and whether each is mid-task (T3). What
it still cannot report is a worker that never polled at all: nothing registers,
so a process that crashes on boot is indistinguishable from one that was never
deployed. That gap is process state, not protocol, and belongs to the deployment
API rather than to this ticket.
