# Deployment — what is not decided yet

The library itself is documented where it lives: start at
[`index.ts`](index.ts) for the surface, [`units.ts`](units.ts) for what a
deployment actually _is_, and [`ports/host.ts`](ports/host.ts) for why the machine
is an argument. Every decision behind those is in the module it constrains, per
`AGENTS.md`.

Five functions: `up` and `down` are a deployment's lifecycle; `status`, `restart`,
and `logs` are what you do to one that exists. Workflow operations are not here —
they are [`../client/`](../client/client.ts), and the last section says why.

**This file is what is left over** — questions with no code to host them yet. It
held the whole design while none of this existed; now that `up`, `down`, and
`status` have landed, only the open parts belong here.

Per `AGENTS.md` these should be **GitHub issues rather than a file in the tree**,
since nothing in a diff will ever force someone to revisit them. They are written
down here rather than filed so that whoever reviews the library can see what it
knowingly does not answer; filing them and deleting this file is the next step.

---

## 1. Version skew is relocated, not solved

Nothing deploys on demand, so nothing accidentally _fixes_ a stale deployment
either. A server and workers installed last week keep serving while the code in
the tree moves on.

That is not a deployment inconvenience — it is **a worker replaying a history
written by different code**, which is the failure class of
[#39](https://github.com/chrisrocco/tempo/issues/39) and invisible from outside.

An earlier design proposed: `up` writes artifact fingerprints to a `VERSION`
file, the server reports its own, a client warns on a mismatch. That was dropped
because it answers a narrower question than the one asked — "`up` copied the files
but the restart did not happen" — and asks the wrong process. The skew that
corrupts a replay is a **worker's**.

The fingerprint should travel on the **worker's poll**, where `identity` already
goes, so that a fleet running two versions of one artifact is visible without
starting anything and the alarm is "these workers disagree with each other" — the
condition that actually breaks a replay. `status` would then report it, and it is
the one field an operator would come to `status` looking for and not find.

The cost is a `protocol/` addition (`WorkerInfo` gains a field), and ROADMAP
invariant 4 says wire-format additions are deliberate rather than incidental.

**Consequence today:** `up` writes no `VERSION` file. The layout has a place for
one and nothing reads it, and a file nothing reads is a file that rots.

## 2. The dashboard is not deployed

`up` installs a server and two workers. The dashboard is the operator UI and is
not among them.

It is a separate package by design — `AGENTS.md`: the edge points one way, and
`tools/boundaries.ts` fails any mention of `dashboard/` from `src/` — so `up`
cannot reach for it by path even if it wanted to. Deploying it means a fourth
unit, a static-file root, and a decision about whether `src/deploy/` is allowed to
know the dashboard exists.

Out of scope for the first cut, and said out loud rather than left to be noticed.

## 3. Nothing verifies a built artifact before it is deployed

`--runtime=local` on the worker entrypoint used to let you boot a shipped artifact
with no server anywhere and prove every export actually registers. That flag is
gone (see [`../tempo.ts`](../tempo.ts)) and nothing replaced it.

`up` will happily install an artifact whose workflows were never registered, and
the first sign will be executions parking on a queue whose workers reject every
task. `status` is not the right home — it inspects a deployment, not an artifact —
and the natural one is whatever _builds_ the artifact, checking that what it just
produced comes up.

## 4. Consequences of being a per-user deployment

These are systemd **user** units under `$XDG_DATA_HOME/tempo` — no root, and the
workflows run as the user who deployed them. That was chosen over a system daemon
because the workflows need the user's own identity and an operator should not need
`sudo` to deploy. What it costs:

- **Lingering is a privileged prerequisite.** `sudo loginctl enable-linger $USER`,
  once. Without it the services stop at logout and do not start at boot — every
  deploy succeeds and the deployment vanishes when the operator closes their
  laptop. `up` checks and reports it rather than failing, since the deployment is
  genuinely running at the moment it is asked.
- **No shared machine-wide daemon is possible.** Two users on one host get two
  servers, two worker pairs, and two histories. That is the point, but it also
  means **they cannot share port 7777** — a second user has to pass a different
  `port`, and nothing detects the collision beyond the second server failing to
  bind.
- **History lives in `$HOME`.** If that is NFS-mounted, `FileHistoryStore`'s
  single-writer lockfile is on much shakier ground than it is on local disk. Not
  investigated.
- **The interpreter is resolved, not assumed.** `ExecStart=` must be an absolute
  path, so one has to be chosen; `up` defaults it to the node running `up` itself,
  which for a per-user deployment is the user's own node and the version the
  artifacts were built against. This used to hardcode `/usr/bin/node`, which nvm,
  fnm, volta, asdf, and Homebrew all contradict — most likely to be wrong exactly
  where this model gets used. `up` takes a `node` option for the case where the
  deploying process is not running the right interpreter.

The prediction this replaces is worth keeping for the shape of the lesson: an
earlier version of this file said `/opt/tempo` and `/var/lib/tempo` would need to
become options "the day two tempo deployments have to coexist on one machine". The
trigger was right and the direction was wrong — it arrived as _every user is a
deployment_, which made the paths variable and deleted the system account entirely
rather than parameterising it.

---

## What this library deliberately does not cover

**Driving and reading workflows.** `start`, `result`, `describe`, `signal`,
`cancel`, `terminate`, `reset`, `list`, `queues`, `counts`, `health` — the deleted
CLI had all of these and this library needs none of them, because they are all
[`../client/`](../client/client.ts). An assembler calls that directly. What the CLI
added around them was argument typing, result formatting, and exit codes, all of
which are presentation.

That was not true when this library landed: `Client` covered only the six calls
that drive a single execution, and the reads meant dropping to a raw
`WorkflowService`. `createRemoteClient` now covers all of them, so an assembler
holds one object rather than two.

`status` here is not a duplicate of `RemoteClient.health`: that answers "is a
server listening and is it durable", and this one answers "is the deployment
working", which needs systemd as well and can disagree with it — a unit can be
`active` while nothing is polling the queue that has the work.

**Running a workflow from source with nothing deployed.** It was going to be a
`run-local` command, and it is the one piece that would have to know how source
becomes a process — the knowledge `ports/toolchain.ts` carried before #62 deleted
it. Not built; it comes back as its own design if it comes back.
