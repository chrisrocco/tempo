/**
 * @fileoverview
 * The live-certification harness: prove a connector against the real service it
 * wraps. No sandbox environments exist, so the strategy is not "simulate the
 * service" — it is to certify, continuously, the four properties that make a
 * connector trustworthy:
 *
 * 1. **Schema truth** — every operation's live response matches its declared
 *    output, and carries nothing undeclared (`strict.ts`, against the emitted
 *    JSON Schema — the vendor-neutral spelling of "strict").
 * 2. **Retry safety** — every `'natural'` command is fired **twice** with one
 *    identity and produces exactly one effect: the double delivery the engine's
 *    at-least-once contract will eventually produce, made routine. `'unsafe'`
 *    commands are refused a double-fire outright — one attempt *is* their
 *    certification, and the flag already carries the reason.
 * 3. **Delivery truth** — a caused event appears in the trigger's poll exactly
 *    once past the prior cursor, with a stable id, in increasing order, and not
 *    again once the cursor advances.
 * 4. **Replay safety** — outputs survive a JSON round-trip and re-parse
 *    identically, because activity results live in history and are replayed.
 *
 * ## A plan, not a test suite
 *
 * `planLiveSuite` returns a **plan** — `setup` (janitor sweep, then provision a
 * namespaced fixture), ordered named `cases`, `teardown` (destroy) — rather
 * than calling any test framework, so one harness serves Jasmine here, whatever
 * a consumer runs, and a bare scheduled process for the nightly drift run.
 * `runLivePlan` is the bare runner.
 *
 * ## Engine-free, deliberately
 *
 * Certification drives the connector's raw handlers through `resolveContext` —
 * the same code path production activities run — and never touches
 * `use()`/`direct()`, so building or running a plan registers **nothing** into
 * the process-global workflow/activity registries. That is what lets a live
 * spec construct plans freely without the registration hygiene
 * `spec/connectors/connectors.spec.ts` has to practice for the engine-backed
 * path.
 *
 * ## The author writes only what the harness cannot know
 *
 * How to stage the world, cause an effect, and observe it: `stage` for a query,
 * `{setup?, act, probe}` for a command, `{cause, filter?, expect}` for a
 * trigger. Everything mechanical — double-firing, strict parsing, round-trips,
 * cursor arithmetic, golden capture, coverage accounting — is the harness's
 * job, and the final generated case fails naming any operation left
 * uncertified, which is what makes "both suites green" a real definition of
 * done for an agent-built connector.
 */

import type {Connector, CommandSurface, QuerySurface} from './connector';
import type {
  AnyCommandDef,
  AnyQueryDef,
  AnyTriggerDef,
  ConnectorSpec,
} from './definition';
import {ConnectorError} from './errors';
import {emitJsonSchema} from './json_schema';
import {resolveContext} from './runtime';
import type {StandardSchemaV1} from './standard_schema';
import {strictProblems} from './strict';
import {runSchema} from './validate';

type In<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
type Out<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/* -------------------------------------------------------------------------- */
/* The fixture protocol                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A disposable corner of production, namespaced so parallel runs coexist.
 * Everything `provision` creates must carry a marker `sweep` can find, because
 * `destroy` **will** sometimes not run (a crashed suite, an upstream timeout):
 * the janitor is the guarantee, teardown is merely the polite case.
 */
export interface LiveFixtures<FX> {
  provision(ns: string): FX | Promise<FX>;
  destroy(ns: string): void | Promise<void>;
  /** Remove leaked test resources older than the cutoff. Runs before every suite. */
  sweep(olderThanMs: number): unknown | Promise<unknown>;
}

export interface LiveOptions {
  /** Janitor cutoff — how old a leaked resource must be to be swept. Default 24h. */
  sweepOlderThanMs?: number;
}

/* -------------------------------------------------------------------------- */
/* What a case author sees                                                    */
/* -------------------------------------------------------------------------- */

export interface LiveCtx<FX, Q, C> {
  /**
   * The connector's operations as plain bound calls — same validation and
   * typed errors as `direct()`, but built inside the harness so no engine
   * registration happens.
   */
  readonly direct: {
    readonly query: QuerySurface<Q>;
    readonly command: CommandSurface<C>;
  };
  readonly fx: FX;
  /** A namespace-scoped unique id, for business identities a case mints. */
  uniqueId(prefix: string): string;
}

export interface CommandCtx<FX, Q, C> extends LiveCtx<FX, Q, C> {
  /**
   * The one identity for this certification: both deliveries of `act` receive
   * the same value, which is what makes firing twice mean something. Use it as
   * the operation's business identity (an externalId, an order number).
   */
  readonly key: string;
}

export interface CommandCertification<FX, Q, C, S> {
  /** Stage a subject once (an entity the command operates on). Optional. */
  setup?(ctx: CommandCtx<FX, Q, C>): S | Promise<S>;
  /** The delivery. The harness runs it TWICE with the same `ctx.key`. */
  act(ctx: CommandCtx<FX, Q, C>, subject: S): unknown;
  /** Count the effects attributable to `ctx.key`. The harness asserts 1. */
  probe(
    ctx: CommandCtx<FX, Q, C>,
    subject: S,
  ): {effects: number} | Promise<{effects: number}>;
}

export interface TriggerCertification<FX, Q, C, E, Caused> {
  /** Make the event happen (usually via commands). */
  cause(ctx: LiveCtx<FX, Q, C>): Caused | Promise<Caused>;
  /** The watch filter to poll with, if the trigger declares one. */
  filter?(ctx: LiveCtx<FX, Q, C>): unknown;
  /** Is this event the one `cause` produced? */
  expect(event: E, caused: Caused): boolean;
}

export interface LiveRegistrar<
  FX,
  Q extends Record<string, AnyQueryDef<never>>,
  C extends Record<string, AnyCommandDef<never>>,
  T extends Record<string, AnyTriggerDef<never>>,
> {
  /** Certify a query: stage the world, return the input to call it with. */
  query<K extends keyof Q & string>(
    name: K,
    stage: (
      ctx: LiveCtx<FX, Q, C>,
    ) => In<Q[K]['input']> | Promise<In<Q[K]['input']>>,
  ): void;
  /** Certify a `'natural'` command. Refused for `'unsafe'` ones. */
  command<K extends keyof C & string, S = undefined>(
    name: K,
    certification: CommandCertification<FX, Q, C, S>,
  ): void;
  /** Certify a trigger's delivery truth. */
  trigger<K extends keyof T & string, Caused = unknown>(
    name: K,
    certification: TriggerCertification<FX, Q, C, Out<T[K]['event']>, Caused>,
  ): void;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

export interface LiveCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface LivePlan {
  /** The namespace this run provisions under — `cnx-{ns}` markers. */
  readonly ns: string;
  /** Sweep leaks, provision the fixture, bind the connector context. */
  setup(): Promise<void>;
  /** Ordered; ends with the generated coverage case. */
  readonly cases: readonly LiveCase[];
  /** Destroy this run's fixture. The janitor covers the runs that never get here. */
  teardown(): Promise<void>;
  /**
   * Validated, JSON-safe outputs captured during the run — query results and
   * one matching event per trigger — for goldens, stubs, and catalogue samples.
   */
  recordings(): Readonly<Record<string, unknown>>;
}

export interface LiveFailure {
  readonly name: string;
  readonly message: string;
}

/** The bare runner: setup, every case, teardown — teardown even on failure. */
export async function runLivePlan(plan: LivePlan): Promise<LiveFailure[]> {
  const failures: LiveFailure[] = [];
  await plan.setup();
  try {
    for (const testCase of plan.cases) {
      try {
        await testCase.run();
      } catch (e) {
        failures.push({
          name: testCase.name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    await plan.teardown();
  }
  return failures;
}

/* -------------------------------------------------------------------------- */
/* planLiveSuite                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_SWEEP_MS = 24 * 60 * 60 * 1_000;

export function planLiveSuite<
  FX,
  Cfg,
  Ctx,
  Q extends Record<string, AnyQueryDef<Ctx>>,
  C extends Record<string, AnyCommandDef<Ctx>>,
  T extends Record<string, AnyTriggerDef<Ctx>>,
>(
  connector: Connector<Cfg, Ctx, Q, C, T>,
  fixtures: LiveFixtures<FX>,
  register: (t: LiveRegistrar<FX, Q, C, T>) => void,
  options: LiveOptions = {},
): LivePlan {
  const spec = connector.spec as ConnectorSpec;
  const queries: Record<string, AnyQueryDef> = spec.queries ?? {};
  const commands: Record<string, AnyCommandDef> = spec.commands ?? {};
  const triggers: Record<string, AnyTriggerDef> = spec.triggers ?? {};

  const ns = `${Date.now().toString(36)}${Math.floor(
    Math.random() * 1_679_616, // 36^4: four more base-36 digits
  ).toString(36)}`;

  /** Filled by `setup()`; every case reads through it. */
  const state: {ready: boolean; fx?: FX; ctx?: unknown} = {ready: false};
  let idCounter = 0;
  const recordings: Record<string, unknown> = {};

  const fail = (op: string, certification: string, detail: string): never => {
    throw new Error(`${op}: ${certification} — ${detail}`);
  };

  /** The production parse path, bound for case authors — no engine involved. */
  function bindDirect(): LiveCtx<FX, Q, C>['direct'] {
    const bind = (defs: Record<string, AnyQueryDef | AnyCommandDef>) => {
      const out: Record<string, (input: unknown) => Promise<unknown>> = {};
      for (const [name, def] of Object.entries(defs)) {
        out[name] = async (input) => {
          const parsedIn = await runSchema(def.input, input);
          if (!parsedIn.ok) {
            throw new ConnectorError('invalid', `${name}: ${parsedIn.message}`);
          }
          const raw = await def.handler(
            parsedIn.value as never,
            state.ctx as never,
          );
          const parsedOut = await runSchema(def.output, raw);
          if (!parsedOut.ok) {
            throw new ConnectorError(
              'drift',
              `${name}: response ${parsedOut.message}`,
            );
          }
          return parsedOut.value;
        };
      }
      return out;
    };
    return {
      query: bind(queries) as QuerySurface<Q>,
      command: bind(commands) as CommandSurface<C>,
    };
  }

  function caseCtx(): LiveCtx<FX, Q, C> {
    if (!state.ready) {
      throw new Error(
        'live plan case ran before setup() — run the plan via runLivePlan, or call setup() first',
      );
    }
    return {
      direct: bindDirect(),
      fx: state.fx as FX,
      uniqueId: (prefix: string) => `cnx-${ns}-${prefix}-${idCounter++}`,
    };
  }

  /**
   * Schema truth + replay safety for one raw response. Returns the parsed,
   * round-trip-stable value, ready to record as a golden.
   */
  async function certifyOutput(
    op: string,
    schema: StandardSchemaV1,
    raw: unknown,
  ): Promise<unknown> {
    const parsed = await runSchema(schema, raw);
    if (!parsed.ok) {
      fail(
        op,
        'schema truth',
        `live response does not match the declared schema: ${parsed.message}`,
      );
    }
    const emitted = emitJsonSchema(schema);
    if (emitted) {
      const problems = strictProblems(emitted, raw);
      if (problems.length > 0) {
        fail(
          op,
          'schema truth',
          `live response carries undeclared keys: ${problems.join(', ')} — upstream drift, or the schema is behind`,
        );
      }
    }
    const roundTripped: unknown = JSON.parse(JSON.stringify(raw));
    const reparsed = await runSchema(schema, roundTripped);
    if (!reparsed.ok) {
      fail(
        op,
        'replay safety',
        `response no longer parses after a JSON round-trip (${reparsed.message}) — activity results live in history, so this would break replay`,
      );
    }
    if (
      reparsed.ok &&
      parsed.ok &&
      JSON.stringify(reparsed.value) !== JSON.stringify(parsed.value)
    ) {
      fail(
        op,
        'replay safety',
        'parsed response changes across a JSON round-trip — a Date, class instance, or non-JSON value is hiding in it',
      );
    }
    return parsed.ok ? parsed.value : undefined;
  }

  const cases: LiveCase[] = [];
  const covered = new Set<string>();

  const registrar: LiveRegistrar<FX, Q, C, T> = {
    query(name, stage) {
      const def = queries[name];
      if (!def) {
        throw new Error(
          `no query '${name}' on connector '${spec.name}' — it has: ${Object.keys(queries).join(', ') || '(none)'}`,
        );
      }
      covered.add(name);
      cases.push({
        name: `${spec.name}.${name} — schema truth`,
        run: async () => {
          const ctx = caseCtx();
          const input = await stage(ctx);
          const parsedIn = await runSchema(def.input, input);
          if (!parsedIn.ok) {
            fail(
              name,
              'staging',
              `the staged input is invalid: ${parsedIn.message}`,
            );
            return;
          }
          const raw = await def.handler(
            parsedIn.value as never,
            state.ctx as never,
          );
          recordings[name] = await certifyOutput(name, def.output, raw);
        },
      });
    },

    command(name, certification) {
      const def = commands[name];
      if (!def) {
        throw new Error(
          `no command '${name}' on connector '${spec.name}' — it has: ${Object.keys(commands).join(', ') || '(none)'}`,
        );
      }
      if (def.idempotency === 'unsafe') {
        throw new Error(
          `'${name}' is an unsafe command — one attempt is its certification, and the harness refuses the double-fire it must never run. Its catalogue flag and unsafeBecause are the record; remove this block`,
        );
      }
      covered.add(name);
      cases.push({
        name: `${spec.name}.${name} — retry safety (double delivery, one effect)`,
        run: async () => {
          const base = caseCtx();
          const ctx: CommandCtx<FX, Q, C> = {
            ...base,
            key: base.uniqueId(name),
          };
          const subject = (await certification.setup?.(ctx)) as never;
          await certification.act(ctx, subject);
          // The retry the engine will eventually deliver: same key, again.
          await certification.act(ctx, subject);
          const {effects} = await certification.probe(ctx, subject);
          if (effects !== 1) {
            fail(
              name,
              'retry safety',
              `double delivery produced ${effects} effects, expected exactly 1 — this command is not idempotent under its declared '${def.idempotency}' mode`,
            );
          }
        },
      });
    },

    trigger(name, certification) {
      const def = triggers[name];
      if (!def) {
        throw new Error(
          `no trigger '${name}' on connector '${spec.name}' — it has: ${Object.keys(triggers).join(', ') || '(none)'}`,
        );
      }
      covered.add(name);
      cases.push({
        name: `${spec.name}.${name} — delivery truth (once, ordered, cursor-stable)`,
        run: async () => {
          const ctx = caseCtx();
          const rawFilter = certification.filter?.(ctx);
          let filter: unknown;
          if (def.filter && rawFilter !== undefined) {
            const parsed = await runSchema(def.filter, rawFilter);
            if (!parsed.ok) {
              fail(name, 'staging', `the filter is invalid: ${parsed.message}`);
              return;
            }
            filter = parsed.value;
          }
          const poll = async (
            cursor: string | number | undefined,
          ): Promise<{id: string | number; event: unknown}[]> => {
            const events = await def.poll(
              {cursor, filter: filter as never},
              state.ctx as never,
            );
            const items: {id: string | number; event: unknown}[] = [];
            for (const event of events) {
              const parsed = await runSchema(def.event, event);
              if (!parsed.ok) {
                fail(name, 'schema truth', `polled event ${parsed.message}`);
                return items;
              }
              items.push({
                id: def.eventId(parsed.value as never),
                event: parsed.value,
              });
            }
            for (let i = 1; i < items.length; i++) {
              const a = items[i - 1]!.id;
              const b = items[i]!.id;
              if (!(b > a)) {
                fail(
                  name,
                  'delivery truth',
                  `eventIds are not strictly increasing in poll order (${String(a)} then ${String(b)}) — the id is the cursor, so order is the contract`,
                );
              }
            }
            return items;
          };

          // Where the feed stands before the cause: the cursor a watcher holds.
          const before = await poll(undefined);
          const cursor0 = before.length
            ? before[before.length - 1]!.id
            : undefined;

          const caused = await certification.cause(ctx);

          const matchesCaused = (item: {event: unknown}) =>
            certification.expect(item.event as never, caused as never);

          const batch = await poll(cursor0);
          const matches = batch.filter(matchesCaused);
          if (matches.length !== 1) {
            fail(
              name,
              'delivery truth',
              `the caused event appeared ${matches.length} times past the prior cursor, expected exactly once${matches.length === 0 ? ' — is eventId ordered, and does poll honor the cursor?' : ''}`,
            );
            return;
          }
          const match = matches[0]!;

          // A repeated read from the same cursor is the crashed-and-re-polled
          // watcher: the event must still be there, under the same id.
          const again = (await poll(cursor0)).filter(matchesCaused);
          if (again.length !== 1 || !(again[0]!.id === match.id)) {
            fail(
              name,
              'delivery truth',
              're-polling the same cursor did not reproduce the event under the same id — ids must be stable for the cursor to mean anything',
            );
          }

          // And once the cursor passes it, it is gone for good.
          const advanced = batch[batch.length - 1]!.id;
          const after = (await poll(advanced)).filter(matchesCaused);
          if (after.length !== 0) {
            fail(
              name,
              'delivery truth',
              `the event reappeared after the cursor advanced past it — poll ignores its cursor, and a watcher would deliver it twice`,
            );
          }

          recordings[name] = match.event;
        },
      });
    },
  };

  register(registrar);

  // The executable definition of done: an operation nobody certified fails the
  // suite by name. Unsafe commands are exempt — their flag is the certification.
  const owed = [
    ...Object.keys(queries),
    ...Object.entries(commands)
      .filter(([, def]) => def.idempotency !== 'unsafe')
      .map(([name]) => name),
    ...Object.keys(triggers),
  ].filter((name) => !covered.has(name));
  cases.push({
    name: `${spec.name} — coverage: every operation is certified`,
    run: async () => {
      if (owed.length > 0) {
        throw new Error(
          `uncertified operations: ${owed.join(', ')} — every query needs a t.query, every natural command a t.command, every trigger a t.trigger`,
        );
      }
    },
  });

  return {
    ns,
    async setup() {
      await fixtures.sweep(options.sweepOlderThanMs ?? DEFAULT_SWEEP_MS);
      state.ctx = await resolveContext(spec);
      state.fx = await fixtures.provision(ns);
      state.ready = true;
    },
    cases,
    async teardown() {
      if (!state.ready) return;
      state.ready = false;
      await fixtures.destroy(ns);
    },
    recordings: () => ({...recordings}),
  };
}
