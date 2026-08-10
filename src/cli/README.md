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

Two commands, and **neither knows what a build system is**.

| Command     | Does                                                             |
| ----------- | ---------------------------------------------------------------- |
| `tempo up`  | Copies built artifacts into place and starts them. Needs root.   |
| `tempo run` | Starts a workflow against a server. An RPC client, nothing more. |

That property is worth stating as a goal rather than noting as an accident,
because two earlier drafts lost it. `run` was going to deploy on demand, which
put building binaries and installing systemd units behind a verb meaning
"execute this workflow". Then `up` was going to take build _targets_ and resolve
them through a toolchain. Both are gone. The CLI copies files and makes RPCs.

The local-development story is deliberately **not** a CLI feature — see below.

---

## `tempo up --server=<path> --worker=<path>`

Copy both artifacts into place, write systemd units, start both, exit.
Re-running it is how you deploy a new version.

```
blaze build //my:worker //third_party/tempo:server
tempo up --server=blaze-bin/third_party/tempo/server.js \
         --worker=blaze-bin/my/worker.js
```

**Both flags take a path to a final `.js` file.** The caller builds; `up` copies.
That is the whole contract, and it is what keeps the build system out of the
CLI: with Blaze the above is two ordinary lines and no adapter anywhere.

**One worker to start with.** The layout is flat because of that, and `--worker`
is singular for the same reason. Supporting several means a name per worker and
a directory per name; nothing here forecloses it.

```
/opt/tempo/
  server.js          # the engine server
  worker.js          # the one worker
  VERSION            # fingerprints of both — see question 2
/var/lib/tempo/      # history, owned by the tempo user
/etc/tempo/env       # config: env, never code
/etc/systemd/system/tempo-server.service
/etc/systemd/system/tempo-worker.service
```

`/var/lib` rather than a directory under `/opt`: `/opt` is the software,
`/var/lib` is the state it accumulates, and separating them is what makes
"replace the artifact, keep the history" a non-event.

Neither artifact is self-contained — they are JavaScript, so the units run
`node /opt/tempo/server.js`. Which `node` is a question the units answer
explicitly rather than inherit from whoever ran `tempo up`.

**Copy dereferenced.** `blaze-bin/` is a symlink farm into the output base, so a
naive copy installs links that dangle the next time someone builds with
different flags — a deployment that breaks with no deploy having happened.

**Install atomically.** Copy to a temporary path on the same filesystem,
`rename(2)` into place, then `systemctl restart`. A half-copied artifact that
systemd restarts into is worse than an old one. In-flight activity attempts die
with the restart, which is acceptable — activities are at-least-once and
expected to be idempotent — but it is a real consequence and not a silent one.

---

## `tempo run <name> [args...] [--wait]`

Start a workflow. Talks to a server and does nothing else.

```
tempo run greeter world           # start it, print the id, exit
tempo run greeter world --wait    # start it, block, print the result
```

With no server reachable it fails with the `tempo up` line that would fix it.

**`--wait`** blocks until the workflow settles and prints its result. Without it,
the workflow id is printed and the process exits — the workflow keeps running on
the server.

**`--`** separates the CLI's arguments from the workflow's, so a workflow
argument starting with `-` is unambiguous:

```
tempo run myWorkflow --wait -- --this-is-an-argument
```

---

## Running locally is a worker feature, not a CLI one

There is no `--local` flag on `tempo run`. A one-process, in-memory, no-server
run is had by running the worker binary directly:

```
blaze run //my:worker -- --local --run=greeter world
node ./dist/worker.js --local --run=greeter world
```

The CLI is not in the path at all, which is why it needs no knowledge of `tsx`,
Blaze labels, or how a target becomes a process. That knowledge was the entire
reason the deleted `ports/toolchain.ts` existed; with it gone there is nothing
left for a toolchain abstraction to abstract.

What that leaves is real work, just not _here_. It belongs to `src/tempo.ts`:

- **`Tempo.startWorker` parses `--local` from its own argv** and reaches for the
  in-memory runtime, ignoring `TEMPO_SERVER_URL`, port, and data-dir.
- **Argv, not an environment variable**, following the precedent already in that
  file: a flag has to be typed at the launch site and does not propagate to
  children. `TEMPO_LOCAL=1` exported in a shell — or inherited by a worker
  spawned from a test — turns a production worker into one that serves nobody
  while still looking healthy.
- **It needs a way to say what to run**: which workflow, with which arguments,
  and what to print. Nothing parses that output any more, so it can be shaped
  for a human rather than for a protocol.

---

## Open questions

### 1. Built JavaScript means the engine gets a build step, and that is a rule

`AGENTS.md` says of `esbuild`:

> **It bundles the dashboard's browser code and nothing else**: the engine still
> runs from source under `tsx`, and adding a build step to it would be its own
> argument.

Deploying built JS **is** that argument, and it has to be made rather than
walked past. The rule exists because the last build-shaped thing in this repo
put a TypeScript compiler in the dashboard's runtime dependencies.

For crossing it: shipping `tsx` and a `node_modules` to a production host to run
TypeScript from source is worse than shipping one bundled file, and a single
file makes the atomic-rename install trivial.

If it lands, `AGENTS.md` changes in the same commit — the repo's own rule about
comments that describe the old design.

### 2. Version skew, relocated but not solved

`run` no longer deploys, so it can no longer accidentally _fix_ a stale
deployment either. A server and worker installed last week keep serving; `run`
talks to them happily while the code in the tree has moved on.

That is not a deployment inconvenience — it is a worker replaying a history
written by different code, which is the failure class of #39 and is invisible
from the outside.

The cheap version: `up` writes a fingerprint of each artifact to `VERSION`, the
server reports its own, and `run` warns on a mismatch it can name. It does not
have to fix it. It has to not be silent about it.

### 3. First-run setup

`/var/lib/tempo` and a `tempo` system user have to exist before the units start.
Either `up` creates them, or there is a documented prerequisite. Creating them
is friendlier and is more of what `up` is already doing.

---

## What this does not cover yet

`signal`, `cancel`, `terminate`, `list`, `describe`, `queues` — the read and
drive commands. All built, all deleted with the rest; none of them were the
reason for the redesign. They are all RPC clients like `run`, so they should
come back close to as they were once `up` and `run` have settled.

**When `describe` comes back, its event formatter needs `assertNever`.** The
deleted one was a ternary chain ending in `: ''`, so a history event it had
never heard of rendered with no detail and nothing failed — the type-checker had
no opinion. Merging `master` into this branch demonstrated it: the
`workflowSignaled` event added meanwhile had to be hand-added to that formatter,
while `dashboard/app/history_view.ts` and `history_spans.ts` were _forced_ to
handle it because both end their switch in `assertNever`. Same question, two
answers, and only one of them survives someone forgetting.

So the CLI's formatter should be an exhaustive `switch` over `HistoryEvent`,
matching the dashboard. AGENTS.md already requires this shape; the old formatter
predated the rule and was never brought in line.
