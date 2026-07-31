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

**Tier 3 — worker identity and heartbeat.** Give workers an identity (name, role,
pid) that rides along with polls or a dedicated register call; have the server
track last-seen per worker. This is what `tempo status` needs to report connected
worker counts and staleness, and the foundation for queue depth / lease age
stats. Largest change: touches `protocol`, `server_host`, and `worker_loops`.

## Acceptance criteria

- [x] **T1:** a worker that cannot reach its server logs a distinguishable error
      and backs off; verified by pointing one at a closed port.
- [x] **T1:** error-path backoff is exponential and capped; idle polling cadence
      is unchanged.
- [ ] **T2:** `health` exists on the RPC surface and `RemoteService` exposes it.
- [ ] **T3:** the server can enumerate live workers by role with a last-seen
      timestamp.
- [ ] `npm run typecheck` clean; `npm test` green.

## Note for the deployment API

Until Tier 3 lands, `tempo status` can only report **systemd process state** per
replica plus a server ping — not whether workers are actually working. The
[build-and-deploy guide](../../docs/guides/build-and-deploy.md) should not promise
more than that.
