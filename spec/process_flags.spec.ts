/**
 * @fileoverview
 * How a deployed process reads its own configuration out of its argv.
 *
 * The cases worth pinning are the ones where being lenient loses data silently:
 * a flag given without a value, and a numeric flag given something that is not a
 * number. As environment variables both mistakes are indistinguishable from
 * "unset" — and "unset" for `--data-dir` means a server that keeps its history in
 * memory and loses it on the next restart.
 */

import 'jasmine';
import {DEFAULT_PORT, flagValue, numericFlagValue} from '../src/process_flags';

describe('process flags — reading a value', () => {
  it('reads --name=value', () => {
    expect(flagValue(['--data-dir=/var/lib/tempo'], 'data-dir')).toBe(
      '/var/lib/tempo',
    );
  });

  it('reports a flag that was not given as absent', () => {
    expect(flagValue(['--port=7777'], 'data-dir')).toBeUndefined();
  });

  it('keeps a value containing = intact', () => {
    expect(flagValue(['--server=http://h:7777/?a=b'], 'server')).toBe(
      'http://h:7777/?a=b',
    );
  });

  // Both of these would name a different flag, and matching on a prefix is how a
  // process ends up configured by an argument meant for something else.
  it('does not match a flag whose name merely starts the same', () => {
    expect(flagValue(['--data-dir-old=/x'], 'data-dir')).toBeUndefined();
    expect(flagValue(['--portly=1'], 'port')).toBeUndefined();
  });

  /**
   * The constraint that makes this file possible: a worker is constructed
   * in-process by specs running under a test runner whose argv carries
   * `--config=` and `--filter=`. Rejecting an unrecognized flag would mean a
   * worker that cannot be built inside a spec.
   */
  it('ignores flags meant for something else', () => {
    expect(
      flagValue(
        ['--config=spec/support/jasmine.json', '--role=workflow'],
        'role',
      ),
    ).toBe('workflow');
  });
});

describe('process flags — what it refuses', () => {
  // `--data-dir` alone is someone who meant to say where the history goes.
  // Reading it as "unset" starts a server that loses everything on restart.
  it('refuses a flag given without a value', () => {
    expect(() => flagValue(['--data-dir'], 'data-dir')).toThrowError(
      /--data-dir needs a value/,
    );
    expect(() => flagValue(['--data-dir='], 'data-dir')).toThrowError(
      /--data-dir needs a value/,
    );
  });

  // NaN reaches listen() as "pick any port", so the process would come up
  // healthy on a port nothing was told about.
  it('refuses a numeric flag that is not a number', () => {
    expect(() => numericFlagValue(['--port=localhost'], 'port')).toThrowError(
      /--port must be a number \(got "localhost"\)/,
    );
  });

  it('reads a numeric flag that is one, including zero', () => {
    expect(numericFlagValue(['--port=7777'], 'port')).toBe(7777);
    expect(numericFlagValue(['--port=0'], 'port')).toBe(0);
    expect(numericFlagValue([], 'port')).toBeUndefined();
  });
});

describe('process flags — the shared default', () => {
  it('is the port a deployment uses when nothing says otherwise', () => {
    expect(DEFAULT_PORT).toBe(7777);
  });
});
