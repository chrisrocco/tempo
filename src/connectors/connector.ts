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
 * `watch.<trigger>(opts)` rides the engine's `createWatcher` primitive: each
 * trigger declares one watcher (`cnx.<name>.watch.<trigger>`) whose poll is
 * the trigger's poll wrapped in validation and eventId normalization, over a
 * `byCursor` differ. Deterministic child ids, once-per-event delivery, and
 * the async-iterable handle are the primitive's guarantees
 * (`patterns/watcher.ts`); this layer only adds connector semantics — filter
 * validation, event-schema drift checks, and unwrapping items to events.
 */

import {
  byCursor,
  createWatcher,
  durationToMs,
  proxyActivities,
  type ActivityOptionsInput,
  type AnyWorkflowFn,
  type WatcherRef,
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
import {
  runSchema,
  type InferInput,
  type InferOutput,
  type Schema,
} from '../libraries/schema';

/** What every operation activity returns: JSON-safe, lives in history. */
export type WireResult<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly error: ConnectorErrorEnvelope};

/* -------------------------------------------------------------------------- */
/* Author-facing surface types                                                */
/* -------------------------------------------------------------------------- */

type In<S extends Schema> = InferInput<S>;
type Out<S extends Schema> = InferOutput<S>;

// Structural infer over {input, output} rather than over the def generics:
// immune to Ctx variance, and it is genuinely all a call site needs to know.
export type QuerySurface<Q> = {
  [K in keyof Q]: Q[K] extends {
    input: infer I extends Schema;
    output: infer O extends Schema;
  }
    ? (input: In<I>) => Promise<Out<O>>
    : never;
};

export type CommandSurface<C> = QuerySurface<C>;

export interface WatchOptions<F> {
  /** Poll interval: milliseconds, or duration text (`'30 seconds'`, `'1h 30m'`). */
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
  ? NonNullable<F> extends Schema
    ? Out<NonNullable<F>>
    : undefined
  : undefined;

export type WatchSurface<T> = {
  [K in keyof T]: T[K] extends {event: infer E extends Schema}
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
/* Duration text                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `every`, whichever spelling it arrived in, as milliseconds. This is the
 * walltime library's one duration grammar (`'30 seconds'`, `'90s'`,
 * `'1h 30m'`; numbers pass through) — connectors deliberately carry no second
 * parser.
 */
export const toMs: (every: number | string) => number = durationToMs;

/* -------------------------------------------------------------------------- */
/* The wrapper: one operation definition -> one activity implementation        */
/* -------------------------------------------------------------------------- */

interface OpLike {
  readonly input: Schema;
  readonly output: Schema;
  /** Present only on `'keyed'` commands: derives the idempotency key. */
  key?(input: never): string;
  handler(input: never, ctx: never, idempotencyKey?: string): unknown;
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
      // Derived from the parsed input, so both deliveries of one recorded
      // command — same input, replayed — compute the same key. That identity
      // is what the service dedupes on, and what makes 'keyed' retryable.
      const idempotencyKey = def.key?.(parsedIn.value as never);
      const raw = await def.handler(
        parsedIn.value as never,
        ctx as never,
        idempotencyKey,
      );
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
/* Watchers: one engine watcher per trigger                                    */
/* -------------------------------------------------------------------------- */

/** What a trigger's poll activity yields: the event plus its cursor id. */
interface FeedItem {
  id: string | number;
  event: unknown;
}

type TriggerWatcher = WatcherRef<
  FeedItem,
  (string | number) | undefined,
  unknown
>;

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
  const watcherKey = (t: string) => `cnx.${spec.name}.watch.${t}`;

  /**
   * Built once, lazily: the raw activity implementations and one engine
   * watcher per trigger. `use()` and `registrations()` share these so both
   * paths serve identical code.
   */
  interface Parts {
    activities: Record<string, (input: unknown) => Promise<unknown>>;
    watchers: Record<string, TriggerWatcher>;
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

    // A trigger's poll becomes an engine watcher: the poll is wrapped in
    // filter validation, event-schema checks, and eventId normalization, so
    // one `byCursor` differ serves every trigger. Poll failures throw — a
    // non-retryable one burns the retry budget before the child fails, which
    // is the price of keeping the primitive envelope-free; the poller-death
    // notification belongs to `patterns/watcher.ts` when it grows one.
    const watchers: Parts['watchers'] = {};
    for (const [name, def] of Object.entries(triggers)) {
      watchers[name] = createWatcher(watcherKey(name), {
        every: '30 seconds',
        options: mergeOptions(QUERY_DEFAULTS, def.options),
        diff: byCursor<FeedItem, string | number>((item) => item.id),
        poll: async (
          query: (string | number) | undefined,
          input: unknown,
        ): Promise<readonly FeedItem[]> => {
          const ctx = await resolveContext(anySpec);
          let filter: unknown;
          if (def.filter !== undefined && input !== undefined) {
            const parsed = await runSchema(def.filter, input);
            if (!parsed.ok) {
              throw new ConnectorError('invalid', `${name}: ${parsed.message}`);
            }
            filter = parsed.value;
          }
          const events = await def.poll(
            {cursor: query, filter: filter as never},
            ctx as never,
          );
          const items: FeedItem[] = [];
          for (const event of events) {
            const parsed = await runSchema(def.event, event);
            if (!parsed.ok) {
              throw new ConnectorError(
                'drift',
                `${name}: event ${parsed.message}`,
              );
            }
            items.push({
              id: def.eventId(parsed.value as never),
              event: parsed.value,
            });
          }
          return items;
        },
      });
    }

    parts = {activities, watchers};
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
      const ref = built.watchers[name]!;
      watch[name] = (opts) => {
        const handle = ref.watch({
          every: toMs(opts.every),
          start:
            opts.start === undefined
              ? 'new'
              : opts.start === 'all' || opts.start === 'new'
                ? opts.start
                : {state: opts.start.cursor},
          ...(opts.as !== undefined ? {as: opts.as} : {}),
          ...(opts.where !== undefined ? {input: opts.where} : {}),
        });
        // The primitive delivers FeedItems; the connector promised events.
        const events = (async function* () {
          for await (const item of handle) yield (item as FeedItem).event;
        })();
        return {
          next: async () => ((await handle.next()) as FeedItem).event,
          stop: handle.stop,
          signalName: handle.signalName,
          [Symbol.asyncIterator]: () => events,
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
    const workflows: Record<string, AnyWorkflowFn> = {};
    const activities = {...built.activities};
    for (const ref of Object.values(built.watchers)) {
      const regs = ref.registrations();
      Object.assign(workflows, regs.workflows);
      Object.assign(
        activities,
        regs.activities as Record<string, (input: unknown) => Promise<unknown>>,
      );
    }
    return {activities, workflows};
  }

  return {spec, use, direct, registrations};
}
