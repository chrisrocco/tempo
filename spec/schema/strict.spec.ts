/**
 * @fileoverview
 * `strictProblems` — the vendor-neutral spelling of "strict mode": unknown keys
 * found by walking a raw value against the operation's *emitted JSON Schema*,
 * because most vendors' object schemas strip rather than reject, and the
 * framework refuses to depend on any one vendor's strictness switch.
 */

import {strictProblems} from '../../src/schema';

const issueSchema = {
  type: 'object',
  properties: {
    key: {type: 'string'},
    assignee: {
      type: 'object',
      properties: {id: {type: 'string'}},
      required: ['id'],
    },
    labels: {type: 'array', items: {type: 'string'}},
    watchers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {id: {type: 'string'}},
      },
    },
  },
  required: ['key'],
};

describe('connectors strict check — undeclared keys against emitted JSON Schema', () => {
  it('accepts a value the schema fully accounts for', () => {
    expect(
      strictProblems(issueSchema, {
        key: 'OPS-1',
        assignee: {id: 'u1'},
        labels: ['incident'],
        watchers: [{id: 'u2'}],
      }),
    ).toEqual([]);
  });

  it('reports a top-level key the schema does not declare', () => {
    expect(strictProblems(issueSchema, {key: 'OPS-1', debug: 'oops'})).toEqual([
      '$.debug',
    ]);
  });

  it('reports undeclared keys nested in objects and array items, by path', () => {
    expect(
      strictProblems(issueSchema, {
        key: 'OPS-1',
        assignee: {id: 'u1', email: 'leak@example.com'},
        watchers: [{id: 'u2'}, {id: 'u3', role: 'admin'}],
      }),
    ).toEqual(['$.assignee.email', '$.watchers[1].role']);
  });

  it('lets additionalProperties: true opt a schema out, where the author said so', () => {
    const open = {
      type: 'object',
      properties: {key: {type: 'string'}},
      additionalProperties: true,
    };
    expect(strictProblems(open, {key: 'OPS-1', anything: 1})).toEqual([]);
  });

  it('skips undefined-valued unknowns — JSON serialization drops them anyway', () => {
    expect(
      strictProblems(issueSchema, {key: 'OPS-1', ghost: undefined}),
    ).toEqual([]);
  });

  it('says nothing without a schema — unchecked is not clean, and not a failure here', () => {
    expect(strictProblems(undefined, {anything: 1})).toEqual([]);
  });
});
