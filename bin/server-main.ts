/**
 * @fileoverview
 * Deployable process main: the server tier. Hosts the headless server host over
 * RPC and owns the durable state + timers. Workflow/activity workers connect to it.
 *
 * Env:
 *   UI_ROOT            serve the dashboard at /ui from this directory. Unset =
 *                      no UI, which is the default: the dashboard can terminate
 *                      executions and the transport has no auth.
 *   HOST               interface to bind (default `127.0.0.1`). `0.0.0.0` accepts
 *                      connections from other machines — see the warning below.
 *   PORT               listen port (0 = random). Prints `LISTENING <port> <host>`
 *                      once bound.
 *   DATA_DIR           if set, persist to a filesystem HistoryStore at this path and
 *                      `resume()` running executions on boot. If unset, in-memory
 *                      (fast, non-durable) — the default used by tests.
 *   ACTIVITY_LEASE_MS  activity-task lease timeout (short values force redelivery).
 *                      Must exceed the largest `startToCloseTimeoutMs` any activity
 *                      sets, or the lease redelivers the task before its own
 *                      deadline is reached and the timeout never gets to decide.
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
 *   without further thought. Set `HOST=0.0.0.0` to put workers or an external CLI
 *   on other machines — but the RPC has **no auth and no TLS** (see
 *   rpc_server.ts), so anything that can reach the port can start, signal, and
 *   terminate executions. Keep it on a private network or behind a proxy that
 *   terminates TLS and authenticates; do not expose it to the internet.
 * - **One server per data dir.** The `DATA_DIR` lockfile enforces it. A crashed
 *   server's stale lock self-heals: the next boot checks whether the recorded pid
 *   is still alive and reclaims it, so a supervisor with `Restart=always` will not
 *   deadlock on a lock the dead process never released.
 * - **Single writer, single point of failure.** Scaling is horizontal on
 *   *workers*; server HA is Phase 6 and not built.
 * - **Restart is safe.** On boot with `DATA_DIR` it reloads history and
 *   `resume()`s: pending timers re-arm, unfinished activities re-dispatch, blocked
 *   children reconnect (proved in spec/integration/resume.spec.ts).
 */

import type {AddressInfo} from 'node:net';
import * as path from 'node:path';
import {FileHistoryStore} from '../src';
import {createJsonLogger} from '../src/server';
import {createRpcServer, createServerHost} from '../src/services';

// Named `bindHost`, not `host`: `main` binds a local `host` to the server host
// object, which would shadow this and silently pass an object to `listen`.
const bindHost = process.env['HOST'] ?? '127.0.0.1';
const port = process.env['PORT'] ? Number(process.env['PORT']) : 0;
const activityLeaseMs = process.env['ACTIVITY_LEASE_MS']
  ? Number(process.env['ACTIVITY_LEASE_MS'])
  : undefined;
const dataDir = process.env['DATA_DIR'];
// Absolute, because the UI root is resolved against it on every request and the
// server's working directory is not something a caller should have to reason about.
const uiRoot = process.env['UI_ROOT']
  ? path.resolve(process.env['UI_ROOT'])
  : undefined;

async function main(): Promise<void> {
  // Durable when DATA_DIR is set (a single-writer lockfile guards the dir);
  // otherwise in-memory. `undefined` lets createServerHost default the store.
  const store = dataDir ? await FileHistoryStore.open(dataDir) : undefined;
  // Structured lifecycle events on stderr; stdout stays reserved for the
  // readiness line supervisors and the specs parse.
  const host = createServerHost(store, {
    activityLeaseMs,
    log: createJsonLogger(),
  });
  if (store) await host.resume(); // re-arm timers, re-dispatch pending work, re-drive running execs

  // The dashboard is opt-in. It can terminate executions and the transport has
  // no auth, so a server that was not asked to serve a UI does not serve one.
  const server = createRpcServer(host, {
    ui: uiRoot
      ? {
          uiRoot,
          nodeModules: path.resolve('node_modules'),
          srcRoot: path.resolve('src'),
        }
      : undefined,
  });
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
