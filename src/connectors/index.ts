/**
 * @fileoverview
 * ★ CONNECTORS ENTRYPOINT — what connector authors and workflow builders import.
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
 * This repo carries zero runtime dependencies, so the framework could not adopt
 * Zod even if it wanted to — and it doesn't want to. Operations accept the
 * schema library's **validator port** (see `src/libraries/schema/index.ts` for
 * its contract): validate, optional `toJsonSchema`, inference on the generic
 * parameters. `t` is the first-party builder — the default authoring surface,
 * rendering natively — and `standard()` adapts any Standard Schema vendor in
 * one call for teams that would rather write Zod. Both are re-exported here so
 * a connector author needs one import root.
 * The same decoupling move `protocol/workflow_descriptor.ts` made for workflow
 * metadata, applied to validation.
 */

export {
  standard,
  strictProblems,
  t,
  type InferInput,
  type InferOutput,
  type JsonSchema,
  type Schema,
  type SchemaIssue,
  type SchemaResult,
  type StandardSchemaV1,
} from '../libraries/schema';
export {
  ConnectorError,
  type ConnectorErrorEnvelope,
  type ConnectorErrorKind,
} from './errors';
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
