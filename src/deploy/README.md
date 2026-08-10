# Deployment — design in progress

**This directory is a library, not a command-line tool.** It exports the
TypeScript functions that install, supervise, and inspect a tempo deployment.
Assembling them into a CLI — parsing argv, formatting output, choosing exit codes
— is somebody else's job, and deliberately not here.

This file is temporary and holds the design while it firms up. It is not the home
for it — design work belongs in GitHub issues (see `AGENTS.md`) — but a directory
holding only a README is a useful marker that code is coming back to it, and the
design is easier to argue about beside where it will live. Move it to an issue
when the first function lands.

## What happened to the CLI

There was one, and #62 deleted it to redesign the surface. The redesign settled on
five commands — `up`, `down`, `start`, `result`, `status` — and `start` and
`result` were briefly built, argv parser and all.

**That parsing is gone again, on purpose.** What is valuable here is the work the
commands do: copying artifacts, rendering systemd units, restarting services,
reading back what a deployment is actually doing. What is not valuable is a second
opinion about how a command line should be spelled — the consumer of this library
has one, and every argv convention baked in here is one they have to work around.

So the shape is: **typed options in, typed values out, and nothing printed.** No
`process.stdout`, no exit codes, no argv. A function that cannot do its job
throws, and the assembler decides what that looks like to a user.

That has a consequence worth stating: `start` and `result` need **no functions
here at all**. Starting a workflow and awaiting its result is `src/client/`,
which already exists and is already the library form of both. A wrapper adding
nothing but a different name would be worse than no wrapper.

---

## The surface

Three functions, all `async`, all taking one options object.

```ts
up(options: UpOptions, host: Host): Promise<UpResult>;
down(host: Host): Promise<DownResult>;
status(options: StatusOptions, host: Host): Promise<DeploymentStatus>;
```

`Host` is the seam onto the machine — see below. It is an explicit parameter
rather than an ambient import because these functions are otherwise untestable:
they exist to run `systemctl` and write to `/opt`, and neither is available in a
spec or on a developer's laptop.

---

## `up(options, host)`

Copy both artifacts into place, write systemd units, start everything. Calling it
again is how a new version is deployed.

```ts
await up(
  {
    server: 'blaze-bin/third_party/tempo/server.js',
    worker: 'blaze-bin/my/worker.js',
  },
  systemHost(),
);
```

```ts
interface UpOptions {
  /** Path to a built server artifact — a final `.js` file. */
  server: string;
  /** Path to a built worker artifact — a final `.js` file. */
  worker: string;
  /** What the server binds and workers dial. Default `DEFAULT_PORT` (7777). */
  port?: number;
  /** The interface the server binds. Default `127.0.0.1`. */
  host?: string;
}
```

**Both paths are to final `.js` files. The caller builds; `up` copies.** That is
the whole contract, and it is what keeps the build system out of this library:
with Blaze, deploying is `blaze build` followed by this call, and no adapter
anywhere. Two earlier drafts lost that property — one had a run verb deploying on
demand, another had `up` resolving build _targets_ through a toolchain — so it is
stated as a goal rather than left to be noticed.

### What is a constant, and why

The install root, the state directory, and the interpreter are **not options**:

```
/opt/tempo         the install root
/var/lib/tempo     the server's durable history
/usr/bin/node      the interpreter the units run
```

An option with one correct value is an option that only ever gets passed wrong.
These become options the day a deployment needs them to differ; until then a
constant is one fewer thing that can disagree between the unit `up` writes and the
layout everything else assumes.

`/usr/bin/node` is the honest weak point: a host with node elsewhere gets a unit
that fails `203/EXEC` on first start. That is loud rather than silent — the
deployment does not come up and `systemctl status` says exactly why — which is
what makes a constant acceptable here.

### The queue is not an option either, because the worker already knows

**A queue is declared once, in `Tempo.startWorker`.** A queue name is a contract
about which workflows and activities are registered, so it belongs with the code
that registers them, not with the function that copies the file. Passing it here
as well would put one value in two places with nothing keeping them in step, and
the failure when they disagree is an execution parked forever on a queue nothing
serves.

So the worker units carry `--role` and `--server`, and nothing else about routing.

### Three services, because the worker roles are separate processes

One server unit and **two worker units from the one artifact**:

```
tempo-server.service            --port=7777 --host=127.0.0.1 --data-dir=/var/lib/tempo
tempo-worker-workflow.service   --role=workflow --server=http://127.0.0.1:7777
tempo-worker-activity.service   --role=activity --server=http://127.0.0.1:7777
```

The split is the deployed shape and always was — `src/tempo.ts` says why, and
`spec/integration/distributed.spec.ts` proves it end to end. An activity is the
only place I/O happens, so an activity blocking the event loop in a process that
also replays workflows stalls replay into a lease expiry. The two tiers also scale
independently against one server.

A single both-roles process is the _dev_ shape — a hand-run binary with no
`--role` serves every role it has definitions for — and it must not be what a
deployment gets by accident.

**One worker artifact to start with**, hence one `worker` option and a flat
layout. Supporting several means a name per worker and a directory per name;
nothing here forecloses it, and the role split is already a rehearsal for the
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

### The two properties the units have to deliver

**1. Everything is running at all times** — across crashes, restarts, and
reboots.

- `Restart=always` with a short `RestartSec`, so a crash comes back.
- `WantedBy=multi-user.target` plus `systemctl enable`, so a reboot comes back.
  Without `enable`, a host reboot silently drops the entire deployment while every
  `systemctl status` was green the day before.
- `StartLimitIntervalSec=0`, so systemd never gives up. The default rate limit
  stops a unit after five restarts in ten seconds and leaves it `failed`, which
  turns "always running" into "gave up during the incident". The cost is that a
  genuinely misconfigured worker crash-loops forever instead of parking; both are
  visible in `systemctl status`, and only one of them recovers on its own once the
  cause is fixed.
- Workers get `After=tempo-server.service`, which orders a boot but is not a
  guarantee — a worker that starts before the server is listening backs off and
  retries, which is already how `worker/worker_loops.ts` behaves.

**2. Calling `up` again actually redeploys** — the running processes serve the new
files.

- `systemctl daemon-reload` after writing the units. Without it, a call whose unit
  contents changed is a no-op that looks exactly like a deploy.
- `systemctl restart` on all three, server first. Nothing rereads a `.js` file in
  place, so the restart _is_ the deployment.
- In-flight activity attempts die with the restart. That is acceptable —
  activities are at-least-once and expected to be idempotent — but it is a real
  consequence and not a silent one.

### Mechanical hazards, all three of the kind that work in testing

- **Copy dereferenced.** `blaze-bin/` is a symlink farm into the output base, so a
  naive copy installs links that dangle the next time someone builds with
  different flags — a deployment that breaks with no deploy having happened.
- **Install atomically.** Copy to a temporary path on the same filesystem,
  `rename(2)` into place, then restart. A half-copied artifact that systemd
  restarts into is worse than an old one.
- **Check for root up front.** `up` writes `/opt` and `/etc/systemd/system`. A
  permission error discovered halfway through is a partial deploy; a refusal
  before the first write is not.

### First-run setup

The `tempo` system user is created if it does not exist. The state directory is
not created by `up` at all — the units declare `StateDirectory=tempo`, and systemd
creates and chowns `/var/lib/tempo` before `ExecStart` on every boot. That is
strictly better than doing it here: it also holds when someone deletes the
directory between deploys.

---

## `down(host)`

Stop and disable all three units, so a reboot does not bring them back.

**It deletes nothing** — not `/opt/tempo`, and emphatically not `/var/lib/tempo`.
`down` is the inverse of `up`'s supervision, not of its filesystem writes, and a
name that pairs with `up` in muscle memory is the worst possible home for "destroy
the history". Removing data stays a separate, explicit function with a name that
says so.

Idempotent: called against units already stopped, or never installed, it reports
that rather than throwing. An assembler should be able to offer "make sure this is
off" without catching anything.

---

## `status(options, host)`

What a deployment is doing, as data. **Scope not fully settled.**

Two sources, answering different questions:

- **systemd** — is each unit active, is it enabled, how many times has it
  restarted. Available with no server running, which is when the question is most
  urgent.
- **the server's worker registry**, over RPC — who is polling which queue, per
  role (`listQueues`, `groupExecutions`; see `server/worker_registry.ts`).

A worker can be the first without being the second: the process is up, systemd is
satisfied, and it is not actually serving. That is the failure this function most
needs to make visible, so it reports both.

**It must degrade rather than throw when the server is unreachable.** "The units
are up and nothing answers on 7777" is the most useful thing it could ever
return, and a function that rejected on a failed connection could not say it. So
the server half of the result is explicitly optional, with the reason it is
missing.

Open: whether it also reports the artifact fingerprints from
[question 2](#2-version-skew-relocated-but-not-solved).

---

## `Host` — the seam onto the machine

Every one of these functions exists to do something to a machine: write `/opt`,
render into `/etc/systemd/system`, run `systemctl`. None of that is available in a
spec, and none of it is available on a developer's laptop at all if that laptop is
not Linux. So it goes behind one interface, passed in.

```ts
interface Host {
  /** Effective uid, so `up` can refuse before its first write. */
  euid(): number;
  /** Copy dereferenced to a temp path on the same filesystem, then rename into place. */
  installFile(source: string, destination: string): Promise<void>;
  /** Write a file outright — the units, and `VERSION`. */
  writeFile(destination: string, contents: string): Promise<void>;
  /** Run a command. Returns the exit code rather than throwing on a non-zero one. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}
```

`run` returns its exit code instead of rejecting because a non-zero exit is
ordinary here: `systemctl is-active` exits 3 for an inactive unit, and `status`
asking that question should not be writing a `catch` to learn the answer. The
functions that _do_ require success say so at their call site.

**This is not the `Toolchain` port that #62 deleted.** That one abstracted "how a
target becomes a process" for two callers who had to agree on it, and it was
deleted when both got out of that business. This abstracts "the machine", for the
sole purpose of being able to test any of this at all — one implementation
(`node:fs` plus `node:child_process`) and one fake, both narrow.

A consequence, stated because it decides what the specs can be worth: **`up`
cannot be exercised end to end from this repo**, and not at all on a non-Linux
machine. What the specs check is therefore what `up` _decides_ — the exact text of
the units, the order of the copy/rename/reload/restart calls, and the root check —
against a fake `Host` that records them. That is a real limit, not a gap to be
apologised for: unit text is where the deployment's correctness lives, and it is
fully checkable.

**The highest-value spec is the one that pins the flag names.** Nothing else makes
the units `up` writes agree with the flags `bin/server-main.ts` and `src/tempo.ts`
actually parse. A unit saying `--listen=7777` where the server reads `--port`
produces a deployment that starts, reads healthy, and serves nobody — so the spec
asserts the generated text against the parsers rather than against a copy of the
expected string.

---

## Open questions

### 1. Does the engine get a build step? — no, and not in this repo

**Settled.** `AGENTS.md` says of `esbuild` that "it bundles the dashboard's
browser code and nothing else: the engine still runs from source under `tsx`, and
adding a build step to it would be its own argument." That rule stands unchanged,
because **this repo never builds the artifacts `up` installs.** Whoever deploys
does: a Blaze workspace with a rule per target, or an install script living
outside this repo. In-repo, everything runs from source under `tsx`.

### 2. Version skew, relocated but not solved

Nothing deploys on demand any more, so nothing accidentally _fixes_ a stale
deployment either. A server and workers installed last week keep serving while the
code in the tree has moved on.

That is not a deployment inconvenience — it is a worker replaying a history
written by different code, which is the failure class of #39 and is invisible from
the outside.

An earlier draft proposed: `up` writes fingerprints to `VERSION`, the server
reports its own, and a client warns on a mismatch. That catches a narrower failure
than the one described — "`up` copied the files but the restart did not happen" —
and it asks the wrong process. The skew that corrupts a replay is a **worker's**.

The fingerprint should travel on the **worker's poll**, where `identity` already
goes, so that a fleet running two versions of one artifact is visible without
starting anything, and the alarm is "these workers disagree with each other" —
the condition that actually breaks a replay. The cost is a `protocol/` addition
(`WorkerInfo` gains a field), and ROADMAP invariant 4 says wire-format additions
are deliberate rather than incidental. It does not have to fix the skew; it has to
not be silent about it.

Until it is decided, `up` writing a `VERSION` nothing reads is a file that rots.
It is in the layout above and is the one part of the layout not yet earned.

### 3. Where does the dashboard go?

`up` installs a server and workers and no dashboard, and the dashboard is the
operator UI. Deploying it means a fourth unit and a static-file root, and it is a
separate package by design (`AGENTS.md`: the edge points one way, and
`tools/boundaries.ts` fails any mention of `dashboard/` from `src/`), so `up`
cannot reach for it by path. Out of scope for the first cut; said out loud rather
than left to be noticed.

---

## What this does not cover

**Driving and reading workflows.** `start`, `result`, `signal`, `cancel`,
`terminate`, `list`, `describe`, `queues` — the CLI had all of them and this
library needs none, because they are `src/client/` and the `WorkflowService`
methods behind it. An assembler calls those directly. The one thing the deleted
CLI added that was not presentation is a reachability probe before a
fire-and-forget write, and that belongs to `status`.

**The artifact smoke test.** `--runtime=local` on the worker entrypoint used to
let you boot a shipped artifact with no server and prove every export actually
registers. That flag is gone and nothing replaces it. `status` is not the right
home — it inspects a deployment, not an artifact — and the natural one is whatever
builds the artifact. It wants an issue.

**Running a workflow from source with nothing deployed.** It was going to be a
`run-local` command, and it is the one piece that would have to know how source
becomes a process. Not being built; comes back as its own design if it comes back.

---

## Suggested order

1. **`Host` and the unit rendering.** Pure functions and one interface, and the
   whole of what makes the rest testable. The unit text is the deployment.
2. **`up`.** The hazards above are every one of the kind that works in testing and
   fails later.
3. **`down`.** Small once `up` exists, and shares the seam.
4. **`status`**, once its scope is settled.
5. **The version fingerprint** (question 2), once there is a deployment that can
   go stale.
