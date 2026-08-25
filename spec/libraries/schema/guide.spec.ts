/**
 * @fileoverview
 * The entrypoint's guide, executed.
 *
 * `src/libraries/schema/index.ts` opens with a worked example, and a guide is
 * the one kind of comment a reader acts on without checking — so the example is
 * this file's tests, line for line. Writing them the first time caught two
 * things the guide had wrong (`runSchema` returns a result rather than throwing;
 * `strictProblems` reads the rendered `jsonSchema`, not the builder), which is
 * the argument for keeping them: an API change that falsifies the guide now
 * fails here instead of misleading whoever reads it. See AGENTS.md, "There is
 * no examples/ tree".
 *
 * Imported by relative path like every other spec, **not** by the published
 * name. The self-referencing import this started with proved something real —
 * that Node's resolver can follow the `exports` map — and cost more than it was
 * worth: a package self-reference does not resolve in the build system that
 * consumes this repo (see the note in `tsconfig.json`), so it became a local
 * patch on every sync. What it actually protected against, a subpath pointing
 * at a file that is not there, is checked without running anything in
 * `spec/architecture.spec.ts` under "published surfaces".
 */

import {
  runSchema,
  strictProblems,
  t,
  type OutOf,
} from '../../../src/libraries/schema';

describe('workflow-engine/schema — the surface its guide describes', () => {
  const Search = t.object({
    query: t.string({description: 'What to search for'}),
    limit: t.defaulted(t.integer({min: 1, max: 100}), 20),
  });

  it('validates a value, filling defaults on the way out', async () => {
    const result = await runSchema(Search, {query: 'durable execution'});

    expect(result).toEqual({
      ok: true,
      value: {query: 'durable execution', limit: 20},
    });
  });

  it('reports a failure as a value carrying one flattened message', async () => {
    const result = await runSchema(Search, {limit: 5});

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('query');
  });

  it('renders the JSON Schema a form or a model is handed', () => {
    expect(Search.jsonSchema).toEqual({
      type: 'object',
      properties: {
        query: {type: 'string', description: 'What to search for'},
        limit: {type: 'integer', minimum: 1, maximum: 100, default: 20},
      },
      required: ['query'],
    });
  });

  it('names undeclared keys when asked for strictness explicitly', () => {
    // Reads the rendered schema rather than the builder — the distinction the
    // guide has to state, because passing the builder returns `[]` and looks
    // like conformance.
    expect(strictProblems(Search.jsonSchema, {query: 'x', extra: 1})).toEqual([
      '$.extra',
    ]);
  });

  it('infers the handler-side type from the same definition', () => {
    const value: OutOf<typeof Search> = {query: 'x', limit: 1};

    expect(value.limit).toBe(1);
  });
});
