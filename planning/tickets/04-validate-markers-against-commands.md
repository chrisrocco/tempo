# 04 — A branch-order divergence corrupts silently instead of failing

**Type:** correctness (core) · **Raised by:** the concurrency made idiomatic in
`signalStream` / `background` ([`src/core/signal_stream.ts`](../../src/core/signal_stream.ts))

> **Status: Tier 1 landed.** `requested` is recorded through a single `issue`
> helper in [`workflow_api.ts`](../../src/core/workflow_api.ts) (which closes the
> `startChild`/`cancel` bypass trap by construction), markers are validated in
> [`apply_event.ts`](../../src/core/apply_event.ts), and `NondeterminismError`
> carries `{seq, expected, actual}`. Tiers 2 and 3 remain open.
>
> One deviation from the plan below, decided while implementing: **a marker whose
> seq the workflow never issued is skipped, not rejected.** A run stops allocating
> seqs the moment `cancelRequested` is applied, so absence is not evidence of
> divergence, and treating it as such would fail correct workflows. The check is
> strictly about disagreement.

## Problem

Command correlation is by `seq`, assigned in call order. With two concurrent
branches allocating from one counter — now the normal shape, not an exotic one —
the interleaving is deterministic only as long as branch progress depends purely
on history. When something breaks that, the nondeterminism check catches only
half the cases.

[`src/core/apply_event.ts`](../../src/core/apply_event.ts) fires when a completion
arrives for a seq nothing is parked on:

```ts
const waiter = ctx.completions.get(ev.seq);
if (!waiter) throw new Error(`nondeterminism: history event for unknown seq ${ev.seq}`);
```

But if two branches merely **swap order**, seq 3 and seq 4 swap meaning and _both
are parked_. Both resolve — each with the other's result. No error. The workflow
continues with a string where it expected a number, or with another CL's review
comments, and the first symptom appears arbitrarily far downstream.

Markers already carry the information needed to catch this, and replay throws it
away:

```ts
// apply_event.ts — every marker is a bare return
if (ev.type === 'activityScheduled' || ev.type === 'timerStarted' || ev.type === 'childStarted') {
  return;
}
```

`ActivityScheduledEvent` records `{ seq, name, args, options }`. Nothing compares
`name` against what the workflow actually asked for at that seq.

## Impact

Silent state corruption in the one place the engine is supposed to be
authoritative. It is also the failure mode hardest to attribute: the divergence
happens on a replay, the damage surfaces later, and history looks well-formed
throughout. Concurrency was rare before `signalStream`; a lifetime consumer
alongside staged work makes two-branch workflows the default shape.

## Proposed work, in tiers

**Tier 1 — validate what markers already record (no protocol change).**

Record every command as it is issued, regardless of `isLive`:

```ts
// context.ts
requested: Map<number, Command>;
```

populated in `scheduleCommand`, then checked when the marker is applied:
`activityScheduled` against `type` **and** `name`; `timerStarted` and
`childStarted` against `type` only (see Coverage). Replace the bare `Error` with a
`NondeterminismError` carrying `{ seq, expected, actual }` so the server can
report a clear terminal reason rather than a generic failure.

**Tier 2 — close the child-name gap.** Add `childName` to `ChildStartedEvent` and
validate children by name. Additive, but validation must skip when the field is
absent so histories written before the change still replay.

**Tier 3 — argument comparison, opt-in.** Type and name miss the case of the same
activity called twice with different arguments at swapped seqs. A deep compare of
`args` closes it but is expensive on large payloads and risks false positives on
serialization differences, so it belongs behind a flag for debugging a suspected
divergence, not on by default.

### Coverage after Tier 1

| Command            | Marker              | Validatable                                                |
| ------------------ | ------------------- | ---------------------------------------------------------- |
| `scheduleActivity` | `activityScheduled` | type + **name**                                            |
| `startTimer`       | `timerStarted`      | type only (`fireAt` is absolute; the command carries `ms`) |
| `startChild`       | `childStarted`      | type + **`detached`** (no `childName` until T2)            |
| `cancelChild`      | none, by design     | nothing — see below                                        |
| `continueAsNew`    | none                | terminal; n/a                                              |

**`cancelChild` stays unvalidated, and that is correct.** It is the one command
that legitimately writes no marker: its effect _is_ a durable record — the
`cancelRequested` event appended to the child's history — and `requestCancel`
short-circuits on finding one, so a re-dispatched cancel is idempotent rather
than a second cancellation
([`server_core.ts`](../../src/server/server_core.ts)). Adding a marker purely to
give this check something to compare would invert that reasoning for a narrow
gain. Its seq simply is not covered.

Partial coverage, and worth stating plainly: Tier 1 reduces the silent-swap window
rather than eliminating it. It catches every swap between _different kinds_ of
operation and every swap between differently-named activities, which is the bulk
of real divergences.

## Traps found while scoping

- **`startChild` bypasses `scheduleCommand`.** It builds its `Command` inline, as
  does the `cancel()` on the handle it returns
  ([`workflow_api.ts`](../../src/core/workflow_api.ts)). Both must populate
  `requested`, or their seqs look unrequested and the check false-positives on
  correct workflows.
- **Ordering must be verified, not assumed.** The check relies on the workflow
  having emitted seq _N_ before the marker for _N_ is applied. That holds because
  the server writes the marker only after receiving the command batch, so every
  event that drove the emission precedes it in history — including on the first
  task, where the command is issued during the initial synchronous run before any
  event is applied. Pin it with a spec rather than trusting the argument.
- **Recording every command changes the memory profile.** `requested` grows with
  seq for the life of a run, where `completions` shrinks as things resolve. Bounded
  by history size and reset by continue-as-new, so acceptable — but it is a real
  change, not free.

## Acceptance criteria

- [x] **T1:** a marker whose `type` or `name` disagrees with the command recorded
      at that seq throws `NondeterminismError` naming the seq, the expectation,
      and what history holds.
- [x] **T1:** every existing spec still passes — no false positive on any correct
      workflow, including concurrent branches and detached children.
- [x] **T1:** a spec drives two branches whose order is deliberately perturbed and
      asserts the error, rather than only asserting the happy path.
- [x] **T1:** a spec pins the ordering invariant (command recorded before its
      marker is applied) on the first task and on a later one.
- [ ] **T2:** children validate by name; a history without `childName` still replays.
- [ ] `npm run typecheck`, `npm test`, `npm run lint` clean.

## Note

Tier 1 is the whole point; 2 and 3 are cleanup of the coverage table. If only one
tier ships, it should be Tier 1, and it should ship before `signalStream` is used
for anything real — the API is what makes the failure likely enough to matter.
