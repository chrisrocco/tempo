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

## 4. Two constants that will eventually need to be options

Recorded because each is a one-line change with a real trigger, and because
guessing wrong about _when_ is how they end up as options nobody needs:

- **`/usr/bin/node`.** A host with node installed elsewhere gets `203/EXEC` on the
  first start. Loud rather than silent, which is what makes the constant
  acceptable — but the first such host is the trigger.
- **`/opt/tempo` and `/var/lib/tempo`.** Fine until two tempo deployments have to
  coexist on one machine, which is also the point at which one `--worker` and a
  flat layout stop being enough. The role split is already a rehearsal for the
  naming that would need.

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
