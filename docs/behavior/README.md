# Behavior

**What the engine guarantees — proven by the test suite.** The specs _are_ the
executable documentation for behavior, so this page does not re-narrate what they
assert; it's a map from each capability to the spec that pins it. Read the linked
spec for the authoritative, always-current guarantees (they run in CI; prose here
would just drift).

The convention that keeps these specs readable as documentation — `describe` names
a capability, each `it` is a full sentence stating one guarantee — is described in
[testing conventions](../contributing/testing-conventions.md).

## The programming model

[`spec/integration/local.spec.ts`](../../spec/integration/local.spec.ts) is the
canonical behavior spec — the whole author-facing model against
`createLocalRuntime`. **Start here to understand what the engine does.**

| Capability                               | Concept                                                                  | `describe` block in `local.spec.ts`         |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Activities (dispatch, ordering, failure) | [replay & execution](../concepts/replay-and-execution.md)                | `local runtime — activities`                |
| `proxyActivities` + retries              | [distribution](../architecture/distribution.md) (options)                | `local runtime — proxyActivities & retries` |
| Signals & `condition`                    | [conditions, signals & timers](../concepts/conditions-signals-timers.md) | `local runtime — signals and condition`     |
| Child workflows                          | —                                                                        | `local runtime — child workflows`           |
| Cancellation (+ cascade)                 | [conditions, signals & timers](../concepts/conditions-signals-timers.md) | `local runtime — cancellation`              |
| `continueAsNew`                          | [continue-as-new](../concepts/continue-as-new.md)                        | `local runtime — continueAsNew`             |
| Timers (duration ordering)               | [conditions, signals & timers](../concepts/conditions-signals-timers.md) | `local runtime — timers`                    |

## Engine internals & durability

These specs prove the guarantees behind the [architecture](../architecture/) docs
rather than the author-facing model:

| Guarantee                                                                | Spec                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Retry arithmetic (attempts, backoff cap)                                 | [`spec/server/retry_policy.spec.ts`](../../spec/server/retry_policy.spec.ts)             |
| Durable timer fire / cancel / startup re-arm                             | [`spec/server/timer_service.spec.ts`](../../spec/server/timer_service.spec.ts)           |
| Durable persistence + single-writer lockfile                             | [`spec/server/file_history_store.spec.ts`](../../spec/server/file_history_store.spec.ts) |
| Optimistic version CAS, lease-expiry redelivery, lease-race rejection    | [`spec/server/concurrency.spec.ts`](../../spec/server/concurrency.spec.ts)               |
| Crash recovery: resume mid-flight from history                           | [`spec/integration/resume.spec.ts`](../../spec/integration/resume.spec.ts)               |
| Client → RemoteService → HTTP → server → workers (one process)           | [`spec/integration/remote.spec.ts`](../../spec/integration/remote.spec.ts)               |
| Real spawned server + worker processes; crash redelivery / at-least-once | [`spec/integration/distributed.spec.ts`](../../spec/integration/distributed.spec.ts)     |

For the count and one-line summary of each spec, see
[`PROJECT.md` §5](../../PROJECT.md).
