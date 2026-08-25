/**
 * @fileoverview
 * The schema library as a *consumer* reaches it: by the published name, not by
 * a relative path into `src/`.
 *
 * Every other spec beside this one imports `../../../src/libraries/schema`,
 * which proves the code works and says nothing about whether anyone outside can
 * get to it. `workflow-engine/schema` is resolved through the `exports` map, so
 * a typo there, a moved file, or a subpath quietly dropped in a merge is
 * invisible to the rest of the suite and total for the consumer. This is the
 * only place that resolution is exercised.
 *
 * It doubles as the executable copy of the entrypoint's guide: the example in
 * that fileoverview is this file's first test, so an API change that falsifies
 * the guide fails here rather than misleading whoever reads it. See AGENTS.md,
 * "There is no examples/ tree".
 */

import {runSchema, strictProblems, t, type OutOf} from 'workflow-engine/schema';

describe('workflow-engine/schema — the published surface', () => {
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
