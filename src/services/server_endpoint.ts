/**
 * @fileoverview
 * What a listener observed about itself, gathered once at bind.
 *
 * Small on purpose, and the size is the design. This reads the two things only
 * the binding process can know — the address the socket actually got, and the
 * name of the machine it got it on — and stops there. Turning those into a URL
 * somebody can dial is an *inference*, and it lives in `protocol/serverUrl`
 * instead, for the reasons written at that function: the server cannot see what
 * sits in front of it, so the guess belongs to the reader who can correct it,
 * and it has to be importable by a browser, which this module (`node:os`,
 * `node:net`) will never be.
 *
 * It exists at all because `server_main.ts` and `testing/index.ts` both bind
 * their own listener and both owe the host the same answer. Doing it here rather
 * than at each call site also fixes *when*: once, at bind, rather than on every
 * probe. `ServerHost.health()` promises to answer from memory, and an
 * `os.hostname()` syscall on every supervisor poll would be a small, permanent,
 * entirely avoidable cost on the one call that must not get slower.
 */

import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import type {ServerEndpoint} from '../protocol';

/**
 * What a bound listener is, as `ServerHealth` reports it.
 *
 * Takes the `AddressInfo` from a `listen` callback rather than the host and port
 * that were *asked* for: under `--port=0` those are not the same, and the
 * resolved one is the whole point.
 */
export function resolveEndpoint(address: AddressInfo): ServerEndpoint {
  return {host: address.address, port: address.port, hostname: os.hostname()};
}
