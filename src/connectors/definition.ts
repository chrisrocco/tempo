/**
 * @fileoverview
 * What a connector author writes: operation definitions and the spec that
 * gathers them. Pure data plus handler functions — nothing here touches the
 * engine, which is what keeps a definition loadable by the catalogue, the test
 * harness, and a workflow module alike.
 *
 * Schemas are `StandardSchemaV1` — the framework validates through `~standard`
 * and never names a vendor. `ops<Ctx>()` exists purely for inference: it returns
 * the same builders with the context type pinned, so handlers get a typed `ctx`
 * without annotating every one.
 */

import type {ActivityOptionsInput} from '../workflow';
import type {StandardSchemaV1} from '../libraries/schema';

type Out<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

export interface QueryDef<
  Ctx = unknown,
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
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
 * produce. `'keyed'` (a derived idempotency key) is designed but deferred —
 * see the RFC — so today a command is either idempotent by shape or honestly
 * unsafe: one attempt, flagged in the catalogue, with a written reason.
 */
export type Idempotency = 'natural' | 'unsafe';

export interface CommandDef<
  Ctx = unknown,
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly kind: 'command';
  readonly description: string;
  readonly idempotency: Idempotency;
  /** Required when `idempotency: 'unsafe'`; `command()` enforces it. */
  readonly unsafeBecause?: string;
  readonly input: I;
  readonly output: O;
  handler(input: Out<I>, ctx: Ctx): Out<O> | Promise<Out<O>>;
  readonly options?: ActivityOptionsInput;
}

/** What a trigger's poll receives: the differ's cursor plus the watch filter. */
export interface PollArgs<F> {
  readonly cursor: string | number | undefined;
  readonly filter: F | undefined;
}

export interface TriggerDef<
  Ctx = unknown,
  E extends StandardSchemaV1 = StandardSchemaV1,
  F extends StandardSchemaV1 = StandardSchemaV1,
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

export type AnyQueryDef<Ctx = unknown> = QueryDef<
  Ctx,
  StandardSchemaV1,
  StandardSchemaV1
>;
export type AnyCommandDef<Ctx = unknown> = CommandDef<
  Ctx,
  StandardSchemaV1,
  StandardSchemaV1
>;
export type AnyTriggerDef<Ctx = unknown> = TriggerDef<
  Ctx,
  StandardSchemaV1,
  StandardSchemaV1
>;

export function query<
  Ctx,
  I extends StandardSchemaV1,
  O extends StandardSchemaV1,
>(def: Omit<QueryDef<Ctx, I, O>, 'kind'>): QueryDef<Ctx, I, O> {
  return {...def, kind: 'query'};
}

export function command<
  Ctx,
  I extends StandardSchemaV1,
  O extends StandardSchemaV1,
>(def: Omit<CommandDef<Ctx, I, O>, 'kind'>): CommandDef<Ctx, I, O> {
  if (def.idempotency === 'unsafe' && !def.unsafeBecause) {
    throw new Error(
      `an 'unsafe' command must say why (unsafeBecause) — it becomes the catalogue flag and the keying backlog`,
    );
  }
  return {...def, kind: 'command'};
}

export function trigger<
  Ctx,
  E extends StandardSchemaV1,
  F extends StandardSchemaV1,
>(def: Omit<TriggerDef<Ctx, E, F>, 'kind'>): TriggerDef<Ctx, E, F> {
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
  query: <I extends StandardSchemaV1, O extends StandardSchemaV1>(
    def: Omit<QueryDef<Ctx, I, O>, 'kind'>,
  ) => QueryDef<Ctx, I, O>;
  command: <I extends StandardSchemaV1, O extends StandardSchemaV1>(
    def: Omit<CommandDef<Ctx, I, O>, 'kind'>,
  ) => CommandDef<Ctx, I, O>;
  trigger: <E extends StandardSchemaV1, F extends StandardSchemaV1>(
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
  readonly config: StandardSchemaV1<unknown, Cfg>;
  /** Built once per process from validated config; handlers receive it. */
  readonly context: (cfg: Cfg) => Ctx | Promise<Ctx>;
  readonly queries?: Q;
  readonly commands?: C;
  readonly triggers?: T;
}
