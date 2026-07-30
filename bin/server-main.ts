// Deployable process main: the server tier. Hosts the headless server host over
// RPC and owns the durable state + timers. Workflow/activity workers connect to
// it. Env: PORT (0 = random), ACTIVITY_LEASE_MS (short values force redelivery).
import type { AddressInfo } from 'node:net';
import { createRpcServer, createServerHost } from '../src/services';

const port = process.env.PORT ? Number(process.env.PORT) : 0;
const activityLeaseMs = process.env.ACTIVITY_LEASE_MS ? Number(process.env.ACTIVITY_LEASE_MS) : undefined;

const host = createServerHost(undefined, { activityLeaseMs });
const server = createRpcServer(host);

server.listen(port, '127.0.0.1', () => {
  const addr = server.address() as AddressInfo;
  // Readiness line — the port it actually bound (so a supervisor/test can connect).
  console.log(`LISTENING ${addr.port}`);
});

function shutdown(): void {
  host.shutdown();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
