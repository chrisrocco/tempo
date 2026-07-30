# Type Model

The `protocol/` types are the contract both sides of the determinism boundary
speak, and (once distributed) the wire format. The modeling choices below favor
readability and let the compiler catch real bugs.

## `protocol` is the wire format

`commands.ts`, `history_events.ts`, `activity_options.ts`, etc. contain **pure
data, no logic, no dependencies**. That's what lets both `core` and `server`
import them without depending on each other, and it's why these same types are
what would serialize to a database row or a queue payload.

## Commands: interface inheritance, not a bare union

```ts
export interface CommandBase { seq: number }

export interface ScheduleActivityCommand extends CommandBase {
  type: 'scheduleActivity'; name: string; args: unknown[]; options: ActivityOptions;
}
export interface StartTimerCommand   extends CommandBase { type: 'startTimer'; ms: number }
export interface StartChildCommand   extends CommandBase { type: 'startChild'; childName: string; childArgs: unknown[] }
export interface ContinueAsNewCommand extends CommandBase { type: 'continueAsNew'; args: unknown[] }

export type Command =
  | ScheduleActivityCommand | StartTimerCommand | StartChildCommand | ContinueAsNewCommand;

// A command as produced by workflow code, before the framework assigns `seq`.
// Written per-variant on purpose: Omit over a union collapses to shared keys.
export type CommandSpec =
  | Omit<ScheduleActivityCommand, 'seq'>
  | Omit<StartTimerCommand, 'seq'>
  | Omit<StartChildCommand, 'seq'>
  | Omit<ContinueAsNewCommand, 'seq'>;
```

Why this shape rather than an inline discriminated union with helper types:

- A **named per-variant interface** for each command means other modules can refer
  to a specific command type directly.
- `CommandBase` documents the shared `seq` once.
- `CommandSpec` (the pre-seq input to `scheduleCommand`) is written as explicit
  per-variant `Omit`s. This is the fix for a real gotcha: `Omit<Command, 'seq'>`
  over a *union* collapses to only the keys common to all members
  (`{ type }`), silently dropping `name`/`ms`/etc. Omitting from each concrete
  interface avoids that. It's more verbose, and deliberately so — no
  `DistributiveOmit` conditional-type helper to decode.

## History events: split by whether they carry a `seq`

```ts
export interface CompletionEventBase { seq: number }

export interface ActivityCompletedEvent extends CompletionEventBase { type: 'activityCompleted'; result: unknown }
export interface ActivityFailedEvent    extends CompletionEventBase { type: 'activityFailed'; error: string }
export interface TimerFiredEvent        extends CompletionEventBase { type: 'timerFired' }
export interface ChildCompletedEvent    extends CompletionEventBase { type: 'childCompleted'; result: unknown }
export interface ChildFailedEvent       extends CompletionEventBase { type: 'childFailed'; error: string }

// Externally injected; not tied to a command, so it carries NO seq.
export interface SignalEvent { type: 'signal'; name: string; payload: unknown }

export type CompletionEvent =
  | ActivityCompletedEvent | ActivityFailedEvent | TimerFiredEvent
  | ChildCompletedEvent | ChildFailedEvent;

export type HistoryEvent = CompletionEvent | SignalEvent;
```

The `CompletionEvent` (has `seq`) vs. `SignalEvent` (no `seq`) split is not
cosmetic — it makes the type structure mirror the runtime logic and cleans up
`applyEvent`:

```ts
function applyEvent(ctx: WorkflowContext, ev: HistoryEvent) {
  if (ev.type === 'signal') { /* route to handler / buffer */ return; }
  // ev is now narrowed to CompletionEvent — `ev.seq` is valid with no assertion
  const waiter = ctx.completions.get(ev.seq);
  ...
}
```

It also lets `SignalEvent` be a plain named export instead of
`Extract<HistoryEvent, { type: 'signal' }>`.

## Generic primitives for call-site typing

- `runActivity<T = unknown>(name, ...args): Promise<T>` and
  `executeChild<T>` / `start<T>` thread the result type through, so
  `await handle.result()` and `await runActivity<string>(...)` aren't `unknown`.
- `proxyActivities<A>(options)` returns a typed proxy: `A` (a record of activity
  signatures) drives inferred argument/return types on each method — the
  compile-time payoff of the proxy. At runtime it's a thin forwarder to
  `runActivity` (see [distribution](../architecture/distribution.md)).

## `ActivityOptions` — declared here, interpreted elsewhere

`ActivityOptions` (timeout, retry policy, task queue) lives in `protocol/` because
it's shared vocabulary, rides on `ScheduleActivityCommand`, and is **interpreted
only by the server** — the core emits it and ignores it. Declared in one layer,
enforced in another, each touching it only as the determinism boundary allows.
