# Getting Started

Build and run your first workflow, end to end, using the workflow the whole
project was designed around: a **bug hotlist monitor** that keeps one child
monitor running per active bug — spawning one when a bug is added, cancelling it
when the bug is removed.

The complete, runnable source is
[`examples/bug_hotlist_monitor.ts`](../../examples/bug_hotlist_monitor.ts), and it
is exercised by
[`spec/examples/bug_hotlist_monitor.spec.ts`](../../spec/examples/bug_hotlist_monitor.spec.ts).
This guide walks you through that example — it is the source of truth; the snippets
below are excerpts.

## Run it

```bash
npm test
```

That runs the whole suite (including the hotlist-monitor spec) under Jasmine +
`tsx`. To typecheck:

```bash
npm run typecheck
```

## The shape of a workflow

A workflow is an ordinary `async` function that calls only deterministic
primitives from `workflow.ts` — never I/O directly. The per-bug monitor loops
forever until it's cancelled, doing its side-effecting work through an
**activity** (`checkBug`):

```ts
export async function bugMonitor(bugId: string): Promise<void> {
  for (;;) {
    await runActivity('checkBug', bugId); // the only place I/O happens
    await sleep(5);
  }
}
```

Why an activity? Because the workflow function must be replayable
([the determinism boundary](../concepts/determinism-boundary.md)) — anything with
side effects is pushed across the line into an activity.

## The signal + `condition` + queue pattern

The hotlist monitor receives the outside world as **signals** and reacts using
`condition`. The discipline that makes this reliable — *handlers only enqueue; the
loop acts* — is explained in
[conditions, signals & timers](../concepts/conditions-signals-timers.md):

```ts
setHandler(diffSignal, (d: BugDiff) => queue.push(d)); // handler only enqueues
setHandler(stopSignal, () => { stopped = true; });

for (;;) {
  await condition(() => queue.length > 0 || stopped); // park until something changes
  // ...drain the queue: `add` spawns a child monitor, `remove` cancels one...
  if (stopped) { /* cancel survivors */ return everMonitored; }
}
```

`startChild` launches a fire-and-forget child monitor; the returned handle's
`.cancel()` tears it down on removal or stop. See the full drain loop in the
example.

## Wiring a runtime

`createLocalRuntime()` registers the activities and workflows and gives you an
in-process runtime to start and signal:

```ts
const rt = bugHotlistRuntime((bugId) => checks.push(bugId));
const handle = rt.start<string[]>('hotlistMonitor');
handle.signal('diff', { bugId: 'BUG-1', action: 'add' });
// ...later...
handle.signal('stop');
const monitored = await handle.result();
```

The spec drives exactly this sequence and asserts the guarantees — that the test
*terminates at all* is itself proof cancellation works, since the child monitors
loop forever otherwise.

## Where to go next

- [Overview](../concepts/overview.md) and [the determinism
  boundary](../concepts/determinism-boundary.md) — the mental model underneath all
  of this.
- [Behavior](../behavior/README.md) — the full set of guarantees, each linked to
  the spec that proves it.
- [authoring/](authoring/) — how-to guides for the individual primitives.
