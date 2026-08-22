/**
 * @fileoverview
 * ★ CONNECTORS ENTRYPOINT — what connector authors and workflow builders import.
 * Developer documentation — why, quickstart, concepts — is `README.md` in this
 * directory; this comment carries only what an entrypoint owes its reader.
 *
 * A connector wraps one service as queries (reads), commands (writes with a
 * declared idempotency story), and triggers (facts consumed in-workflow as
 * watchers: a poller child that signals its parent one event at a time). One
 * `defineConnector` value derives every surface: the typed workflow proxy
 * (`use()`), plain bound handlers for composing inside a custom activity
 * (`direct()`), explicit maps for the local runtime and list-everything workers
 * (`registrations()`), and the dashboard catalogue (`catalogue()`).
 *
 * ## This surface is part of the author entrypoint, by intent
 *
 * `use()` is called at module scope of a workflow module, exactly like
 * `proxyActivities` — declaring is registering. A consumer lint that holds
 * workflow modules to "import only the author surface" should treat
 * `workflow-engine/connectors` as part of that surface; this layer's own
 * boundary declaration (it may import nothing but `workflow.ts`) is what makes
 * that safe to say.
 *
 * ## No schema vendor, deliberately
 *
 * This repo carries zero runtime dependencies, and schemas are no exception:
 * operations are authored with `t`, the schema library's first-party builder
 * (see `src/libraries/schema/index.ts` for its contract) — validation, JSON
 * Schema rendering, and inferred types in one vocabulary sized to what the
 * catalogue can render, re-exported here so a connector author needs one
 * import root. Underneath sits the library's validator port, kept as the
 * revisit seam should an external vendor ever earn its place.
 */

export {
  strictProblems,
  t,
  type InferInput,
  type InferOutput,
  type JsonSchema,
  type Schema,
  type SchemaIssue,
  type SchemaResult,
} from '../libraries/schema';
export {
  ConnectorError,
  type ConnectorErrorEnvelope,
  type ConnectorErrorKind,
} from './errors';
// A watch handle throws this when its poller child dies on a terminal poll
// failure — the subscription ends loudly, at the `await` that depended on it.
export {WatcherFailedError} from '../workflow';
export {
  command,
  ops,
  query,
  trigger,
  type CommandDef,
  type ConnectorSpec,
  type Idempotency,
  type PollArgs,
  type QueryDef,
  type TriggerDef,
} from './definition';
export {configureConnectors} from './runtime';
export {
  defineConnector,
  toMs,
  type Connector,
  type ConnectorProxy,
  type Registrations,
  type UseOptions,
  type WatchHandle,
  type WatchOptions,
  type WireResult,
} from './connector';
export {catalogue, type CatalogueEntry} from './catalogue';
export {
  planLiveSuite,
  runLivePlan,
  type CommandCertification,
  type CommandCtx,
  type LiveCase,
  type LiveCtx,
  type LiveFailure,
  type LiveFixtures,
  type LiveOptions,
  type LivePlan,
  type LiveRegistrar,
  type TriggerCertification,
} from './live';
