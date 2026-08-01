/**
 * @fileoverview
 * Deployable process main: the server tier. Hosts the headless server host over
 * RPC and owns the durable state + timers. Workflow/activity workers connect to it.
 *
 * Env:
 *   PORT               listen port (0 = random). Prints `LISTENING <port>` once bound.
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
 * - **Binds `127.0.0.1`.** Right for a single VM with everything co-located. To
 *   put workers on other machines, change the bind to `0.0.0.0` and keep the port
 *   on a private network — the RPC has no auth and no TLS (see rpc_server.ts).
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

import type { AddressInfo } from 'node:net';
import { FileHistoryStore } from '../src';
import { createJsonLogger } from '../src/server';
import { createRpcServer, createServerHost } from '../src/services';

const port = process.env.PORT ? Number(process.env.PORT) : 0;
const activityLeaseMs = process.env.ACTIVITY_LEASE_MS
  ? Number(process.env.ACTIVITY_LEASE_MS)
  : undefined;
const dataDir = process.env.DATA_DIR;

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

  const server = createRpcServer(host);
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    // Readiness line — the port it actually bound (so a supervisor/test can connect).
    console.log(`LISTENING ${addr.port}`);
  });

  function shutdown(): void {
    host.shutdown();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => {
      void Promise.resolve(store?.close()).finally(() => process.exit(0)); // release the lockfile
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
