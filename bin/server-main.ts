// Deployable process main: the server tier. Hosts the headless server host over
// RPC and owns the durable state + timers. Workflow/activity workers connect to it.
//
// Env:
//   PORT               listen port (0 = random). Prints `LISTENING <port>` once bound.
//   DATA_DIR           if set, persist to a filesystem HistoryStore at this path and
//                      `resume()` running executions on boot. If unset, in-memory
//                      (fast, non-durable) — the default used by tests.
//   ACTIVITY_LEASE_MS  activity-task lease timeout (short values force redelivery).
import type { AddressInfo } from 'node:net';
import { FileHistoryStore } from '../src';
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
  const host = createServerHost(store, { activityLeaseMs });
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
