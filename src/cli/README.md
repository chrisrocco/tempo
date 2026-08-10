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

## The shape

Five commands to start, and **the four deployment-facing ones know nothing about
a build system**.

| Command           | Does                                                     |
| ----------------- | -------------------------------------------------------- |
| `tempo up`        | Copies artifacts in, installs supervised units, starts.  |
| `tempo down`      | Stops and disables those units. Touches no data.         |
| `tempo run`       | Starts a workflow against a server. An RPC client.       |
| `tempo result`    | Fetches the outcome of an execution that already exists. |
| `tempo run-local` | Runs one workflow from source, in this process.          |

`result` is not optional: `run` without `--wait` prints an id and exits, so
without `result` the id it printed leads nowhere.

The build-system property is worth stating as a goal rather than noting as an
accident, because two earlier drafts lost it. `run` was going to deploy on
demand, which put building binaries and installing systemd units behind a verb
meaning "execute this workflow". Then `up` was going to take build _targets_ and
resolve them through a toolchain. Both are gone: `up` copies files and `run`
makes RPCs.

`run-local` is the deliberate exception and the reason the property is stated per
command rather than for the CLI as a whole — running from source with nothing
built is _defined_ by knowing how to get from source to a running workflow. See
[run-local](#tempo-run-local--its-own-command-not-a-flag-on-run) for why that is
a smaller concession than it looks.

The read and drive commands come back after these five — see
[what this does not cover yet](#what-this-does-not-cover-yet).

---

## Configuration is flags and defaults, never the environment

**Every input to every process is a command-line flag with a default.** No
`/etc/tempo/env`, no `TEMPO_*` variables, no config file.

The port is **7777**.

Two reasons. The first: **an environment variable is inherited, and a flag is
not.** One stale `TEMPO_SERVER_URL` exported in a shell — or inherited by a
worker spawned from a test — points a production worker at the wrong server
while it still prints `WORKER_READY` and looks healthy to its supervisor. A flag
has to be typed at the launch site, which is the property that matters for
anything a deployment gets wrong silently.

The second is what makes this a _simplification_ rather than a relocation: `up`
writes the units, so **the unit file is the deployment's configuration** —
visible in `systemctl cat tempo-server`, diffable, and written in one place by
one command. An env file shared by server and workers had two sources of truth
for the port (`PORT` for the server, a URL containing it for the workers) that
an operator kept in step by hand.

It also removes two defaults that made a _successful_ deploy silently broken:

- `bin/server-main.ts` defaults `PORT` to **0** — a random port — while workers
  default to `7233`. With no env file, `up` would have started a server nothing
  could find, with both units reading healthy.
- `DATA_DIR` unset means in-memory. History would silently not persist,
  `/var/lib/tempo` would stay empty, and everything would look fine until the
  first restart.

Under flags-with-defaults, `up` passes `--port=7777` and
`--data-dir=/var/lib/tempo` explicitly, and the failure mode is gone rather than
documented.

**What this costs, recorded so it can be reopened knowingly:** a container
orchestrator configures processes through the environment, so a Kubernetes
deployment of these artifacts has to build an argv rather than set variables.
That is a real cost and the reason someone might come back here — but it is a
cost paid by a deployment shape this repo does not have yet, and the failure
above was being paid by the one it does.

This changes three files that currently read the environment: `bin/server-main.ts`
(`HOST`, `PORT`, `DATA_DIR`, `ACTIVITY_LEASE_MS`), `src/tempo.ts`
(`TEMPO_SERVER_URL`, `TEMPO_TASK_QUEUE`, `TEMPO_ROLE`), and
`spec/integration/distributed.spec.ts`, which spawns both through env today. The
fileoverviews in the first two argue for the environment overrides at some
length; they change in the same commit.

---

## `tempo up --server=<path> --worker=<path>`

Copy both artifacts into place, write systemd units, start everything, exit.
Re-running it is how you deploy a new version.

```
blaze build //my:worker //third_party/tempo:server
tempo up --server=blaze-bin/third_party/tempo/server.js \
         --worker=blaze-bin/my/worker.js
```

**Both flags take a path to a final `.js` file.** The caller builds; `up`
copies. That is the whole contract, and it is what keeps the build system out of
the CLI: with Blaze the above is two ordinary lines and no adapter anywhere.

Everything else has a default and can be overridden:

```
--port=7777                  what the server binds, and what workers dial
--host=127.0.0.1             the interface the server binds
--data-dir=/var/lib/tempo    the server's durable history
--queue=default              the pool the workers serve
--node=<path>                which node the units run
```

### Three services, because the worker roles are separate processes

One server unit and **two worker units from the one artifact**:

```
tempo-server.service            node /opt/tempo/server.js --port=7777 …
tempo-worker-workflow.service   node /opt/tempo/worker.js --role=workflow …
tempo-worker-activity.service   node /opt/tempo/worker.js --role=activity …
```

The split is the deployed shape and always was — `src/tempo.ts` says why, and
`spec/integration/distributed.spec.ts:125` already proves it end to end. An
activity is the only place I/O happens, so an activity blocking the event loop
in a process that also replays workflows stalls replay into a lease expiry. The
two tiers also scale independently against one server, which is the other half
of why they are separate.

A single both-roles process is the _dev_ shape — a hand-run binary with no
`--role` serves every role it has definitions for — and it must not be what a
deployment gets by accident.

**One worker artifact to start with**, hence one `--worker` and a flat layout.
Supporting several means a name per worker and a directory per name; nothing
here forecloses it, and the role split above is already a rehearsal for the
naming.

```
/opt/tempo/
  server.js          # the engine server
  worker.js          # the one worker artifact, run twice
  VERSION            # fingerprints of both — see question 2
/var/lib/tempo/      # history, owned by the tempo user
/etc/systemd/system/tempo-server.service
/etc/systemd/system/tempo-worker-workflow.service
/etc/systemd/system/tempo-worker-activity.service
```

`/var/lib` rather than a directory under `/opt`: `/opt` is the software,
`/var/lib` is the state it accumulates, and separating them is what makes
"replace the artifact, keep the history" a non-event.

Neither artifact is self-contained — they are JavaScript, so the units run
`node /opt/tempo/server.js`. Which `node` is a question the units answer
explicitly rather than inherit from whoever ran `tempo up`.

### The two properties the units have to deliver

**1. Everything is running at all times** — across crashes, restarts, and
reboots.

- `Restart=always` with a short `RestartSec`, so a crash comes back.
- `WantedBy=multi-user.target` plus `systemctl enable`, so a reboot comes back.
  Without `enable`, a host reboot silently drops the entire deployment while
  every `systemctl status` was green the day before.
- `StartLimitIntervalSec=0`, so systemd never gives up. The default rate limit
  stops a unit after five restarts in ten seconds and leaves it `failed`, which
  turns "always running" into "gave up during the incident". The cost is that a
  genuinely misconfigured worker crash-loops forever instead of parking; both
  are visible in `systemctl status`, and only one of them recovers on its own
  once the cause is fixed.
- Workers get `After=tempo-server.service`, which orders a boot but is not a
  guarantee — a worker that starts before the server is listening backs off and
  retries, which is already how `worker/worker_loops.ts` behaves.

**2. Re-running `up` actually redeploys** — the running processes serve the new
files.

- `systemctl daemon-reload` after writing the units. Without it, a re-run whose
  unit contents changed is a no-op that looks exactly like a deploy.
- `systemctl restart` on all three, server first. Nothing rereads a `.js` file
  in place, so the restart _is_ the deployment.
- In-flight activity attempts die with the restart. That is acceptable —
  activities are at-least-once and expected to be idempotent — but it is a real
  consequence and not a silent one.

### Mechanical hazards, all three of the kind that work in testing

- **Copy dereferenced.** `blaze-bin/` is a symlink farm into the output base, so
  a naive copy installs links that dangle the next time someone builds with
  different flags — a deployment that breaks with no deploy having happened.
- **Install atomically.** Copy to a temporary path on the same filesystem,
  `rename(2)` into place, then restart. A half-copied artifact that systemd
  restarts into is worse than an old one.
- **Check for root up front.** `up` writes `/opt` and `/etc/systemd/system`. A
  permission error discovered halfway through is a partial deploy; a refusal
  before the first write is not.

### First-run setup

The `tempo` system user is created by `up` if it does not exist. The state
directory is not created by `up` at all — the units declare
`StateDirectory=tempo`, and systemd creates and chowns `/var/lib/tempo` before
`ExecStart` on every boot. That is strictly better than `up` doing it: it also
holds when someone deletes the directory between deploys.

---

## `tempo run <name> [args...]`

Start a workflow. Talks to a server and does nothing else.

```
tempo run greeter world           # start it, print the id, exit
tempo run greeter world --wait    # start it, block, print the result
```

```
--wait          block until it settles and print the result
--queue=NAME    the pool to start it on (default "default")
--server=URL    the server to talk to (default http://127.0.0.1:7777)
```

**`--queue` is not optional to have.** A worker deployed onto a queue other than
`default` and a `run` that always starts on `default` gives you an execution
parked forever with nothing polling for it — which is precisely the failure
`tempo queues` exists to explain, arrived at through the CLI's own front door.
Since the server already knows what is being polled, `run` naming a queue
nothing polls should say so rather than park.

**Arguments are parsed as JSON, falling back to the raw string.** That is what
makes `run greeter world` pass a string and `run adder 1 2` pass numbers. It is
a contract, not an implementation detail — the deleted `parseWorkflowArg` had
exactly this rule and it should come back unchanged.

**`--wait` exits non-zero when the workflow fails.** A CI check is the main
reason `--wait` exists, and it is worthless if a failed workflow exits 0. The
old CLI got this for free by letting `getResult`'s rejection escape to a
top-level handler; the new one should mean it on purpose.

**`--`** separates the CLI's arguments from the workflow's, so a workflow
argument starting with `-` is unambiguous:

```
tempo run myWorkflow --wait -- --this-is-an-argument
```

Note that the deleted argument parser had no concept of `--` and treated any
`--x` anywhere as its own flag. This is new behaviour, not recovered behaviour.

With no server reachable, `run` fails with the `tempo up` line that would fix
it.

---

## `tempo result <workflow-id>`

Print the outcome of an execution that already exists, blocking if it has not
settled. Same output shaping and same exit-code rule as `run --wait`, which is
the point of it: `run` prints an id, and this is what the id is for.

---

## `tempo down`

Stop and disable all three units, so a reboot does not bring them back.

**It deletes nothing** — not `/opt/tempo`, and emphatically not
`/var/lib/tempo`. `down` is the inverse of `up`'s supervision, not of its
filesystem writes, and a verb that pairs with `up` in muscle memory is the worst
possible home for "destroy the history". Removing data stays a separate,
explicit act with a name that says so.

---

## `tempo run-local` — its own command, not a flag on `run`

A one-process, in-memory, no-server run of a workflow **straight from source**,
with nothing built and nothing deployed.

```
tempo run-local greeter world
```

**It is a separate command rather than `run --local`, because the two share
almost nothing.** `run` dials a server that something already deployed and makes
one RPC; `run-local` composes a whole engine in this process, registers a
worker's exports into it, runs one workflow, prints the result, and exits.
Sharing a verb between those would mean a command whose prerequisites, failure
modes, and output all depend on a flag — and the flag would be the only thing
telling you whether "cannot reach a server" is a bug or irrelevant.

**This is what `--runtime=local` on the worker entrypoint used to approximate,
and it is why that flag is gone.** The flag made a _deployable artifact_ branch
at startup on whether it was a deployment or a dev loop, which is a property no
deployable artifact should have; and it could only ever run what its own binary
already had compiled in, so it needed a build to demonstrate something whose
whole point is needing no build. `createLocalRuntime` is untouched — that is the
engine `run-local` composes.

### What this means the CLI has to know, and why that is acceptable now

`run-local` has to turn source into a running worker: find the entrypoint, run
it under `tsx` or through a build system, and get its registrations. **That is
exactly the knowledge `ports/toolchain.ts` and `source_toolchain.ts` carried,
and #62 deleted them for a reason that no longer applies.** They existed because
`up` _and_ `run` both needed it and had to agree on it — an abstraction serving
two callers with different needs, which is why it grew a port. Here there is one
caller, and `up` and `run` still know nothing about builds. So the knowledge
comes back as one command's implementation detail rather than as a seam, and the
next person to read #62 should not re-delete it on sight.

Open, and worth settling before writing it: **whether `run-local` runs an
entrypoint file or a workflow module.** Running the entrypoint means executing a
file whose last statement is `Tempo.startWorker(...)`, which starts a _worker_,
not a local runtime — so either the entrypoint gains a way to be imported
without starting, or `run-local` takes the workflow and activity modules
directly and never touches the entrypoint. The second is less magic and skips
the artifact entirely; the first runs closer to what deploys.

### The smoke test that lost its home

`--runtime=local` had one use that was not about local development: booting the
shipped artifact with no server anywhere, to prove every export actually
registers. That check is gone with the flag, and `run-local` does not replace it
— running from source proves nothing about a built artifact.

Nothing verifies that today. It is worth an issue rather than a hole: the
natural home is whatever builds the artifact, checking that the thing it just
produced comes up.

---

## Open questions

### 1. Does the engine get a build step? — no, and not in this repo

**Settled.** `AGENTS.md` says of `esbuild` that "it bundles the dashboard's
browser code and nothing else: the engine still runs from source under `tsx`,
and adding a build step to it would be its own argument." That rule stands
unchanged, because **this repo never builds the artifacts `up` installs.**
Whoever deploys does: a Blaze workspace with a rule per target, or an install
script shipped alongside the binary and living outside this repo. In-repo, the
CLI runs from source under `tsx` as an npm script, like everything else here.

One consequence to plan for: a checkout cannot produce `/opt/tempo/server.js` on
its own, so **`up` cannot be exercised end to end from this repo** — and on a
non-Linux dev machine it cannot be exercised at all. Its specs therefore test
what `up` decides rather than what systemd does: the unit text it generates, the
copy-and-rename sequence, and the root check. That needs `systemctl` and the
install root behind a seam narrow enough to be worth having — one function that
runs a command, and one path prefix — which is a different and much smaller
thing than the `Toolchain` port that was deleted.

### 2. Version skew, relocated but not solved

`run` no longer deploys, so it can no longer accidentally _fix_ a stale
deployment either. A server and workers installed last week keep serving; `run`
talks to them happily while the code in the tree has moved on.

That is not a deployment inconvenience — it is a worker replaying a history
written by different code, which is the failure class of #39 and is invisible
from the outside.

An earlier draft proposed: `up` writes fingerprints to `VERSION`, the server
reports its own, `run` warns on a mismatch. That catches a narrower failure than
the one described — "`up` copied the files but the restart did not happen" — and
it asks the wrong process. The skew that corrupts a replay is a **worker's**,
and an installed CLI on a production host has no source tree to compare against
anyway.

The fingerprint should travel on the **worker's poll**, where `identity` already
goes, so that:

- `tempo queues` shows a fingerprint per worker, and a fleet running two
  versions of the same artifact is visible without starting anything;
- the alarm is "these workers disagree with each other", which is the condition
  that actually breaks a replay, rather than "this host disagrees with a file".

The cost is a `protocol/` addition — `WorkerInfo` gains a field — and ROADMAP
invariant 4 says wire-format additions are deliberate rather than incidental.
This one is worth it, but it is a decision to make rather than a detail to slip
in, and it can land after `up` does. It does not have to fix the skew. It has to
not be silent about it.

### 3. Where does the dashboard go?

`up` installs a server and workers and no dashboard, and the dashboard is the
operator UI — it is also the code this file holds up as the model for exhaustive
event handling. Deploying it means a fourth unit and a static-file root, and it
is a separate package by design (`AGENTS.md`: the edge points one way, and
`tools/boundaries.ts` fails any mention of `dashboard/` from `src/`), so `up`
cannot reach for it by path. Out of scope for the first cut; say so out loud
rather than leaving its absence to be noticed.

---

## What this does not cover yet

`signal`, `cancel`, `terminate`, `list`, `describe`, `queues` — the read and
drive commands. All built, all deleted with the rest; none of them were the
reason for the redesign. They are all RPC clients like `run`, so they should
come back close to as they were once the four commands above have settled.

**When `describe` comes back, its event formatter needs `assertNever`.** The
deleted one was a ternary chain ending in `: ''`, so a history event it had
never heard of rendered with no detail and nothing failed — the type-checker had
no opinion.

Keeping the deletion branch in sync demonstrated it twice in a row.
`workflowSignaled` arrived and had to be hand-added to that formatter; then
`childStarted` gained a `parentClosePolicy` and had to be hand-added again. Both
times `dashboard/app/history_view.ts` and `history_spans.ts` were _forced_ to
handle the change, because both end their switch in `assertNever`. Same
question, two answers, and only one of them survives someone forgetting.

It also means this file is a magnet for merge conflicts while the CLI is absent:
**every change that touches the history-event union conflicts with a branch that
deletes it.** That is an argument for landing the replacement sooner rather than
carrying the deletion for long.

So the formatter should be an exhaustive `switch` over `HistoryEvent`, matching
the dashboard. AGENTS.md already requires that shape; the old formatter predated
the rule and was never brought in line. The two cases it will need on arrival,
recorded here because they were only ever written in a file that got deleted:

- `workflowSignaled` — `<name> -> <targetId>`, marked when undelivered.
- `childStarted` — the existing id and `detached`, plus `on-close=<policy>`.

---

## Suggested order

1. **`tempo run` and `tempo result`** — they depend on nothing open.
   `src/client/` survives intact, so this is argument parsing plus calls that
   already exist. It also re-establishes the CLI entrypoint and the
   `package.json` script that the deletion removed.
2. **Flags instead of the environment**, across `bin/server-main.ts` and
   `src/tempo.ts`, with port 7777. `run` needs `--server` anyway, and doing the
   server and worker in the same pass is what keeps one port from being written
   in two places.
3. **`tempo up` and `tempo down`** — copy, units, enable, restart. The hazards
   are listed above and every one of them works in testing and fails later.
4. **`tempo run-local`**, once the entrypoint-or-modules question above is
   settled. Last of the five rather than first despite being the smallest: it is
   the only one that needs a decision nobody has made yet, and the only one whose
   implementation the other four do not touch.
5. **The version fingerprint** (question 2), once there is a deployment that can
   go stale.
6. **The drive and read commands** — `signal`, `cancel`, `terminate`, `list`,
   `describe`, `queues`.
