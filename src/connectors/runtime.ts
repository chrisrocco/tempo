/**
 * @fileoverview
 * Config and context resolution: the one place credentials flow.
 *
 * A connector declares its config as a schema over the environment; the schema
 * picks (and validates) the keys it needs. `context()` runs once per process
 * per connector — lazily, on the first operation — and every handler receives
 * the same context object. Handlers never read `process.env`; conformance in
 * the full package enforces that by lint, this module enforces it by making the
 * sanctioned path the easy one.
 */

import type {ConnectorSpec} from './definition';
import {runSchema} from '../schema';

let envSource: Record<string, string | undefined> = process.env;

/** Point config resolution somewhere other than `process.env` (tests, harness). */
export function configureConnectors(options: {
  env?: Record<string, string | undefined>;
}): void {
  if (options.env) envSource = options.env;
}

const contexts = new WeakMap<object, Promise<unknown>>();

/** The connector's context, built once per process on first use. */
export function resolveContext<Ctx>(spec: ConnectorSpec): Promise<Ctx> {
  let cached = contexts.get(spec);
  if (!cached) {
    cached = (async () => {
      const cfg = await runSchema(spec.config, envSource);
      if (!cfg.ok) {
        throw new Error(
          `connector '${spec.name}': config invalid — ${cfg.message}`,
        );
      }
      return spec.context(cfg.value);
    })();
    contexts.set(spec, cached);
  }
  return cached as Promise<Ctx>;
}
