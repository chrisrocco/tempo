# Why you might need this

A narrative, not a feature list. It starts with a small automation any developer
might write this afternoon, adds one reasonable requirement at a time, and
watches the code grow. The point is not that the requirements are exotic — each
one is something you almost certainly want — but that every one of them, met by
hand, turns a page of business logic into a system. Then the same automation is
written against this engine, and the ladder collapses back into a page.

## The idea

When a new bug lands on the team's hotlist, have a coding agent attempt a fix
and open a PR. Wait for CI. Ask a human to review. If they approve, merge; if
CI fails or nobody answers, escalate to the team channel.

That is the whole spec. Five verbs and two decisions.

## The simplest version

A tick function: check the state of the world, do what's new. Run it on an
interval.

```ts
const seen = new Set<string>();

async function tick() {
  for (const bug of await fetchHotlist('my-team')) {
    if (seen.has(bug.id)) continue;
    seen.add(bug.id);

    const pr = await runFixAgent(bug); // opens a PR
    await waitForCi(pr); // poll until green, throw on red
    await requestReview(pr);
    if (await waitForApproval(pr)) await merge(pr);
    else await escalate(bug, 'review declined');
  }
}

setInterval(tick, 5 * 60_000);
```

Twenty lines, and it reads like the spec. Each `await` is a step; the control
flow _is_ the business logic. This is the program you want to have written.

It is also a program that only works on a machine that never restarts, calling
services that never fail, doing work that never overlaps, for a team that never
asks what it's doing. Let's fix that, one reasonable request at a time.

## But you probably want it to survive a restart

`seen` lives in memory. Deploy, crash, or reboot, and the process comes back
knowing nothing — and re-runs the agent on every bug on the hotlist, opening a
second PR for each. So persist it:

```ts
const seen = await loadSeenIds(db); // on boot

// in tick():
seen.add(bug.id);
await db.insert('handled', {bugId: bug.id});
```

Except now the order of those two lines matters. Record the bug _before_ the
work, and a crash mid-fix means the bug is marked handled and never fixed.
Record it _after_, and a crash means the fix runs twice. There is no safe
place for that write, because "handled" was never a boolean — it's a
progression. So the set becomes a table with a status column:

```ts
await db.upsert('fixes', {bugId: bug.id, status: 'fixing'});
const pr = await runFixAgent(bug);
await db.update('fixes', bug.id, {status: 'awaiting-ci', prUrl: pr.url});
await waitForCi(pr);
await db.update('fixes', bug.id, {status: 'awaiting-review'});
// … and so on, a write between every step
```

Every local variable the later steps need (`pr.url`, the CI verdict) has to go
into the row too, because after a restart the row is all there is.

_The tick function is now ~60 lines and owns a schema._

## But you probably want each bug reacted to exactly once

The agent takes forty minutes; the interval is five. Ticks overlap, and two
overlapping ticks both find the same un-handled bug before either records it.
So: a single-flight guard around `tick`, or a claim — an `INSERT` that relies
on a unique constraint to make the second claimant fail cleanly:

```ts
const claimed = await db.tryInsert('fixes', {bugId: bug.id, status: 'fixing'});
if (!claimed) continue; // someone else got it
```

And because the fix steps themselves can now run twice (crash after `merge`
but before the status write, restart, resume from `awaiting-review`), each
step needs to tolerate re-execution: check whether the PR already exists
before opening one, whether the merge already landed before merging.
"Exactly once" quietly became "at least once, plus idempotency everywhere."

_~80 lines, a schema, and a uniqueness invariant you must never migrate away._

## But you probably want retries

The tracker API rate-limits. The agent flakes. CI's status endpoint 500s at
2am. One thrown error currently kills the whole tick — including the loop over
every _other_ bug. So: a retry helper with backoff, a decision about which
errors are worth retrying, a cap on attempts — and the attempt count has to be
_persisted_, or a crash-loop resets the budget and retries forever:

```ts
async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const attempt = await db.bumpAttempt('attempts', key);
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      await sleepMs(backoff(attempt)); // 2s, 4s, 8s… and the process is
    } // pinned here the whole time
  }
}
```

Wrap every call site. Add a `try/catch` per bug so one failure doesn't starve
the rest. Decide what a permanently-failed fix's status is, and who gets told.

_~130 lines. The business logic is still in there somewhere._

## But you probably want to wait longer than a process lives

CI takes twenty minutes. Review takes days. The code above waits by keeping an
`await` open — which means keeping the _process_ open, which means a deploy or
a crash abandons every wait in flight. Nobody notices, because a lost `await`
makes no sound: bug 4712 just never merges.

This is the requirement that kills the straight-line function. You cannot hold
program state across a process boundary, so the waits invert: instead of the
code waiting inside step three, the code must _end_, and something must later
figure out that step three is where to resume. The tick function becomes a
dispatcher over the status column:

```ts
async function tick() {
  await claimNewBugs();
  for (const fix of await db.rows('fixes', {open: true})) {
    switch (fix.status) {
      case 'fixing':
        return resumeOrRestartAgent(fix);
      case 'awaiting-ci':
        return checkCiAndMaybeAdvance(fix);
      case 'awaiting-review':
        return nudgeOrTimeout(fix);
      case 'approved':
        return mergeAndClose(fix);
      // …
    }
  }
}
```

Notice what happened: the program you wanted to write — first this, then that,
then if-approved-merge — no longer exists anywhere in the source. It is
smeared across status values and case arms, and every future change means
updating a diagram that lives only in your head. This shape has a name:
you have hand-rolled a state machine, and the state machine _is_ the
control flow you used to get for free from `async/await`.

_~220 lines. The spec is no longer legible in the code._

## But you probably want the human's answer delivered, not polled for

"Wait for approval" is not a status you can poll from a loop — it's an event
from outside. So: a webhook endpoint. Which needs a route, and a correlation
id so the approval finds the right row, and an answer for the race where the
webhook arrives _while_ a tick is mid-transition on the same row, and an
answer for the approval that arrives _before_ the row reaches
`awaiting-review` — buffer it? drop it? — because reviewers are faster than
you think.

```ts
app.post('/webhooks/review', async (req) => {
  const fix = await db.lockRow('fixes', req.body.correlationId); // races…
  if (fix.status !== 'awaiting-review') {
    await db.insert('pending_events', req.body); // …buffering…
    return;
  }
  await db.update('fixes', fix.bugId, {
    status: req.body.approved ? 'approved' : 'declined',
  });
});
```

You now run an HTTP server, and every status transition has to check the
buffered-events table, and the lock ordering between the webhook and the tick
is load-bearing and untested.

_~300 lines across two processes._

## But you probably want deadlines, because sometimes nobody answers

The agent hangs. The reviewer is on vacation. CI's webhook was dropped. A
workflow that waits forever is indistinguishable from one that's making
progress — so every wait needs a deadline, and deadlines that survive
restarts can't be `setTimeout`. They're rows: a `timers` table with a due-at
column and a sweeper in the tick that fires overdue ones. And for the hung
agent specifically, a deadline isn't even enough — slow and dead look
identical from outside, so the agent has to report liveness ("heartbeat") and
the sweeper has to distinguish "no heartbeat for 5m: dead, retry it" from
"heartbeating for 3h: slow, leave it."

_~380 lines, three tables, and a sweeper with edge cases you'll meet in prod._

## But you probably want to cancel one

A bug gets closed as working-as-intended while the fix is mid-flight. "Just
stop it" means: find every piece of in-flight work for that bug — the agent
run, the CI wait, the pending timers, the buffered events — stop each, don't
merge a PR whose bug was cancelled _during_ the approval race, and release
the claim in a state that says "cancelled" rather than "failed, please retry."
Cancellation touches every case arm you've written and every one you'll write
next. It's not a feature; it's a tax on all of them.

_~450 lines. Every arm now checks a `cancelled` flag it might be too late to see._

## But you probably want more than one machine

For throughput, or just so a deploy isn't an outage. The moment there are two
workers, the tick can't be a loop over a table both can see — it's a queue:
tasks with leases, so a worker that dies mid-task has its work redelivered to
another, after a visibility timeout you must tune (too short: duplicate work;
too long: dead work sits an hour). Redelivery means everything can run twice
_concurrently_, not just in sequence — so the idempotency from rung two gets
audited again under a harsher model. You are now maintaining a small
distributed system, and its correctness argument lives in a comment.

_~600 lines, plus a queue, plus the comment._

## But you probably want to see what it's doing

The first question anyone asks: "why hasn't 4712 merged?" The status column
says `awaiting-review` — since when? after how many retries? waiting on whom?
So every transition starts writing an audit row, and you build the little
endpoint that reassembles a bug's story from them, and you are one afternoon
from discovering you're building a `describe()` — a projection of "what
happened and what is it waiting on" — because operating the system without one
turned out to be impossible.

## But you probably want to deploy new code while fixes are in flight

Add a canary step between merge and close. Easy — except thirty fixes are
mid-flight in states your new `switch` handles differently, and one is in a
state the new code deleted. Now every risky deploy needs either a migration
for in-flight rows, a version column consulted by every case arm, or a drain
("stop claiming, wait for all fixes to finish, deploy" — days, per the
previous rung). The state machine's states are now a public interface between
versions of your own program.

## But you probably want to test any of this

The logic is smeared across a schema, a queue, a webhook server, a sweeper,
and a version column. Unit tests can't reach it without standing all of that
up; integration tests want to "wait three days" and need a fake clock injected
under everything that reads time. The seams you'd need were never designed in,
so the tests either take minutes or mock so much they test the mocks.

## The tally

Count what the twenty-line tick function has become:

- a schema: fixes, attempts, timers, audit rows, buffered events
- a claim protocol and an idempotency audit
- a retry helper with persisted budgets
- a hand-rolled state machine nobody can read the spec from
- a webhook server with a buffering rule and a lock ordering
- a sweeper that reasons about heartbeats
- cancellation checks in every arm
- a queue with leases and a tuned visibility timeout
- an audit log and the endpoint that reassembles it
- a versioning discipline for in-flight state
- a test harness that virtualizes time

None of it is your product. All of it is load-bearing. And the five verbs and
two decisions you started with are no longer written down anywhere — they're
implied by the union of the case arms, which is exactly where the next bug
lives. Every team that ships one of these ends up here, because the ladder
wasn't optional: each rung was something you genuinely wanted.

## Or: write it in Tempo

Here is the same automation, whole, against this engine. Activities are the
only place I/O happens; workflows are deterministic orchestration the engine
can kill and replay at any `await`.

```ts
// activities.ts — ordinary async functions; the only place I/O is allowed
export async function fetchHotlist(hotlist: string): Promise<Bug[]> {…}
export async function runFixAgent(bug: Bug): Promise<{prUrl: string}> {…}
export async function ciStatus(prUrl: string): Promise<'pending' | 'green' | 'red'> {…}
export async function requestReview(prUrl: string): Promise<void> {…}
export async function merge(prUrl: string): Promise<void> {…}
export async function escalate(bug: Bug, why: string): Promise<void> {…}
```

```ts
// workflows.ts — deterministic; survives a crash at any await
import {
  byId,
  condition,
  createWorkflow,
  defineSignal,
  pollForever,
  proxyActivities,
  setHandler,
  sleep,
} from 'workflow-engine/workflow';
import * as tracker from './activities';

const act = proxyActivities(tracker, {
  retry: {maximumAttempts: 5, initialIntervalMs: 2_000},
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const reviewed = defineSignal('reviewed');

export const fixBug = createWorkflow('fixBug', async (bug: Bug) => {
  const {prUrl} = await act.runFixAgent(bug);

  let ci = await act.ciStatus(prUrl);
  while (ci === 'pending') {
    await sleep(MINUTE); // durable: survives restarts and deploys
    ci = await act.ciStatus(prUrl);
  }
  if (ci === 'red') return act.escalate(bug, `CI failed on ${prUrl}`);

  await act.requestReview(prUrl);
  let verdict: boolean | undefined;
  setHandler(reviewed, (ok: boolean) => void (verdict = ok));
  let expired = false;
  void sleep(3 * DAY).then(() => void (expired = true));
  await condition(() => verdict !== undefined || expired);

  if (verdict) return act.merge(prUrl);
  return act.escalate(bug, verdict === false ? 'review declined' : 'no review in 3 days');
});

export const watchHotlist = createWorkflow('watchHotlist', (hotlist: string) =>
  pollForever({
    everyMs: 5 * MINUTE,
    poll: () => act.fetchHotlist(hotlist),
    differ: byId((bug: Bug) => bug.id),
    startFrom: 'new', // don't fix the 500-bug backlog on day one
    onAdded: (bug) => void fixBug.detached([bug], {workflowId: `fix-${bug.id}`}),
  }),
);
```

```ts
// worker.ts — the deployable artifact, whole
import {Tempo} from 'workflow-engine';
import * as activities from './activities';
import {watchHotlist} from './workflows';

Tempo.startWorker({name: 'autofix', activities, workflows: {watchHotlist}});
```

Roughly the size of the original tick function, and it reads like the spec
again: first the fix, then CI, then review, then the decision. The control
flow is `async/await`, not a status column — the straight-line program you
wanted to write on page one is the one that ships.

Now walk back down the ladder:

- **Survive a restart** — the engine records an event history and rebuilds any
  execution by replaying the function against it. Kill the worker at any
  `await`; it resumes there. No schema, no status column: the _program
  counter_ is what's durable.
- **Exactly once** — `workflowId: 'fix-4712'` is a claim, deduplicated at the
  server. However many pollers, replays, or restarts ask, there is one fix per
  bug. Activity effects are at-least-once with recorded outcomes — the honest
  contract, stated instead of discovered.
- **Retries** — `retry: {maximumAttempts: 5}` on the proxy. The budget is
  counted on the server against the execution record, so a worker dying
  mid-backoff doesn't reset it.
- **Waits longer than a process** — `sleep(3 * DAY)` is a durable timer,
  re-armed from history on restart. It costs nothing to hold open and no
  process has to stay alive for it.
- **Delivered events** — `defineSignal` / `setHandler` / `condition`. A signal
  that arrives before the handler is set is buffered; correlation is the
  `workflowId`; your webhook handler shrinks to one line calling
  `client.signal('fix-4712', reviewed, true)`.
- **Deadlines** — the timer raced with the condition, above, in two lines of
  ordinary code. For hung _activities_, `startToCloseTimeoutMs` and
  `heartbeat()` let the server tell slow from dead.
- **Cancellation** — `client.cancel('fix-4712')` unwinds the workflow through
  whatever it awaits and cascades to children by policy. No flag to check in
  every arm.
- **More machines** — run the worker binary more times; the server's task
  queues own leases, redelivery, and the race where two workers grab one task
  (replay makes the loser's work safe to discard). Your code doesn't change.
- **Seeing what it's doing** — `describe` returns status, history, and what an
  execution is _currently waiting on_, derived from the same history that
  drives replay — so it can't drift from the truth. The lifecycle log is
  structured JSON Lines.
- **Deploying mid-flight** — `patched('add-canary')` records, per execution,
  which side of a code change it took, so old and new histories replay
  correctly from one source. And when a change does slip through, replay
  detects the divergence and stops rather than publishing a corrupted state.
- **Bounded storage** — `continueAsNew` sheds a long-lived workflow's history
  (`pollForever` does it for you); `--retain-closed-for-days` expires closed
  executions.
- **Testing** — the same workflow code runs in `createLocalRuntime()`,
  in-memory, no server, fast enough for the inner loop; `worker.js
--local=fixBug` smoke-tests the built artifact in CI. The determinism
  boundary that makes replay sound is the same seam that makes the logic
  testable — workflow code _can't_ secretly depend on the wall clock, so
  nothing needs to be faked out from under it.

The ladder didn't get shorter — every rung is still real work. It's just that
each one is solved once, in the engine, behind the replay mechanism that makes
all of them the same problem: record what happened, and reconstruct any
execution from the record. That is the entire trick, and
[README.md](README.md) and the source walk through how it's built — this is a
reference implementation, small enough to actually read, so when you want to
know _why_ the durable version of your tick function can be twenty lines
again, the answer is in the next file over.
