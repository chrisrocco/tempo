/**
 * @fileoverview
 * What a connector author writes: operation definitions and the spec that
 * gathers them. Pure data plus handler functions — nothing here touches the
 * engine, which is what keeps a definition loadable by the catalogue, the test
 * harness, and a workflow module alike.
 *
 * Schemas are the schema library's validator port (`Schema`) — the framework
 * validates and renders through the port's methods and never names a vendor.
 * `ops<Ctx>()` exists purely for inference: it returns the same builders with
 * the context type pinned, so handlers get a typed `ctx` without annotating
 * every one.
 */

import type {ActivityOptionsInput} from '../workflow';
import type {InferOutput, Schema} from '../libraries/schema';

type Out<S extends Schema> = InferOutput<S>;

export interface QueryDef<
  Ctx = unknown,
  I extends Schema = Schema,
  O extends Schema = Schema,
> {
  readonly kind: 'query';
  readonly description: string;
  readonly input: I;
  readonly output: O;
  // Method syntax deliberately: interface methods are bivariant, so a concrete
  // handler taking a narrow input stays assignable to the Any* constraint.
  handler(input: Out<I>, ctx: Ctx): Out<O> | Promise<Out<O>>;
  /** Overrides the query defaults for this one operation. */
  readonly options?: ActivityOptionsInput;
}

/**
 * How a command survives the double delivery the engine will eventually
 * produce.
 *
 * - `'natural'` — idempotent by shape: the service's own semantics make a
 *   second delivery a no-op (delegation, convergence, repeatability).
 * - `'keyed'` — the service accepts an idempotency key, and the definition
 *   declares how to derive one from the input (`key`). The framework computes
 *   it and hands it to the handler as its third argument; sending it is the
 *   handler's job, and the double-fire certification is what proves the
 *   service honors it. Both deliveries of one recorded command carry the same
 *   input, so the derived key is identical — that is the whole mechanism.
 * - `'unsafe'` — no protection exists: one attempt, flagged in the catalogue,
 *   with a written reason.
 */
export type Idempotency = 'natural' | 'keyed' | 'unsafe';

export interface CommandDef<
  Ctx = unknown,
  I extends Schema = Schema,
  O extends Schema = Schema,
> {
  readonly kind: 'command';
  readonly description: string;
  readonly idempotency: Idempotency;
  /** Required when `idempotency: 'unsafe'`; `command()` enforces it. */
  readonly unsafeBecause?: string;
  readonly input: I;
  readonly output: O;
  /**
   * Required when `idempotency: 'keyed'`; `command()` enforces it. Derives the
   * idempotency key from the (parsed) input — so the input must carry a
   * business identity to derive it from (an order id, an externalId). Must be
   * pure: both deliveries of a retried command parse the same recorded input
   * and must compute the same key.
   */
  key?(input: Out<I>): string;
  /**
   * `idempotencyKey` is present exactly when the command is `'keyed'`: the
   * framework derives it via `key` and the handler's job is to send it (an
   * `Idempotency-Key` header, a dedupe field — wherever the service accepts
   * one).
   */
  handler(
    input: Out<I>,
    ctx: Ctx,
    idempotencyKey?: string,
  ): Out<O> | Promise<Out<O>>;
  readonly options?: ActivityOptionsInput;
}

/** What a trigger's poll receives: the differ's cursor plus the watch filter. */
export interface PollArgs<F> {
  readonly cursor: string | number | undefined;
  readonly filter: F | undefined;
}

export interface TriggerDef<
  Ctx = unknown,
  E extends Schema = Schema,
  F extends Schema = Schema,
> {
  readonly kind: 'trigger';
  readonly description: string;
  readonly event: E;
  /**
   * The cursor. Must be stable per event and strictly increasing in feed order
   * — the delivery-truth certification is the forcing function for services
   * that cannot yet provide one.
   */
  eventId(event: Out<E>): string | number;
  readonly filter?: F;
  poll(
    args: PollArgs<Out<F>>,
    ctx: Ctx,
  ): readonly Out<E>[] | Promise<readonly Out<E>[]>;
  /** Overrides the poll activity's (query-shaped) defaults. */
  readonly options?: ActivityOptionsInput;
}

export type AnyQueryDef<Ctx = unknown> = QueryDef<Ctx, Schema, Schema>;
export type AnyCommandDef<Ctx = unknown> = CommandDef<Ctx, Schema, Schema>;
export type AnyTriggerDef<Ctx = unknown> = TriggerDef<Ctx, Schema, Schema>;

export function query<Ctx, I extends Schema, O extends Schema>(
  def: Omit<QueryDef<Ctx, I, O>, 'kind'>,
): QueryDef<Ctx, I, O> {
  return {...def, kind: 'query'};
}

export function command<Ctx, I extends Schema, O extends Schema>(
  def: Omit<CommandDef<Ctx, I, O>, 'kind'>,
): CommandDef<Ctx, I, O> {
  if (def.idempotency === 'unsafe' && !def.unsafeBecause) {
    throw new Error(
      `an 'unsafe' command must say why (unsafeBecause) — it becomes the catalogue flag and the keying backlog`,
    );
  }
  if (def.idempotency === 'keyed' && !def.key) {
    throw new Error(
      `a 'keyed' command must declare key(input) — the derived idempotency key is the mechanism, so a keyed command without one is just an unsafe command with better marketing`,
    );
  }
  return {...def, kind: 'command'};
}

export function trigger<Ctx, E extends Schema, F extends Schema>(
  def: Omit<TriggerDef<Ctx, E, F>, 'kind'>,
): TriggerDef<Ctx, E, F> {
  return {...def, kind: 'trigger'};
}

/**
 * The same builders with `Ctx` pinned, so `handler: (input, ctx) => …` infers
 * a typed `ctx`. Zero runtime cost — this is a typing convenience only.
 *
 * ```ts
 * const {query, command, trigger} = ops<{rpc: TrackerRpc}>();
 * ```
 */
export function ops<Ctx>(): {
  query: <I extends Schema, O extends Schema>(
    def: Omit<QueryDef<Ctx, I, O>, 'kind'>,
  ) => QueryDef<Ctx, I, O>;
  command: <I extends Schema, O extends Schema>(
    def: Omit<CommandDef<Ctx, I, O>, 'kind'>,
  ) => CommandDef<Ctx, I, O>;
  trigger: <E extends Schema, F extends Schema>(
    def: Omit<TriggerDef<Ctx, E, F>, 'kind'>,
  ) => TriggerDef<Ctx, E, F>;
} {
  return {query, command, trigger};
}

/** The one value a connector author exports: everything else is derived. */
export interface ConnectorSpec<
  Cfg = unknown,
  Ctx = unknown,
  Q extends Record<string, AnyQueryDef<Ctx>> = Record<string, AnyQueryDef<Ctx>>,
  C extends Record<string, AnyCommandDef<Ctx>> = Record<
    string,
    AnyCommandDef<Ctx>
  >,
  T extends Record<string, AnyTriggerDef<Ctx>> = Record<
    string,
    AnyTriggerDef<Ctx>
  >,
> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Validated against the configured env source (default `process.env`). */
  readonly config: Schema<Cfg, unknown>;
  /** Built once per process from validated config; handlers receive it. */
  readonly context: (cfg: Cfg) => Ctx | Promise<Ctx>;
  readonly queries?: Q;
  readonly commands?: C;
  readonly triggers?: T;
}
