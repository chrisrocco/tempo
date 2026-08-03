# Why an engine, and not a script

Ten things this framework does, what each looks like, and what you would build by
hand without it. The running example is a bug-fixing agent: watch a Buganizer
hotlist, and for each new bug launch an agent that drafts a fix, gets it reviewed,
and submits it.

Everything below is real API except the Buganizer connector, which stands in for
whatever service you talk to.

---

## 1. Durable execution

A workflow is an ordinary async function whose execution survives the process
dying. The engine records an event history and rebuilds state by replaying the
function against it.

```ts
export async function fixBug(bug: Bug): Promise<string> {
  const analysis = await act.analyze(bug); // machine dies here…
  const patch = await act.draftFix(analysis); // …restart resumes HERE,
  return act.submit(bug.id, patch); //     not from the top
}
```

**Without a framework you would have to:**

- Persist progress after every step, in a schema you design, version, and migrate
- Write the resume path — load state, work out which step is next, jump to it —
  and keep that `switch` in sync every time you insert a step
- Make every step idempotent anyway, because after a crash you cannot tell what
  committed
- Accept that dying between "did the work" and "recorded the work" corrupts
  state, or build two-phase commit against systems that do not offer it

The engine's answer to "which step is next" is the function's own control flow.
There is no state machine to keep in sync because there is no state machine.

---

## 2. Watch a hotlist — polling as a stream of events

Polling is a durable loop: fetch, diff against what you have seen, yield the new
ones. `pollStream` owns the timing and the diffing.

```ts
export async function monitorHotlist(
  hotlistId: string,
  seen: string[] = [],
): Promise<void> {
  const known = new Set(seen);

  for await (const bug of pollStream(() => act.listHotlistBugs(hotlistId), {
    every: 5 * 60 * 1000,
    key: (b) => b.id,
    seen: known, // mutated as items are yielded
    until: condition(() => known.size > 500),
  })) {
    startChild('fixBug', { workflowId: `fix-${bug.id}`, args: [bug] });
  }

  return continueAsNew(hotlistId, [...known]); // fresh history, same identity
}
```

Three things are load-bearing and easy to miss:

- **`sleep` inside the poll is durable.** Nothing is pinned in memory between
  ticks. The execution parks, costs nothing, and its timer is re-armed from
  history if the server restarts.
- **`continueAsNew` bounds history.** An infinite loop would otherwise accumulate
  infinite events. This starts a fresh run under the same workflow id, carrying
  only the state you name.
- **The seen-set travels in the arguments.** It has to: continue-as-new discards
  the run's memory, so anything that must outlive a roll-over goes through the
  args. This is the one part `pollStream` cannot hide for you.

**Without a framework you would have to:**

- Deploy a long-lived process and keep it alive — supervisor, restart policy, an
  alert for when the watcher itself is the thing that died
- Store the seen-set durably and reconcile it on restart, or reprocess everything
- Write fetch-and-diff, including what "new" means when a bug is edited rather
  than added
- Back off when the poll fails without losing your place or hammering Buganizer
  through an outage
- Answer "is it still running, and where?" from logs

---

## 3. Fan out — child workflows that compose like calls

Each bug gets its own durable execution. `workflowId` makes the spawn idempotent
against your domain rather than against call order.

```ts
// detached: spawn and keep watching. Claim the same id twice, get one child.
startChild('fixBug', { workflowId: `fix-${bug.id}`, args: [bug] });

// blocking: parks the parent, returns the child's value
const plan = await executeChild<Plan>('planFix', { args: [bug] });

// fan out and wait for all of them
const results = await Promise.all(
  bugs.map((b) => executeChild<string>('fixBug', { args: [b] })),
);
```

**Without a framework you would have to:**

- Spawn a subprocess or task per bug, and stop one crashing from taking the
  parent with it
- Deduplicate yourself, in a way that survives the scanner restarting — seeing
  the same bug twice must not start two agents
- Invent a correlation id and thread it through every log line to make the
  parent/child relationship visible
- Propagate results and failures back across a process boundary
- Decide what happens to fifty in-flight children when the parent dies, then
  implement it

Claim an id that already exists and the engine correlates to that execution
instead of starting a second — returning its result immediately if it has already
finished.

---

## 4. Long-running agents — heartbeats

An agent that thinks for ten minutes is indistinguishable from a dead worker
unless it says otherwise. `heartbeat()` is that statement.

```ts
// activity — the only place I/O is allowed
import { heartbeat } from 'tempo/activity';

export async function runAgent(bug: Bug): Promise<Patch> {
  for (const step of plan(bug)) {
    await step.execute();
    heartbeat(); // call freely — throttled to the wire for you
  }
  return patch;
}

const act = proxyActivities<typeof activities>({
  heartbeatTimeoutMs: 30_000, // silence past this means the worker is gone
});
```

**Without a framework you would have to:**

- Distinguish a slow worker from a crashed one — the hard problem, and the one
  everyone gets wrong first by adding a timeout that kills healthy work
- Build a liveness channel, and resist having a background timer send it: a timer
  keeps beating while the work is wedged, which reports that the process is
  alive and nothing more
- Rate-limit it, so an agent looping over 500 documents does not send 500 pings
- Reclaim work from a genuinely dead worker without handing live work to a second
  one

Each beat renews the attempt's claim, so unbounded work is safe; silence past the
timeout gives up in seconds rather than waiting out a lease.

---

## 5. Retries with a budget that survives the retrier

```ts
const act = proxyActivities<typeof activities>({
  retry: { maximumAttempts: 5, initialIntervalMs: 1_000, backoffCoefficient: 2 },
});
```

**Without a framework you would have to:**

- Write the loop, the backoff, the jitter, the cap
- Keep the attempt count somewhere that outlives the retrier dying mid-backoff —
  a `for` loop's counter does not
- Stop a retry storm from taking down the dependency you are retrying against
- Separate "this attempt failed" from "this operation failed" in logs and alerts

An in-process retry loop hands back a fresh budget every time the process
restarts, so "five attempts" quietly becomes unbounded. Here the count is durable:
five means five.

---

## 6. Humans in the loop — signals and `condition`

Workflows wait for external events without polling and without holding a process.

```ts
const approved = defineSignal('approved');
const changesRequested = defineSignal('changesRequested');

export async function fixBug(bug: Bug): Promise<string> {
  const patch = await act.runAgent(bug);
  await act.requestReview(bug.id, patch);

  let decision: 'approve' | 'revise' | undefined;
  setHandler(approved, () => (decision = 'approve'));
  setHandler(changesRequested, () => (decision = 'revise'));

  await condition(() => decision !== undefined); // days, if it takes days
  return decision === 'approve' ? act.submit(bug.id, patch) : 'sent back';
}
```

**Without a framework you would have to:**

- Expose an endpoint, authenticate it, and map the callback back to the right
  in-flight job
- Persist "waiting for review" so a restart does not lose the wait
- Poll a database for the decision, or build the wake-up path yourself
- Handle the approval arriving _before_ you started listening — the engine
  buffers signals; a naive handler drops them

A parked workflow accrues no history and consumes nothing while it waits. Waiting
three days costs the same as waiting three seconds.

---

## 7. Steer a running agent — a background listener beside the work

An agent working through a ten-stage plan needs to hear "focus on the auth
module" or "stop, wrong approach" _while it works_ — not after. `background`
starts a second line of control that consumes a signal stream for the workflow's
lifetime; the main line reads what it learned between stages.

```ts
const comment = defineSignal('bugComment');

export async function fixBug(bug: Bug): Promise<string> {
  let directive: Directive = 'proceed';
  let finished = false;

  // A second line of control, live for as long as the workflow is.
  const steering = background(async () => {
    for await (const c of signalStream<Comment>(comment, {
      until: condition(() => finished), // a condition IS the stop signal
    })) {
      directive = await act.interpret(c); // "skip auth", "abandon", …
    }
  });

  try {
    for (const stage of PLAN) {
      steering.throwIfFailed(); // a dead listener must not pass silently
      if (directive === 'abandon') return 'abandoned on request';
      await act.runAgentStage(stage, directive);
    }
    return act.submit(bug.id);
  } finally {
    finished = true;
    await steering.done; // drain the backlog before completing
  }
}
```

The two lines talk through an ordinary local variable. There is no state object,
no lock, and no queue, because the engine only ever runs one of them at a time.

What is doing the work here:

- **The interleaving is deterministic.** Branch scheduling is driven entirely by
  history, so the order in which the two lines emit commands reproduces exactly
  on replay. That is what makes concurrency safe in something that gets re-run.
- **`throwIfFailed()` at each checkpoint.** A bare `void (async () => {…})()`
  swallows the branch's failure, and a workflow whose steering died would sail
  on ignoring every instruction — succeeding, silently, while deaf.
- **Nothing is lost or overlapped.** Comments arriving while `interpret` is
  running are queued and delivered next time round; the body never runs
  concurrently with itself; and the backlog is drained when the window closes
  rather than dropped.
- **A crash changes nothing.** The comments are history, so a replay re-delivers
  the same ones in the same order and `directive` lands on the same value.

One constraint worth knowing: a signal has a single consumer, so two streams
cannot both read `bugComment`. Fan out inside the one consumer.

**Without a framework you would have to:**

- Run a listener concurrently with the work and share state safely between them
- Notice when that listener dies — otherwise steering silently stops and the
  agent keeps going with stale instructions
- Not lose comments that arrive mid-stage, and apply them in order
- Persist whatever the listener derived, because a crash loses the thread it was
  running on and every instruction it had consumed
- Re-read the comment feed after a restart _without_ re-applying instructions you
  already acted on
- Reproduce all of this identically when the job is retried, or accept that a
  retried agent may make different decisions from the same inputs

---

## 8. A bad deploy does not lose work

Ship a broken agent, and every execution running it starts failing to replay. The
engine counts the failures, backs off, and **keeps the executions alive**.

```bash
$ tempo describe fix-12345
fix-12345  running

STUCK — 6 consecutive task failures, retrying with backoff
  last error: nondeterminism at seq 0: history has activityScheduled runAgent,
              but the workflow issued startTimer
  the execution is not lost: fix the workflow, redeploy the workers, and it resumes
```

Fix the code, roll the workers, and the wedged executions replay past the throw
and carry on. Nothing is re-run that already ran.

**Without a framework you would have to:**

- Notice — a crash loop in a worker pool is invisible until someone asks why the
  queue is not draining
- Recover the work manually: identify what was in flight, work out how far each
  job got, and restart it from there without repeating side effects
- Accept that a bad deploy loses whatever was mid-flight, and design every job to
  be safely restartable from the top

The engine deliberately never gives up on its own. A failing task is a code bug,
and code is redeployable — auto-terminating would destroy work a fix would have
recovered.

---

## 9. Test the whole thing with no infrastructure

Workflow logic is a pure function of history, so the orchestration is testable
without a server, a network, or a single real API call.

```ts
it('launches one fixer per new bug and none for repeats', async () => {
  const rt = createLocalRuntime()
    .registerActivity('listHotlistBugs', () => [{ id: 'b1' }, { id: 'b1' }])
    .registerWorkflow('fixBug', async () => 'fixed')
    .registerWorkflow('monitorHotlist', monitorHotlist);

  await rt.start('monitorHotlist', ['hotlist-1']).result();

  expect(rt.getHandle('fix-b1').status()).toBe('completed');
});
```

**Without a framework you would have to:**

- Stand up the queue, the database, and the dependent services, or mock all of
  them at the boundary you happen to have
- Wait real seconds for real sleeps, or invent an injectable clock
- Test crash recovery by actually crashing something

This matters most for agents: the orchestration around an LLM call is where the
bugs live, and here you can exercise all of it without paying for a single token.
The same workflow code then runs unchanged in-memory, in one durable process, or
distributed across machines.

---

## 10. See inside a running system

```bash
$ tempo describe fix-12345
fix-12345  running
workflow:  fixBug
waiting on:
  activity  seq=3  runAgent

history (7):
    0  activityScheduled seq=0 analyze(12345)
    1  activityCompleted seq=0
    ...
```

Plus one structured JSON line per lifecycle fact — task latency, attempt counts,
retries scheduled, executions settled — so a run can be aggregated without
parsing prose.

**Without a framework you would have to:**

- Grep logs to reconstruct where a job got to, and be wrong once they roll
- Build a status table and remember to update it at every step, then watch it
  drift from reality
- Answer "stuck or just slow?" by guessing

Everything shown is _derived from history_ rather than stored alongside it, so it
cannot disagree with what actually happened.

---

## Where a plain script is the right call

A pitch that claims everything is suspicious. A script wins when the job is short,
idempotent, and unattended failure is acceptable: a nightly report, a one-shot
migration, anything you would happily just run again.

The engine earns its cost when work is **long-lived**, **spans failures**, **fans
out**, or **must not happen twice**. A hotlist monitor spawning agents is all
four.
