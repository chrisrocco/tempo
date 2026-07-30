# Deploy: a durable distributed server + workers

The [Quickstart](../quickstart.md) shows the distributed shape in three dev
terminals. This guide is the **operational** version: a **durable** server plus
stateless workers you can supervise, **crash, and restart** without losing state —
the shape you'd run on a VM.

**Anchored to** [`spec/integration/distributed.spec.ts`](../../../spec/integration/distributed.spec.ts)
(a real spawned server + worker processes, with worker-crash redelivery) and
[`spec/server/file_history_store.spec.ts`](../../../spec/server/file_history_store.spec.ts)
(durability round-trip + stale-lock reclaim). Everything below runs against the
same `bin/` mains those specs exercise.

## The shape

```text
                   start / signal / getResult (HTTP)
   client(s)  ───────────────────────────────────────▶ ┌───────────────────────────┐
                                                        │  server  (bin/server-main)│  stateful: history,
   workflow worker × N ── poll / respond (HTTP) ──────▶ │  HTTP RPC, DATA_DIR on disk│  queues, timers.
   activity worker × N ── poll / respond (HTTP) ──────▶ │  runs NO user code        │  the ONE stateful tier.
                                                        └───────────────────────────┘
```

The server is the only stateful tier. Workers are stateless and scale
horizontally. Local vs. distributed is just which `WorkflowService` implementation
the workers/clients use (`LocalService` vs. `RemoteService`) — not a rewrite.

## Prerequisites

- Node 18+ (uses global `fetch`); run TypeScript directly with `node --import tsx`.
- A **definitions module** exporting `registerWorkflows` / `registerActivities` —
  reuse the one from the [Quickstart](../quickstart.md#1-define-a-workflow-and-an-activity)
  (`quickstart/definitions.ts` with a `greeter` workflow + `greet` activity). The
  worker mains load it via the `WORKER_MODULE` env var. Its shape is exactly the
  spec fixture `distributed_fixture.ts` that `distributed.spec.ts` runs.

> **Windows PowerShell:** set each env var on its own line first (e.g.
> `$env:DATA_DIR = "./wf-data"`), then run the `node ...` command. The
> `VAR=value node ...` form below is bash/zsh.

## Try it: a deployment you can crash and restart

Four terminals. The only new ingredient vs. the Quickstart is `DATA_DIR` on the
server — that switches it from in-memory to a durable filesystem store and makes it
`resume()` on boot.

**Terminal 1 — the durable server.** `DATA_DIR` is where history is persisted; a
lockfile there guards against a second writer.

```bash
DATA_DIR=./wf-data PORT=7233 node --import tsx bin/server-main.ts
# → LISTENING 7233
```

**Terminals 2 & 3 — the workers** (point them at your definitions module):

```bash
SERVER_URL=http://127.0.0.1:7233 WORKER_MODULE=./quickstart/definitions.ts \
  node --import tsx bin/workflow-worker-main.ts     # → WORKFLOW_WORKER_READY

SERVER_URL=http://127.0.0.1:7233 WORKER_MODULE=./quickstart/definitions.ts \
  node --import tsx bin/activity-worker-main.ts     # → ACTIVITY_WORKER_READY
```

**Terminal 4 — a client.** Save this as `deploy/client.ts` (repo-root-relative, so
imports use `../src`). It pins a known `workflowId` so you can re-fetch it later:

```ts
// deploy/client.ts
import { createRemoteService } from '../src/services';

const service = createRemoteService(process.env.SERVER_URL ?? 'http://127.0.0.1:7233');
const id = 'demo-1';
if (process.argv.includes('--start')) {
  service.start('greeter', ['world'], { workflowId: id }); // fire-and-forget; getResult awaits it
}
console.log(await service.getResult(id));
```

Start the workflow and read its result:

```bash
node --import tsx deploy/client.ts --start
# → Hello, world!
```

### Now crash the server and bring it back

**Kill Terminal 1 hard** (Ctrl-C, or `kill -9` its PID — a real crash, no graceful
shutdown). Then **restart the exact same command**:

```bash
DATA_DIR=./wf-data PORT=7233 node --import tsx bin/server-main.ts
# → LISTENING 7233
```

It comes straight back up — the crashed process left a stale lockfile, and the new
server **reclaims it** (it checks whether the old holder pid is still alive) instead
of refusing forever. On boot it re-loads history from `./wf-data` and `resume()`s.
Re-fetch the workflow **without `--start`** — no workers needed, the state is on disk:

```bash
node --import tsx deploy/client.ts
# → Hello, world!   ← survived the crash + restart
```

That is the whole point of durable mode: kill the server, restart it, and running
executions continue from history — pending timers re-arm, un-finished activities
re-dispatch, blocked children reconnect (proved end-to-end in
[`spec/integration/resume.spec.ts`](../../../spec/integration/resume.spec.ts)).

_Clean up the demo with `rm -rf ./wf-data` once the server is stopped._

## Production shape: one VM under a supervisor

Put each tier under a process supervisor so crashes restart automatically — which is
safe now that a crashed server reclaims its own lock. Example systemd units:

```ini
# /etc/systemd/system/wf-server.service
[Service]
WorkingDirectory=/opt/workflow-engine
Environment=PORT=7233 DATA_DIR=/var/lib/wf
ExecStart=/usr/bin/node --import tsx bin/server-main.ts
Restart=always
```

```ini
# /etc/systemd/system/wf-workflow-worker@.service   (templated → run N instances)
[Service]
WorkingDirectory=/opt/workflow-engine
Environment=SERVER_URL=http://127.0.0.1:7233 WORKER_MODULE=/opt/workflow-engine/deploy/definitions.ts
ExecStart=/usr/bin/node --import tsx bin/workflow-worker-main.ts
Restart=always
```

(same pattern for `wf-activity-worker@`.) Then:

```bash
systemctl enable --now wf-server wf-workflow-worker@{1,2} wf-activity-worker@{1,2}
```

**Scale** by running more `@N` worker instances — they just poll the one server;
lease redelivery makes a crashed worker's task reappear on a live one.

## Operational notes & caveats

- **At-least-once, so make activities idempotent.** Unlike `LocalService`
  (effectively exactly-once), the distributed path redelivers a crashed worker's
  task — an activity's side effect can run more than once. Use an idempotency key.
  See [distribution](../../architecture/distribution.md).
- **Bind address.** The server binds `127.0.0.1` (loopback) — perfect for one VM
  with everything co-located. For workers on **other** machines, change the bind to
  `0.0.0.0` and keep the port on a private network.
- **No auth / no TLS** on the RPC (plain HTTP+JSON). Only expose it on loopback or a
  trusted private network; do not put the port on the public internet.
- **The server is a single point of failure and the single writer.** Scaling is
  horizontal on *workers*; server HA (failover, multi-writer) is Phase 6 and not
  built. The `DATA_DIR` lockfile enforces one server per data dir.
- **Child-id collision on restart** (`PROJECT.md` §6): the server's *child*-workflow
  id counter resets to 0 on restart, so a newly-started child could collide with a
  resumed one. Client-generated top-level ids (the default) are unaffected.
- **Runtime is `tsx`** (no build step). Fine to ship, or `tsc` to `dist/` and run
  plain `node` as a hardening step.

## See also

- [Quickstart](../quickstart.md) — the minimal dev run (in-memory, 3 terminals).
- [Distribution](../../architecture/distribution.md) — the *why* (leasing, the
  version check, at-least-once).
- [`PROJECT.md`](../../../PROJECT.md) §1 (deploy summary), §6–7 (what's next, invariants).
