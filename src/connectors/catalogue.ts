/**
 * @fileoverview
 * The catalogue: every operation of every connector as data a dashboard can
 * render — kind, description, idempotency, and JSON Schema for the forms.
 *
 * Schemas render only if they carry `toJsonSchema` (the validator port's
 * optional half); one that does not lists without a form rather than failing
 * the walk, mirroring tempo's "every descriptor field is optional".
 */

import type {Connector} from './connector';
import type {
  AnyCommandDef,
  AnyQueryDef,
  AnyTriggerDef,
  Idempotency,
} from './definition';
import type {JsonSchema} from '../libraries/schema';

export interface CatalogueEntry {
  readonly connector: string;
  readonly kind: 'query' | 'command' | 'trigger';
  readonly name: string;
  readonly description: string;
  readonly idempotency?: Idempotency;
  readonly unsafeBecause?: string;
  readonly input?: JsonSchema;
  readonly output?: JsonSchema;
  readonly event?: JsonSchema;
  readonly filter?: JsonSchema;
}

// The walk needs names and defs, not the type-level surfaces; `any` here is
// deliberate variance-swallowing so every concrete connector is accepted.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyConnector = Connector<any, any, any, any, any>;

export function catalogue(
  connectors: readonly AnyConnector[],
): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];
  for (const c of connectors) {
    const spec = c.spec as {
      name: string;
      queries?: Record<string, AnyQueryDef>;
      commands?: Record<string, AnyCommandDef>;
      triggers?: Record<string, AnyTriggerDef>;
    };
    const {name, queries = {}, commands = {}, triggers = {}} = spec;
    for (const [op, def] of Object.entries(queries)) {
      entries.push({
        connector: name,
        kind: 'query',
        name: op,
        description: def.description,
        input: def.input.toJsonSchema?.(),
        output: def.output.toJsonSchema?.(),
      });
    }
    for (const [op, def] of Object.entries(commands)) {
      entries.push({
        connector: name,
        kind: 'command',
        name: op,
        description: def.description,
        idempotency: def.idempotency,
        unsafeBecause: def.unsafeBecause,
        input: def.input.toJsonSchema?.(),
        output: def.output.toJsonSchema?.(),
      });
    }
    for (const [op, def] of Object.entries(triggers)) {
      entries.push({
        connector: name,
        kind: 'trigger',
        name: op,
        description: def.description,
        event: def.event.toJsonSchema?.(),
        filter: def.filter?.toJsonSchema?.(),
      });
    }
  }
  return entries;
}
