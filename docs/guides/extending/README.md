# Extending Guides

How-to guides for **engine contributors** — changing the engine itself
(`core` / `server` / the host entrypoint `index.ts`), not authoring workflows.
Read [structure & layers](../../architecture/structure-and-layers.md) and
[distribution](../../architecture/distribution.md) first.

These guides are anchored to the internals specs in
[`spec/server/`](../../../spec/server/) and the integration specs, which already
exercise the seams a contributor extends.

## Planned guides

| Guide                         | Covers                                                                | Anchor                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Add a durable port adapter    | implement `HistoryStore` / `TaskQueue` / `TimerService`; parity tests | [`spec/server/file_history_store.spec.ts`](../../../spec/server/file_history_store.spec.ts) as the parity model |
| Add a deterministic primitive | thread a new command `protocol → core → server`, keep replay pure     | _planned_                                                                                                       |
| Go distributed                | run the `bin/` mains as separate server + worker processes            | [`spec/integration/distributed.spec.ts`](../../../spec/integration/distributed.spec.ts)                         |

Before writing any of these, confirm the change against
[`PROJECT.md`](../../../PROJECT.md) §6–7 (what's next, and the invariants a new
contributor must respect — markers, sync drain loops, recorded-event determinism).
