/**
 * @fileoverview
 * Turning what a server said about its bind into somewhere a caller can dial.
 *
 * A unit spec over a pure function, which is the point of the function existing:
 * the two rules worth pinning — wildcard substitution and IPv6 bracketing —
 * are decisions about a string, and binding a real socket to `::` or `0.0.0.0`
 * to exercise them would make the suite depend on which interfaces the machine
 * running it happens to have. The loopback case is covered against real
 * listeners in `spec/integration/health.spec.ts`; these are the cases a real
 * listener cannot reliably produce.
 *
 * What is *not* asserted anywhere, deliberately, is that the URL reaches the
 * server in a proxied or containerized deployment. It does not claim to — see
 * the declaration.
 */

import 'jasmine';
import {
  serverUrl,
  type ServerEndpoint,
  type ServerHealth,
} from '../../src/protocol';

function bound(host: string, port = 7777): ServerEndpoint {
  return {host, port, hostname: 'box-1'};
}

describe('serverUrl — where to dial a server that described its bind', () => {
  it('points a caller at the bound address when that address is dialable', () => {
    expect(serverUrl(bound('10.0.0.4', 7777))).toBe('http://10.0.0.4:7777');
  });

  /**
   * The substitution the function exists for: a wildcard says which interfaces
   * are accepted, and `http://0.0.0.0:7777` is not a place. Every interface
   * would be a correct answer, so the machine's own name is used — the one
   * candidate that does not require choosing an interface for the reader.
   */
  it('substitutes the machine hostname when the bind is a wildcard', () => {
    expect(serverUrl(bound('0.0.0.0', 7777))).toBe('http://box-1:7777');
    expect(serverUrl(bound('::', 7777))).toBe('http://box-1:7777');
  });

  it('brackets nothing when a wildcard resolved to a hostname, which has no colons', () => {
    expect(serverUrl(bound('::', 7777))).not.toContain('[');
  });

  /**
   * Unbracketed, `::1` and port 7777 concatenate to `http://::1:7777`, which
   * `URL` rejects outright — so the failure is not a subtly wrong address but a
   * consumer that cannot dial at all. Asserted through `URL` as well as by
   * string comparison, because "it parses" is the actual claim.
   */
  it('brackets an IPv6 literal so the URL parses back to a host and a port', () => {
    const url = serverUrl(bound('::1', 7777));

    expect(url).toBe('http://[::1]:7777');
    const parsed = new URL(url);
    // `URL` keeps the brackets on an IPv6 hostname; what matters is that the
    // address and the port came back separated at all.
    expect(parsed.hostname).toBe('[::1]');
    expect(parsed.port).toBe('7777');
  });

  /**
   * The absence that must not become an invention. A health reply from a server
   * nothing has told where it bound carries no endpoint, and the answer to
   * "where do I dial it" is that this cannot say — not a URL assembled from
   * whatever happened to be present. Same reasoning as `isNameServed` being
   * three-valued: "cannot tell" and a confident answer warrant different
   * responses.
   */
  it('says nothing when the reply carried no endpoint', () => {
    const health: ServerHealth = {uptimeMs: 5, durable: true};

    expect(serverUrl(health)).toBeUndefined();
    expect(serverUrl({})).toBeUndefined();
  });

  it('says nothing when a wildcard bind came without the hostname to replace it', () => {
    // Unreachable through `resolveEndpoint`, which reads both from one bind, but
    // this takes a `Partial` and the alternative to declining is `http://undefined:7777`.
    expect(serverUrl({host: '0.0.0.0', port: 7777})).toBeUndefined();
  });
});
