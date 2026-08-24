/**
 * @fileoverview
 * ★ PROTOCOL ENTRYPOINT — the wire format, and the small number of predicates
 * that read it. Pure data and contracts: no logic, no dependencies, no layer
 * beneath it (`protocol: []` in `tools/boundaries.ts`).
 *
 * ```ts
 * import {isStuck, type ExecutionDetail} from 'workflow-engine/protocol';
 * ```
 *
 * ## Who imports this, and why it is a separate path
 *
 * Anything that reads an execution without running one: a dashboard, an
 * operator CLI, a supervisor's deploy check, a test asserting on history. It is
 * browser-safe by construction and checked to stay that way
 * (`BROWSER_SAFE_ENTRYPOINTS`), which is the point of it being reachable
 * without `workflow-engine` — that barrel exports a server and a file-backed
 * store, and a bundler follows a barrel whole.
 *
 * It is also the surface most likely to be depended on and least likely to look
 * like a dependency. A change to a type or a predicate here is a **wire-format**
 * break — see the contract table in [`README.md`](../../README.md#what-is-contract-and-what-is-not)
 * — and lands like a schema migration rather than a rename.
 *
 * ## Where each idea is documented
 *
 * The types are grouped by what they describe, and each module carries the
 * reasoning for its own group rather than repeating it here:
 *
 * | Module | Owns |
 * | --- | --- |
 * | `service.ts` | the read model — `ExecutionSummary`, `ExecutionDetail`, filters, paging, worker liveness, and the predicates below |
 * | `history_events.ts` | the event vocabulary, and the four families it splits into (completions, markers, informational, signals) |
 * | `commands.ts` | what a workflow task asks the server to do |
 * | `rpc.ts` | the request union both transports dispatch through |
 * | `schedule.ts` | schedule specs and their state |
 * | `workflow_descriptor.ts` | what a worker reports it can run |
 * | `activity_options.ts`, `parent_close_policy.ts`, `task_token.ts` | one idea each, named for it |
 *
 * ## The predicates are here on purpose
 *
 * `isStuck`, `isQueueServed`, `isNameServed` and `workersServing` are the only
 * behaviour on this path, and they earn the exception by being judgements two
 * readers must agree on. "Stuck" computed independently in a UI is a second
 * definition of the word, drifting from the engine's the first time either
 * changes; shipping the predicate makes the vocabulary the shared thing rather
 * than the data alone. They stay pure functions of a value already on the wire,
 * which is what keeps them from becoming a client library.
 */

export * from './activity_options';
export * from './commands';
export * from './history_events';
export * from './parent_close_policy';
export * from './rpc';
export * from './schedule';
export * from './service';
export * from './task_token';
export * from './workflow_descriptor';
