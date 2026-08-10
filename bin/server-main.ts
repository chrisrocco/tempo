/**
 * @fileoverview
 * Deployable process main: the server tier. Hosts the headless server host over
 * RPC and owns the durable state + timers. Workflow/activity workers connect to it.
 *
 * Flags — see `src/process_flags.ts` for why these are flags and not environment
 * variables:
 *   --host=ADDR            interface to bind (default `127.0.0.1`). `0.0.0.0`
 *                          accepts connections from other machines — see the
 *                          warning below.
 *   --port=N               listen port (default 7777, 0 = random). Prints
 *                          `LISTENING <port> <host>` once bound.
 *   --data-dir=PATH        if set, persist to a filesystem HistoryStore at this
 *                          path and `resume()` running executions on boot. If
 *                          unset, in-memory (fast, non-durable) — the default
 *                          used by tests.
 *   --activity-lease-ms=N  activity-task lease timeout (short values force
 *                          redelivery). Must exceed the largest
 *                          `startToCloseTimeoutMs` any activity sets, or the
 *                          lease redelivers the task before its own deadline is
 *                          reached and the timeout never gets to decide.
 *
 * **The port defaults to 7777 rather than to 0.** A random default is right for a
 * test and wrong for a deployment: workers dial `DEFAULT_SERVER_URL`, so a server
 * that picked its own port would be one nothing could find, with every unit
 * reading healthy. Tests that want an arbitrary port ask for `--port=0`.
 *
 * Lifecycle events are written to **stderr as JSON Lines** — one object per
 * event, `{ts, event, ...fields}` (see `server/json_logger.ts`). stdout carries
 * only the readiness line. Nothing aggregates or alerts on these yet; they are
 * the source a metrics backend consumes later without any call site changing.
 *
 * ## Operational notes
 *
 * - **Binds `127.0.0.1` by default.** Right for a single VM with everything
 *   co-located, and the right default because it is the only one that is safe
 *   without further thought. Pass `--host=0.0.0.0` to put workers or an external
 *   CLI on other machines — but the RPC has **no auth and no TLS** (see
 *   rpc_server.ts), so anything that can reach the port can start, signal, and
 *   terminate executions. Keep it on a private network or behind a proxy that
 *   terminates TLS and authenticates; do not expose it to the internet.
 * - **One server per data dir.** The `--data-dir` lockfile enforces it. A crashed
 *   server's stale lock self-heals: the next boot checks whether the recorded pid
 *   is still alive and reclaims it, so a supervisor with `Restart=always` will not
 *   deadlock on a lock the dead process never released.
 * - **Single writer, single point of failure.** Scaling is horizontal on
 *   *workers*; server HA is Phase 6 and not built.
 * - **Restart is safe.** On boot with `--data-dir` it reloads history and
 *   `resume()`s: pending timers re-arm, unfinished activities re-dispatch, blocked
 *   children reconnect (proved in spec/integration/resume.spec.ts).
 */

import type {AddressInfo} from 'node:net';
import {FileHistoryStore} from '../src';
import {
  DEFAULT_PORT,
  SERVER_FLAG,
  flagValue,
  numericFlagValue,
} from '../src/process_flags';
import {createJsonLogger} from '../src/server';
import {createRpcServer, createServerHost} from '../src/services';

const argv = process.argv.slice(2);

// Named `bindHost`, not `host`: `main` binds a local `host` to the server host
// object, which would shadow this and silently pass an object to `listen`.
const bindHost = flagValue(argv, SERVER_FLAG.host) ?? '127.0.0.1';
const port = numericFlagValue(argv, SERVER_FLAG.port) ?? DEFAULT_PORT;
const activityLeaseMs = numericFlagValue(argv, SERVER_FLAG.activityLeaseMs);
const dataDir = flagValue(argv, SERVER_FLAG.dataDir);

async function main(): Promise<void> {
  // Durable when --data-dir is set (a single-writer lockfile guards the dir);
  // otherwise in-memory. `undefined` lets createServerHost default the store.
  const store = dataDir ? await FileHistoryStore.open(dataDir) : undefined;
  // Structured lifecycle events on stderr; stdout stays reserved for the
  // readiness line supervisors and the specs parse.
  const host = createServerHost(store, {
    activityLeaseMs,
    log: createJsonLogger(),
  });
  if (store) await host.resume(); // re-arm timers, re-dispatch pending work, re-drive running execs

  const server = createRpcServer(host);
  server.listen(port, bindHost, () => {
    const addr = server.address() as AddressInfo;
    // Readiness line — the port it actually bound (so a supervisor/test can
    // connect). The host is appended rather than substituted: existing readers
    // match `LISTENING (\d+)`, and that keeps matching.
    console.log(`LISTENING ${addr.port} ${addr.address}`);
  });

  function shutdown(): void {
    host.shutdown();
    (server as {closeAllConnections?: () => void}).closeAllConnections?.();
    server.close(() => {
      void Promise.resolve(store?.close()).finally(() => process.exit(0)); // release the lockfile
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
