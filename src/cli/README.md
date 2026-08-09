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

## The split

Two commands, and the line between them is the point.

| Command     | Does                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `tempo up`  | Installs and starts the server and the worker. Explicit. Needs root. |
| `tempo run` | Starts a workflow. Never deploys anything.                           |

`run` deploying on demand was considered and rejected: it put building two
binaries, writing `/opt/tempo`, and installing systemd units behind a verb that
reads like "execute this workflow", and made every build, copy, and unit failure
surface from what the user thinks is one RPC. `up` owning it means `run` can
fail with one actionable line instead.

---

## `tempo up --server=<artifact> --worker=<artifact>`

Install both, start both, exit. Re-running it is how you deploy a new version.

**One worker to start with.** The layout below is flat because of that, and
`--worker` is singular for the same reason. Supporting several means a name per
worker and a directory per name; nothing here forecloses it.

```
tempo up --server=./dist/server.js --worker=./dist/worker.js
```

Both artifacts are **built JavaScript** — see the open question about what that
costs. The CLI copies them to a well-known location, writes systemd units, and
starts them:

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
`node /opt/tempo/server.js`. Which `node` is a question the units have to answer
explicitly rather than inherit from whoever ran `tempo up`.

Redeploy is: copy to a temporary path on the same filesystem, `rename(2)` into
place, `systemctl restart`. A half-copied artifact that systemd restarts into is
worse than an old one. In-flight activity attempts die with the restart, which
is acceptable — activities are at-least-once and expected to be idempotent — but
it is a real consequence and not a silent one.

---

## `tempo run <name> [args...] [--local=<target>] [--wait]`

Start a workflow. Deploys nothing.

```
tempo run greeter world                     # start it, print the id, exit
tempo run greeter world --wait              # start it, block, print the result
tempo run greeter world --local=./worker.ts # whole topology in one process
tempo run greeter world --local=//my:worker # same, under a build system
```

With no server reachable, it fails with the `tempo up` command that would fix
it. That is the whole of its deployment behaviour.

### `--local=<target>`

A **fresh in-memory runtime in one process**. No server, no port, no
persistence, nothing installed, nothing left behind. Implies `--wait`, because
there is nothing to come back to — the runtime dies with the process.
`--local --no-wait` is an error rather than silently ignored.

`<target>` is the worker, and unlike `up` it is a _source_ target, because this
is the dev loop:

- **Source:** a `.ts` entrypoint that calls `Tempo.startWorker`, run under `tsx`.
- **Build system:** a label. `blaze run <target> -- --local …`.

`Tempo.startWorker` sees the local flag and reaches for the in-memory runtime,
ignoring `TEMPO_SERVER_URL`, port, and data-dir entirely.

### `--wait`

Blocks until the workflow settles and prints its result. Without it, the
workflow id is printed and the process exits — the workflow keeps running on the
server.

### Argument parsing

`--` separates the CLI's arguments from the workflow's, so a workflow argument
starting with `-` is unambiguous:

```
tempo run myWorkflow --wait -- --this-is-an-argument
```

---

## Open questions

### 1. Built JavaScript means the engine gets a build step, and that is a rule

`AGENTS.md` currently says of `esbuild`:

> **It bundles the dashboard's browser code and nothing else**: the engine still
> runs from source under `tsx`, and adding a build step to it would be its own
> argument.

Deploying built JS **is** that argument, and it has to be made rather than
walked past. The rule exists because the last build-shaped thing in this repo
put a TypeScript compiler in the dashboard's runtime dependencies.

For crossing it: shipping `tsx` and a `node_modules` to a production host to run
TypeScript from source is worse than shipping one bundled file. A single file
also makes the atomic-rename install trivial and removes any question about
symlinks.

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

An alternative worth considering: this is now the operator's problem by
construction, since `up` is explicit. Defensible — but only if something,
somewhere, can answer "what is deployed?"

### 3. Does `up` build, or only install?

`--server=./dist/server.js` says the caller builds and `up` copies. That keeps
the CLI entirely out of the build business, which makes the Blaze story
one line with no adapter at all:

```
blaze build //my:worker //third_party/tempo:server
tempo up --server=blaze-bin/third_party/tempo/server.js \
         --worker=blaze-bin/my/worker.js
```

The alternative is that the flags take _targets_ and `up` resolves them through
a toolchain, as the deleted CLI did. More convenient, and it drags the build
system back into the CLI.

Recommendation: take paths. `up` is run rarely and deliberately; the extra line
is cheap, and "the CLI does not know what a build system is" is worth a lot.

**If it takes paths, it must still copy dereferenced.** `blaze-bin/` is a
symlink farm into the output base, so a naive copy installs links that dangle
the next time someone builds with different flags — a deployment that breaks
with no deploy having happened.

### 4. What is the dev loop now?

The old `tempo up` ran a server and a worker in the foreground, which is what
you wanted while poking at something. The new one installs services.

`run --local` covers one-shot. It does not cover "leave a server up while I run
five things against it and read the dashboard". Options: a `--foreground` on
`up` that skips the install and supervises children instead, or a separate
`tempo dev`, or accept that the dashboard-and-poke loop needs the installed
services.

### 5. How does the local flag reach `startWorker`?

**Argv, not an environment variable**, following the precedent in
`src/tempo.ts`: a flag has to be typed at the launch site and does not propagate
to children, which is exactly the property a mode switch wants. `TEMPO_LOCAL=1`
exported in a shell — or inherited by a worker spawned from a test — turns a
production worker into one that serves nobody while still looking healthy.

### 6. Getting the result back out of `--local`

The workflow runs _inside_ the worker process, so the result comes back over
stdout — competing with the user's own logging, and under Blaze with the build
system's chatter. It needs a channel that cannot collide: a single
`TEMPO_RESULT <json>` line, or a file path passed in for the worker to write and
the CLI to read. The second is uglier and cannot be corrupted by a stray
`console.log`.

### 7. First-run setup

`/var/lib/tempo` and a `tempo` system user have to exist before the units start.
Either `up` creates them, or there is a documented prerequisite. Creating them
is friendlier and is more of what `up` is already doing.

---

## What this does not cover yet

`signal`, `cancel`, `terminate`, `list`, `describe`, `queues` — the read and
drive commands. All built, all deleted with the rest; none of them were the
reason for the redesign. They should come back close to as they were once `up`
and `run` have settled how artifacts, deployment, and waiting work.
