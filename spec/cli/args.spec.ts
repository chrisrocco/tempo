/**
 * @fileoverview
 * The CLI's argument parsing rules, pinned without going through a command.
 *
 * These are the cases where a plausible-looking parser is quietly wrong: a
 * workflow argument that looks like a flag, a flag given without its value, a
 * negative number. Each one is a way for a command line to be misread as a
 * different command line, which is worse than being rejected.
 */

import 'jasmine';
import {
  flag,
  hasFlag,
  parseArgs,
  parseWorkflowArg,
  requireFlag,
  requirePositional,
} from '../../src/cli/args';

describe('cli arguments — flags and positionals', () => {
  it('reads --key=value, bare --key, and positionals in order', () => {
    const args = parseArgs(['start', 'greeter', '--queue=fast', '--wait']);

    expect(args.positionals).toEqual(['start', 'greeter']);
    expect(flag(args, 'queue')).toBe('fast');
    expect(hasFlag(args, 'wait')).toBe(true);
  });

  it('reports an absent flag as absent, not as empty', () => {
    const args = parseArgs(['start', 'greeter']);

    expect(flag(args, 'queue')).toBeUndefined();
    expect(hasFlag(args, 'queue')).toBe(false);
  });

  // A bare `--server` is someone who meant to redirect the command and did not
  // finish the thought. Reading it as the default sends the command to the last
  // place they would look for it.
  it('collapses a bare value-carrying flag to absent', () => {
    const args = parseArgs(['start', 'greeter', '--server']);

    expect(flag(args, 'server')).toBeUndefined();
    expect(hasFlag(args, 'server')).toBe(true);
  });

  it('keeps a value containing = intact', () => {
    const args = parseArgs(['start', '--server=http://h:7777/?a=b']);

    expect(flag(args, 'server')).toBe('http://h:7777/?a=b');
  });

  it('takes the last of a repeated flag', () => {
    const args = parseArgs(['start', '--queue=slow', '--queue=fast']);

    expect(flag(args, 'queue')).toBe('fast');
  });

  // No short flags exist, so a single dash is data — and a workflow taking a
  // negative number is the case that would break if it were not.
  it('treats a single-dash token as a positional', () => {
    const args = parseArgs(['start', 'adder', '-5', '-']);

    expect(args.positionals).toEqual(['start', 'adder', '-5', '-']);
  });
});

describe('cli arguments — the -- separator', () => {
  it('passes a flag-shaped workflow argument through as a positional', () => {
    const args = parseArgs([
      'start',
      'myWorkflow',
      '--wait',
      '--',
      '--this-is-an-argument',
    ]);

    expect(args.positionals).toEqual([
      'start',
      'myWorkflow',
      '--this-is-an-argument',
    ]);
    expect(hasFlag(args, 'wait')).toBe(true);
    expect(hasFlag(args, 'this-is-an-argument')).toBe(false);
  });

  it('stops flag parsing entirely, so a CLI flag after it is data', () => {
    const args = parseArgs(['start', 'greeter', '--', '--wait']);

    expect(args.positionals).toEqual(['start', 'greeter', '--wait']);
    expect(hasFlag(args, 'wait')).toBe(false);
  });

  it('keeps positionals from both sides in the order they were written', () => {
    const args = parseArgs(['start', 'wf', 'one', '--wait', '--', 'two']);

    expect(args.positionals).toEqual(['start', 'wf', 'one', 'two']);
  });

  it('reads a second -- as an ordinary argument', () => {
    const args = parseArgs(['start', 'wf', '--', '--', 'x']);

    expect(args.positionals).toEqual(['start', 'wf', '--', 'x']);
  });

  it('yields no extra arguments when -- ends the line', () => {
    const args = parseArgs(['start', 'wf', '--']);

    expect(args.positionals).toEqual(['start', 'wf']);
  });
});

describe('cli arguments — what it refuses', () => {
  it('names the flag that was missing', () => {
    expect(() => requireFlag(parseArgs(['up']), 'worker')).toThrowError(
      /missing --worker/,
    );
  });

  it('distinguishes a flag given without a value from one not given', () => {
    expect(() =>
      requireFlag(parseArgs(['up', '--worker']), 'worker'),
    ).toThrowError(/--worker needs a value/);
  });

  it('names the positional that was missing', () => {
    expect(() => requirePositional([], 0, 'workflow name')).toThrowError(
      /missing workflow name/,
    );
  });
});

describe('cli arguments — typing a workflow argument', () => {
  it('keeps an unquoted word as a string', () => {
    expect(parseWorkflowArg('world')).toBe('world');
  });

  it('reads numbers, booleans, and null as themselves', () => {
    expect(parseWorkflowArg('42')).toBe(42);
    expect(parseWorkflowArg('true')).toBe(true);
    expect(parseWorkflowArg('null')).toBeNull();
  });

  it('reads objects and arrays as structure', () => {
    expect(parseWorkflowArg('{"a":1}')).toEqual({a: 1});
    expect(parseWorkflowArg('[1,2]')).toEqual([1, 2]);
  });

  // The fallback is what makes the simple call simple; without it every string
  // argument would need shell-hostile embedded quotes.
  it('falls back to the raw string for anything unparseable', () => {
    expect(parseWorkflowArg('{not json')).toBe('{not json');
    expect(parseWorkflowArg('')).toBe('');
  });
});
