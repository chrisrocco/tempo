/**
 * @fileoverview
 * What the start form accepts as an argument list.
 *
 * The case this exists for is the ambiguous one: `[1, 2, 3]` is three arguments
 * and never one array argument, because the outer brackets are the list. Getting
 * that wrong produces a workflow that started successfully with the wrong
 * parameters, which is the kind of failure nobody looks for.
 */

import 'jasmine';
import {parseArgs} from '../../dashboard/app/start_args';

describe('dashboard start form — reading the arguments box', () => {
  it('reads an empty box as no arguments, for the workflows that take none', () => {
    expect(parseArgs('')).toEqual({args: []});
    expect(parseArgs('   ')).toEqual({args: []});
  });

  it('reads a JSON array as the argument list', () => {
    expect(parseArgs('["world"]')).toEqual({args: ['world']});
    expect(parseArgs('[1, 2, 3]')).toEqual({args: [1, 2, 3]});
  });

  it('reads a nested array as one array argument', () => {
    // The distinction the brackets exist to make: this is a single argument
    // that happens to be a list, not three arguments.
    expect(parseArgs('[[1, 2, 3]]')).toEqual({args: [[1, 2, 3]]});
  });

  it('preserves an explicit null, which is a value a workflow can receive', () => {
    expect(parseArgs('[null]')).toEqual({args: [null]});
  });

  it('rejects a bare value and names the fix rather than the rule', () => {
    const result = parseArgs('"world"');
    expect(result).toEqual({error: jasmine.any(String)});
    expect('error' in result && result.error).toContain('[]');
  });

  it('rejects an object, which is a single argument written without its list', () => {
    expect(parseArgs('{"by": "ops"}')).toEqual({error: jasmine.any(String)});
  });

  it('reports malformed JSON as malformed rather than as a bad shape', () => {
    const result = parseArgs('[1, 2');
    expect('error' in result && result.error).toContain('not valid JSON');
  });
});
