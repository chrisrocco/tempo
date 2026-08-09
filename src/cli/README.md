# The CLI — design in progress

**There is no CLI right now.** It was deleted deliberately: the old surface
(`up`, `start`, `result`, `signal`, `cancel`, `list`, `describe`, `queues`) grew
one command at a time around running from a working tree, and the shape we want
is different enough that redesigning on top of it would cost more than starting
from the surface we actually want.

This file is temporary and holds the design while it firms up. It is not the
home for it — design work belongs in GitHub issues (see `AGENTS.md`) — but a
directory containing only a README is a useful marker that the code is coming
back here, and the design is easier to argue about beside where it will live.
Move it to an issue when the first command lands.

What survives the deletion: `src/client/` (the RPC client), `src/tempo.ts` (the
worker entrypoint, `Tempo.startWorker`), `bin/server-main.ts` (the server
process), and the whole engine. Only the command-line surface is gone.

---

## `tempo run <name> [args...] [--local=<target>] [--wait]`

Start a workflow. The first command, and the one that decides the shape of the
rest.

```
tempo run greeter world                     # start it, print the id, exit
tempo run greeter world --wait              # start it, block, print the result
tempo run greeter world --local=./worker.ts # whole topology in one process
tempo run greeter world --local=//my:worker # same, under a build system
```

### `--local=<target>`

Runs the workflow against a **fresh in-memory runtime in one process**. No
server, no port, no persistence, nothing left behind. Implies `--wait`, because
there is nothing to come back to — the runtime dies with the process.

`<target>` is the worker, and this is the one place the CLI genuinely needs to
know what to build:

- **Source:** a `.ts` entrypoint that calls `Tempo.startWorker`.
- **Build system:** a label. The CLI runs `blaze run <target> -- <flags>`, and
  the built binary is a worker entrypoint like any other.

`Tempo.startWorker` sees the local flag and reaches for the in-memory runtime,
ignoring `TEMPO_SERVER_URL`, port, and data-dir entirely.

### `--wait`

Blocks until the workflow settles and prints its result. Without it, the
workflow id is printed and the process exits — the workflow keeps running on the
server. Redundant with `--local`, which always waits.

### Without `--local`: the server path

The workflow runs against a real server. If no server is reachable, the CLI
builds and deploys one, and the worker with it:

- **Source:** run them from the working tree.
- **Build system:** build the binaries, copy them out of the output tree
  (dereferenced — see below), install them under `/opt/tempo`, and write systemd
  units.

---

## Open questions

These are the parts that are not settled. Ordered by how much damage getting
them wrong does.

### 1. Which worker serves `<name>`?

`--local` names its target. **The server path names nothing.** So when
`tempo run greeter` finds no server and decides to deploy, it has no idea what
to build.

Options, none chosen:

- A `--worker=<target>` flag, mirroring `--local`. Explicit, and tedious to type
  on every run.
- A project file naming the workers. Convenient, and the thing the old
  `--describe` handshake existed to avoid — deployment config that can drift
  from the artifact.
- Discovery: deploy nothing, fail with "no worker serves `greeter`", and make
  deployment a separate explicit command.

The third makes `run` a much smaller command, and is worth considering on those
grounds alone. See question 2.

### 2. Should `run` deploy at all?

As designed, a first `tempo run` on a fresh machine builds two binaries, writes
them under `/opt/tempo`, installs two systemd units, and starts them — from a
verb that reads like "execute this workflow".

Against it: it needs root, it is a lot of hidden behaviour, and the failure
surface is now build failures, copy failures, unit failures, and a server that
started but is unhealthy — all arriving from a command the user thinks is one
RPC. It is also hard to make honest about _state_: "is the server running" is
easy, "is the running server the one this code expects" is question 3.

For it: it is a genuine ergonomic win, and the alternative is a setup step
people have to be told about.

A middle option: `run` refuses and prints the exact command to fix it, and
`tempo up` (or `deploy`) owns provisioning. One command that does one thing,
with a signpost instead of a surprise.

**Whatever is chosen, if `run` does deploy it needs: a lock** (two concurrent
`tempo run`s must not race the same install) **and visible progress** (a build
that takes ninety seconds must not look like a hang).

### 3. Version skew, which is the one that will actually bite

"Check if the server is running" is not enough. A server _is_ running — built
from last week's code. The worker beside it registers workflows that have since
changed shape.

That is not a deployment inconvenience, it is the nondeterminism class this
engine is most vulnerable to: a worker replaying a history written by different
code. Issue #39 is what that looks like from the inside, and it is not obvious
from the outside.

So the deploy subroutine needs an identity to compare, not a liveness check. A
build system hands one over for free — Blaze can give a fingerprint of the
built artifact — and the source path can hash the entrypoint and its imports, or
simply always redeploy, which is cheap when there is nothing to build.

The server should report its own fingerprint; `run` compares and redeploys on
mismatch.

### 4. How does the local flag reach `startWorker`?

**Argv, not an environment variable**, and there is a precedent in
`src/tempo.ts` worth following: a flag has to be typed at the launch site and
does not propagate to children, which is exactly the property a mode switch
wants. `TEMPO_LOCAL=1` exported in a shell — or inherited by a worker spawned
from a test — turns a production worker into one that serves nobody while still
looking healthy.

So: `blaze run //my:worker -- --local --run=greeter --arg=world`, and
`startWorker` parses its own argv.

### 5. Getting the result back out of `--local`

In local mode the workflow runs _inside the worker process_, so the result has
to come back over stdout — competing with the user's own logging, and under
Blaze with the build system's chatter.

It needs a channel that cannot collide: a single `TEMPO_RESULT <json>` line, or
a file path passed in for the worker to write and the CLI to read. The second is
uglier and cannot be corrupted by a stray `console.log`.

### 6. Argument parsing

`tempo run <name> [args...]` with flags after the positionals is ambiguous the
moment a workflow argument starts with `-`. Take `--` as the separator:

```
tempo run myWorkflow --wait -- --this-is-an-argument
```

Everything before `--` belongs to the CLI, everything after to the workflow.

### 7. `--local --no-wait`

Should be an error rather than silently ignored. There is no id worth printing
and no runtime left to ask.

---

## The Blaze specifics worth writing down now

**Copy dereferenced.** `blaze-bin/` is a symlink farm into the output base.
Copying it naively installs links that dangle the next time someone runs a build
with different flags — a deployment that breaks with no deploy having happened.
Copy with `--dereference` so what lands under `/opt/tempo` is a real file.

**Install atomically.** Write the new binary to a temporary path on the same
filesystem and `rename(2)` it into place. A half-copied binary that systemd
restarts into is worse than an old one.

**`blaze run` is not the process you supervise.** It builds, then execs the
binary as a child. A `SIGTERM` to the `blaze` process may not reach the binary.
For a supervised long-running process, resolve the built path and spawn _that_;
`blaze run` is fine for one-shot `--local`.

**Quiet the build output** (`--ui_event_filters=-info,-stdout`) so readiness
lines and results are not buried.

### Suggested install layout

```
/opt/tempo/
  bin/tempo-server              # engine server, dereferenced copy
  workers/<name>/worker         # worker binary, replaced by atomic rename
  workers/<name>/VERSION        # build fingerprint — see question 3
/var/lib/tempo/                 # history, owned by the tempo user
/etc/tempo/<name>.env           # per-worker config: env, never code
/etc/systemd/system/tempo-server.service
/etc/systemd/system/tempo-worker@.service
```

`tempo-worker@.service` is a **template unit**, so one file serves every worker:
`systemctl start tempo-worker@greeter`. The existing role split (a worker
process serves workflow tasks, activity tasks, or both, via `TEMPO_ROLE`) maps
onto instances — `tempo-worker@greeter:activity` — which is also how replica
counts get expressed without a second unit file per worker.

`/var/lib/tempo` rather than a directory under `/opt`: `/opt` is for the
software, `/var/lib` is for state it accumulates, and separating them is what
makes "reinstall the binary, keep the history" a non-event.

---

## What this does not cover yet

`signal`, `cancel`, `terminate`, `list`, `describe`, `queues` — the read and
drive commands. They were all built and all deleted with the rest; none of them
were the reason for the redesign, and they should come back close to as they
were once `run` has settled how targets, deployment, and waiting work.
