/**
 * @fileoverview
 * `defineConnector` — where one definition becomes its derived surfaces.
 *
 * - `use()`     the workflow-facing proxy: `query.*` / `command.*` / `watch.*`,
 *               registered via `proxyActivities`/`createWorkflow` so loading a
 *               workflow module wires its worker (tempo's own pattern).
 * - `direct()`  the same handlers as plain bound functions, for composing
 *               several calls inside one custom activity.
 * - `registrations()`  explicit maps for `createLocalRuntime` and for workers
 *               that prefer naming what they serve.
 *
 * ## The envelope
 *
 * The engine's retry policy is attempts-and-backoff with no non-retryable
 * classification, so the activity wrapper implements one: every operation
 * completes with `{ok: true, value}` or, for a non-retryable `ConnectorError`,
 * `{ok: false, error}` — and the workflow-side proxy rethrows the latter as a
 * typed error. Retryable errors throw through to the server, which applies the
 * kind's retry policy. History therefore records a structured envelope either
 * way, which is what lets a dashboard render a fail-fast error it finds in an
 * `activityCompleted` event.
 *
 * ## Watchers
 *
 * `watch.<trigger>(opts)` spawns one generic-per-connector poller child
 * (`pollForever` over a `byCursor` differ on `eventId`) with a deterministic
 * child id, `parentClosePolicy: 'terminate'`, and events delivered home as
 * signals — `signalWorkflow` being a recorded command is what makes delivery
 * once-per-event. The handle wraps `signalStream`.
 */

import {
  byCursor,
  createWorkflow,
  pollForever,
  proxyActivities,
  signalStream,
  signalWorkflow,
  startChild,
  workflowInfo,
  type ActivityOptionsInput,
  type AnyWorkflowFn,
  type WorkflowRef,
} from '../workflow';

import type {
  AnyCommandDef,
  AnyQueryDef,
  AnyTriggerDef,
  CommandDef,
  ConnectorSpec,
  QueryDef,
  TriggerDef,
} from './definition';
import {ConnectorError, type ConnectorErrorEnvelope} from './errors';
import {resolveContext} from './runtime';
import {runSchema, type StandardSchemaV1} from '../libraries/schema';

/** What every operation activity returns: JSON-safe, lives in history. */
export type WireResult<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly error: ConnectorErrorEnvelope};

/* -------------------------------------------------------------------------- */
/* Author-facing surface types                                                */
/* -------------------------------------------------------------------------- */

type In<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
type Out<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

// Structural infer over {input, output} rather than over the def generics:
// immune to Ctx variance, and it is genuinely all a call site needs to know.
export type QuerySurface<Q> = {
  [K in keyof Q]: Q[K] extends {
    input: infer I extends StandardSchemaV1;
    output: infer O extends StandardSchemaV1;
  }
    ? (input: In<I>) => Promise<Out<O>>
    : never;
};

export type CommandSurface<C> = QuerySurface<C>;

export interface WatchOptions<F> {
  /** Poll interval: milliseconds, or `'30 seconds'`-style text. */
  every: number | string;
  /** Forwarded to the trigger's poll, so the service filters at the source. */
  where?: F;
  /**
   * `'new'` (default): the first poll is the baseline; only later events fire.
   * `'all'`: everything currently in the feed counts as new.
   * `{cursor}`: resume from a cursor you carried (e.g. across continueAsNew).
   */
  start?: 'all' | 'new' | {cursor: string | number};
  /** Names the subscription when one workflow watches the same trigger twice. */
  as?: string;
}

export interface WatchHandle<E> extends AsyncIterable<E> {
  /** Park until the next event. */
  next(): Promise<E>;
  /** Cancel the poller child. */
  stop(): void;
  /** For composing with `firstSignal` / `condition` directly. */
  readonly signalName: string;
}

type TriggerFilterOf<D> = D extends {filter?: infer F}
  ? NonNullable<F> extends StandardSchemaV1
    ? Out<NonNullable<F>>
    : undefined
  : undefined;

export type WatchSurface<T> = {
  [K in keyof T]: T[K] extends {event: infer E extends StandardSchemaV1}
    ? (options: WatchOptions<TriggerFilterOf<T[K]>>) => WatchHandle<Out<E>>
    : never;
};

export interface ConnectorProxy<Q, C, T> {
  readonly query: QuerySurface<Q>;
  readonly command: CommandSurface<C>;
  readonly watch: WatchSurface<T>;
}

/** `use()`-level overrides, applied beneath per-operation `options`. */
export interface UseOptions {
  taskQueue?: string;
}

export interface Registrations {
  readonly activities: Record<string, (input: unknown) => Promise<unknown>>;
  readonly workflows: Record<string, AnyWorkflowFn>;
}

export interface Connector<
  Cfg,
  Ctx,
  Q extends Record<string, AnyQueryDef<Ctx>>,
  C extends Record<string, AnyCommandDef<Ctx>>,
  T extends Record<string, AnyTriggerDef<Ctx>>,
> {
  readonly spec: ConnectorSpec<Cfg, Ctx, Q, C, T>;
  use(options?: UseOptions): ConnectorProxy<Q, C, T>;
  direct(): {
    readonly query: QuerySurface<Q>;
    readonly command: CommandSurface<C>;
  };
  registrations(): Registrations;
}

/* -------------------------------------------------------------------------- */
/* Kind-derived defaults                                                      */
/* -------------------------------------------------------------------------- */

const QUERY_DEFAULTS: ActivityOptionsInput = {
  retry: {
    maximumAttempts: 5,
    initialIntervalMs: 500,
    backoffCoefficient: 2,
    maximumIntervalMs: 30_000,
  },
  startToCloseTimeoutMs: 30_000,
};

const COMMAND_DEFAULTS: ActivityOptionsInput = {
  retry: {
    maximumAttempts: 5,
    initialIntervalMs: 500,
    backoffCoefficient: 2,
    maximumIntervalMs: 30_000,
  },
  startToCloseTimeoutMs: 120_000,
};

/** Unsafe commands get exactly one attempt, whatever else is configured. */
const UNSAFE_OVERRIDE: ActivityOptionsInput = {retry: {maximumAttempts: 1}};

function mergeOptions(
  ...layers: (ActivityOptionsInput | undefined)[]
): ActivityOptionsInput {
  const merged: ActivityOptionsInput = {};
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(merged, layer);
    if (layer.retry) {
      merged.retry = {...(merged.retry ?? {}), ...layer.retry};
    }
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Duration text — a deliberately tiny parser                                 */
/* -------------------------------------------------------------------------- */

const DURATION =
  /^(\d+)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)$/;

export function toMs(every: number | string): number {
  if (typeof every === 'number') return every;
  const m = DURATION.exec(every.trim());
  if (!m) throw new Error(`unparseable duration: '${every}'`);
  const unit = m[2]!;
  const factor =
    unit === 'ms' || unit.startsWith('milli')
      ? 1
      : unit.startsWith('s')
        ? 1_000
        : unit.startsWith('m')
          ? 60_000
          : 3_600_000;
  return Number(m[1]) * factor;
}

/* -------------------------------------------------------------------------- */
/* The wrapper: one operation definition -> one activity implementation        */
/* -------------------------------------------------------------------------- */

interface OpLike {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly handler: (input: never, ctx: never) => unknown;
}

function activityImplFor(
  spec: ConnectorSpec,
  opName: string,
  def: OpLike,
): (input: unknown) => Promise<WireResult<unknown>> {
  return async (input: unknown) => {
    const ctx = await resolveContext(spec);
    const parsedIn = await runSchema(def.input, input);
    if (!parsedIn.ok) {
      return fail('invalid', `${opName}: ${parsedIn.message}`);
    }
    try {
      const raw = await def.handler(parsedIn.value as never, ctx as never);
      const parsedOut = await runSchema(def.output, raw);
      if (!parsedOut.ok) {
        // The service answered, but not in the declared shape: contract drift.
        return fail('drift', `${opName}: response ${parsedOut.message}`);
      }
      return {ok: true as const, value: parsedOut.value};
    } catch (e) {
      if (e instanceof ConnectorError && !e.retryable) {
        return {ok: false as const, error: e.toEnvelope()};
      }
      throw e; // retryable (or unclassified): let the server's policy decide
    }
  };
}

function fail(
  kind: ConnectorErrorEnvelope['kind'],
  message: string,
): WireResult<never> {
  return {ok: false, error: {kind, message}};
}

function unwrap<T>(result: WireResult<T>): T {
  if (result.ok) return result.value;
  throw ConnectorError.fromEnvelope(result.error);
}

/* -------------------------------------------------------------------------- */
/* Watcher: the generic per-connector poller child                             */
/* -------------------------------------------------------------------------- */

interface WatcherProps {
  trigger: string;
  parentId: string;
  signalName: string;
  everyMs: number;
  filter?: unknown;
  start: 'all' | 'new' | {cursor: string | number};
}

interface FeedItem {
  id: string | number;
  event: unknown;
}

/* -------------------------------------------------------------------------- */
/* defineConnector                                                            */
/* -------------------------------------------------------------------------- */

export function defineConnector<
  Cfg,
  Ctx,
  Q extends Record<string, AnyQueryDef<Ctx>>,
  C extends Record<string, AnyCommandDef<Ctx>>,
  T extends Record<string, AnyTriggerDef<Ctx>>,
>(spec: ConnectorSpec<Cfg, Ctx, Q, C, T>): Connector<Cfg, Ctx, Q, C, T> {
  const anySpec = spec as unknown as ConnectorSpec;
  const queries = spec.queries ?? ({} as Q);
  const commands = spec.commands ?? ({} as C);
  const triggers = spec.triggers ?? ({} as T);

  const wireName = (op: string) => `cnx.${spec.name}.${op}`;
  const pollName = (t: string) => `cnx.${spec.name}.poll.${t}`;
  const watcherKey = `cnx.${spec.name}.watch`;

  /**
   * Built once, lazily: the raw activity implementations, the poll proxies the
   * watcher closes over, and the watcher workflow itself. `use()` and
   * `registrations()` share these so both paths serve identical code.
   */
  interface Parts {
    activities: Record<string, (input: unknown) => Promise<unknown>>;
    pollProxies: Record<
      string,
      (args: {
        cursor: string | number | undefined;
        filter: unknown;
      }) => Promise<WireResult<readonly FeedItem[]>>
    >;
    watcher: WorkflowRef<(props: WatcherProps) => Promise<void>>;
  }
  let parts: Parts | undefined;

  function build(): Parts {
    if (parts) return parts;

    const activities: Parts['activities'] = {};
    for (const [name, def] of Object.entries(queries)) {
      activities[wireName(name)] = activityImplFor(anySpec, name, def);
    }
    for (const [name, def] of Object.entries(commands)) {
      activities[wireName(name)] = activityImplFor(anySpec, name, def);
    }

    // A trigger's poll compiles to a query-shaped activity that returns the
    // feed *normalized*: `eventId` is applied service-side of the wire, so the
    // watcher workflow can run one generic cursor differ for every trigger.
    const pollProxies: Parts['pollProxies'] = {};
    for (const [name, def] of Object.entries(triggers)) {
      const impl = async (args: {
        cursor: string | number | undefined;
        filter: unknown;
      }): Promise<WireResult<readonly FeedItem[]>> => {
        const ctx = await resolveContext(anySpec);
        let filter: unknown;
        if (def.filter !== undefined && args.filter !== undefined) {
          const parsed = await runSchema(def.filter, args.filter);
          if (!parsed.ok) return fail('invalid', `${name}: ${parsed.message}`);
          filter = parsed.value;
        }
        try {
          const events = await def.poll(
            {cursor: args.cursor, filter: filter as never},
            ctx as never,
          );
          const items: FeedItem[] = [];
          for (const event of events) {
            const parsed = await runSchema(def.event, event);
            if (!parsed.ok) {
              return fail('drift', `${name}: event ${parsed.message}`);
            }
            items.push({
              id: def.eventId(parsed.value as never),
              event: parsed.value,
            });
          }
          return {ok: true, value: items};
        } catch (e) {
          if (e instanceof ConnectorError && !e.retryable) {
            return {ok: false, error: e.toEnvelope()};
          }
          throw e;
        }
      };
      activities[pollName(name)] = impl as (input: unknown) => Promise<unknown>;
      const proxy = proxyActivities(
        {[pollName(name)]: impl},
        mergeOptions(QUERY_DEFAULTS, def.options),
      );
      pollProxies[name] = proxy[pollName(name)] as Parts['pollProxies'][string];
    }

    // One watcher workflow per connector; the trigger rides in its props.
    // NOTE (prototype): a poll that fails non-retryably kills the watcher
    // child, and child failure does not propagate to a detached parent — the
    // production version should signal the parent a terminal error event.
    const watcher = createWorkflow({
      key: watcherKey,
      title: `${spec.title ?? spec.name} watcher`,
      description: `Polls one ${spec.name} trigger and signals its parent per event.`,
      async run(props: WatcherProps): Promise<void> {
        const poll = build().pollProxies[props.trigger];
        if (!poll) throw new Error(`unknown trigger '${props.trigger}'`);
        await pollForever<
          FeedItem,
          (string | number) | undefined,
          (string | number) | undefined
        >({
          everyMs: props.everyMs,
          poll: async (cursor) =>
            unwrap(await poll({cursor, filter: props.filter})),
          differ: byCursor<FeedItem, string | number>((item) => item.id),
          startFrom:
            props.start === 'all' || props.start === 'new'
              ? props.start
              : {state: props.start.cursor},
          onAdded: (item) =>
            signalWorkflow(props.parentId, props.signalName, item.event),
        });
      },
    });

    parts = {activities, pollProxies, watcher};
    return parts;
  }

  function use(options: UseOptions = {}): ConnectorProxy<Q, C, T> {
    const built = build();

    const query = {} as Record<string, (input: unknown) => Promise<unknown>>;
    for (const [name, def] of Object.entries(queries)) {
      const wire = wireName(name);
      const proxy = proxyActivities(
        {[wire]: built.activities[wire]!},
        mergeOptions(QUERY_DEFAULTS, def.options, options),
      );
      query[name] = async (input) =>
        unwrap((await proxy[wire]!(input)) as WireResult<unknown>);
    }

    const command = {} as Record<string, (input: unknown) => Promise<unknown>>;
    for (const [name, def] of Object.entries(commands)) {
      const wire = wireName(name);
      const proxy = proxyActivities(
        {[wire]: built.activities[wire]!},
        mergeOptions(
          COMMAND_DEFAULTS,
          def.options,
          options,
          def.idempotency === 'unsafe' ? UNSAFE_OVERRIDE : undefined,
        ),
      );
      command[name] = async (input) =>
        unwrap((await proxy[wire]!(input)) as WireResult<unknown>);
    }

    const watch = {} as Record<
      string,
      (opts: WatchOptions<unknown>) => WatchHandle<unknown>
    >;
    for (const name of Object.keys(triggers)) {
      watch[name] = (opts) => {
        const info = workflowInfo();
        const as = opts.as ?? name;
        const signalName = `cnx:${spec.name}.${name}:${as}`;
        const child = startChild(built.watcher.workflowName, {
          workflowId: `${info.workflowId}/watch/${spec.name}.${name}/${as}`,
          parentClosePolicy: 'terminate',
          props: {
            trigger: name,
            parentId: info.workflowId,
            signalName,
            everyMs: toMs(opts.every),
            filter: opts.where,
            start: opts.start ?? 'new',
          } satisfies WatcherProps,
        });
        const iterator = signalStream<unknown>(signalName, {from: 'start'})[
          Symbol.asyncIterator
        ]();
        return {
          next: async () => (await iterator.next()).value as unknown,
          stop: () => child.cancel(),
          signalName,
          [Symbol.asyncIterator]: () => iterator,
        };
      };
    }

    return {
      query: query as QuerySurface<Q>,
      command: command as CommandSurface<C>,
      watch: watch as WatchSurface<T>,
    };
  }

  function direct(): {
    readonly query: QuerySurface<Q>;
    readonly command: CommandSurface<C>;
  } {
    const built = build();
    const bind = (names: string[]) => {
      const out = {} as Record<string, (input: unknown) => Promise<unknown>>;
      for (const name of names) {
        const impl = built.activities[wireName(name)]!;
        out[name] = async (input) =>
          unwrap((await impl(input)) as WireResult<unknown>);
      }
      return out;
    };
    return {
      query: bind(Object.keys(queries)) as QuerySurface<Q>,
      command: bind(Object.keys(commands)) as CommandSurface<C>,
    };
  }

  function registrations(): Registrations {
    const built = build();
    return {
      activities: built.activities,
      workflows: {[watcherKey]: built.watcher},
    };
  }

  return {spec, use, direct, registrations};
}
