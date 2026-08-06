# 07 — A reused id that discards the caller's arguments is only a log field

**Type:** gap (operability) · **Follows:** PR #31, where this was deferred on
purpose

> **Status: closed, won't do for now.** Decided by the owner: this has not bitten
> anyone, and it will be reopened if it does.
>
> Nothing is broken by closing it. The mismatch is already recorded —
> `execution.start_reused` carries `sameRequest` — so the information exists for
> anyone who goes looking. What the ticket proposed was making it _findable
> without suspecting it first_, which is a real improvement and not an urgent
> one.
>
> The cost of guessing wrong here is what makes waiting the cheap option. A
> warning needs a definition of "different arguments", and the obvious one is
> wrong twice over: `JSON.stringify` comparison is key-order sensitive, and a
> deploy that adds a field to an argument object makes every reused id mismatch
> at once. Both are recorded below. Building it against a real incident means
> the definition gets shaped by a case that actually happened, rather than by a
> guess about which mismatches matter.
>
> **If this is reopened, read the two numbered points below first** — they are
> the reason the naive implementation is misleading rather than merely
> incomplete.

## Problem

A caller-chosen `workflowId` is a claim on a name, so starting twice under one id
returns the existing execution rather than creating a second — see
[`StartWorkflowOptions.workflowId`](../../src/protocol/service.ts). The second
call's **arguments are discarded**, and the execution you get back runs what it
was originally started with.

When the two requests differ, that is almost always a bug in the caller. Today it
is recorded as a field on an ordinary event:

```json
{"event":"execution.start_reused","workflowId":"order-42","sameRequest":false}
```

Which means someone has to already suspect the problem in order to find it.

## Why this was deferred rather than done with the rest

Two reasons, and they are the actual work.

**1. `sameRequest` is too crude to warn on.** It is currently

```ts
JSON.stringify(existing.args) === JSON.stringify(args);
```

`JSON.stringify` is key-order sensitive, so two semantically identical argument
lists built in a different order compare unequal. That is tolerable as a field on
a line someone is already reading, and actively misleading as a warning. This
needs a structural comparison first.

**2. The benign mismatch is systematic, not rare.** A deploy that adds a field to
an argument object makes _every_ reused id mismatch at once, all of them benign.
A warning that lights up on every deploy is one people mute — and muting it costs
the signal for the real case.

## Notes for whoever picks this up

**It is a name, not a level.** [`ports/logger.ts`](../../src/server/ports/logger.ts)
has no severities by design — "events are structured, never formatted… a stable
event name plus fields". So the warning is a distinct event
(`execution.start_conflicted`), and the name _is_ the signal. That part is cheap;
deciding what counts as a mismatch is not.

**Consider the record, not only the log.** A log line nobody greps is barely
better than nothing. A field on the execution — "started again with different
arguments at T" — is the version an operator actually sees, in the detail view
next to the arguments themselves. That is storage, so it is the larger option,
but it is the one that reaches the person who needs it.

## Acceptance criteria

- [ ] Argument comparison is structural rather than string equality, and
      key order does not affect it.
- [ ] A mismatch is distinguishable from an ordinary reuse without knowing which
      field to read.
- [ ] The benign-on-deploy case is considered explicitly — either it does not
      fire, or the ticket records why firing is acceptable.
- [ ] `npm run typecheck` clean; `npm test` green.
