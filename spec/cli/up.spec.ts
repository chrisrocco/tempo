/**
 * @fileoverview
 * Turning the address the server *bound* into one a client can *dial*.
 *
 * These are not the same thing, and conflating them is the bug this function
 * exists to prevent: `tempo up` hands the URL it builds to the worker it spawns,
 * so a wildcard passed through verbatim would produce `http://0.0.0.0:port` and a
 * worker that cannot connect on the stacks where dialing a wildcard is not a
 * shorthand for loopback.
 */

import {connectableHost, isLoopbackHost} from '../../src/cli/up';

describe('connectableHost', () => {
  it('passes through an address that is already dialable', () => {
    expect(connectableHost('127.0.0.1')).toBe('127.0.0.1');
    expect(connectableHost('192.168.1.10')).toBe('192.168.1.10');
  });

  /**
   * The case the function exists for. `0.0.0.0` is not an address — it is "every
   * IPv4 interface" — so it names no host to connect to. Loopback is the one
   * address guaranteed to be among those it just bound.
   */
  it('maps the IPv4 wildcard to loopback', () => {
    expect(connectableHost('0.0.0.0')).toBe('127.0.0.1');
  });

  it('maps the IPv6 wildcard to IPv6 loopback, bracketed', () => {
    expect(connectableHost('::')).toBe('[::1]');
    expect(connectableHost('::0')).toBe('[::1]');
  });

  // `http://::1:7233` has no unambiguous reading — the brackets are what make the
  // port separable from the address.
  it('brackets an IPv6 literal so the port stays parseable', () => {
    expect(connectableHost('::1')).toBe('[::1]');
    expect(connectableHost('fe80::1')).toBe('[fe80::1]');
  });

  // Node reports an empty address for some wildcard binds rather than 0.0.0.0.
  it('treats an empty address as the wildcard', () => {
    expect(connectableHost('')).toBe('127.0.0.1');
  });

  it('leaves a hostname alone', () => {
    expect(connectableHost('localhost')).toBe('localhost');
  });
});

/**
 * This drives the "reachable from other machines" warning. A warning that fires
 * on a private bind is worse than none — it teaches people to ignore the one
 * that matters.
 */
describe('isLoopbackHost', () => {
  it('recognises loopback in both families', () => {
    expect(isLoopbackHost('127.0.0.1')).toBeTrue();
    expect(isLoopbackHost('::1')).toBeTrue();
    expect(isLoopbackHost('localhost')).toBeTrue();
  });

  // The whole 127.0.0.0/8 block is loopback, not just the canonical address.
  it('recognises the rest of the 127 block', () => {
    expect(isLoopbackHost('127.0.0.53')).toBeTrue();
    expect(isLoopbackHost('127.1.2.3')).toBeTrue();
  });

  it('does not recognise a wildcard or a routable address', () => {
    expect(isLoopbackHost('0.0.0.0')).toBeFalse();
    expect(isLoopbackHost('::')).toBeFalse();
    expect(isLoopbackHost('192.168.1.10')).toBeFalse();
  });
});
