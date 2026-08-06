/**
 * @fileoverview
 * The server health probe, over the wire.
 *
 * An integration spec rather than a unit one because the thing worth proving
 * spans four layers that each had to agree: the store knows whether it is
 * durable, the host reads it off the store, the RPC dispatches a method with no
 * arguments, and `RemoteService` gets a typed answer back. A stub host would
 * prove none of that and would still pass if the wire format were wrong.
 *
 * The durable case runs against a real `FileHistoryStore` on a throwaway dir,
 * because "reports durability it does not have" is the specific failure this
 * exists to prevent — and only a real store can be wrong about it.
 */

import {promises as fs} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {FileHistoryStore} from '../../src';
import type {HistoryStore} from '../../src/server';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
  type RemoteWorkflowService,
} from '../../src/services';

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-health-'));
}

interface Harness {
  service: RemoteWorkflowService;
  teardown: () => Promise<void>;
}

async function startHarness(store?: HistoryStore): Promise<Harness> {
  const host = createServerHost(store);
  const server: Server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  return {
    service: createRemoteService(`http://127.0.0.1:${port}`),
    teardown: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('server health — what a server says about itself', () => {
  it('answers a probe over the wire', async () => {
    const {service, teardown} = await startHarness();
    try {
      const health = await service.health();
      expect(health.durable).toBe(false);
      expect(typeof health.uptimeMs).toBe('number');
    } finally {
      await teardown();
    }
  });

  /**
   * The reply arriving *is* the liveness signal, so there is deliberately no
   * `ok` field to check. This pins that: a caller writing `if (health.ok)`
   * would be branching on undefined, and the type should not offer it.
   */
  it('carries no liveness flag, because arriving is the liveness signal', async () => {
    const {service, teardown} = await startHarness();
    try {
      expect(Object.keys(await service.health()).sort()).toEqual([
        'durable',
        'uptimeMs',
      ]);
    } finally {
      await teardown();
    }
  });

  it('reports an in-memory server as non-durable with nowhere to point at', async () => {
    const {service, teardown} = await startHarness();
    try {
      const health = await service.health();
      expect(health.durable).toBe(false);
      expect(health.dataLocation).toBeUndefined();
    } finally {
      await teardown();
    }
  });

  it('reports a file-backed server as durable, and where its state lives', async () => {
    const dir = await tmpDir();
    const store = await FileHistoryStore.open(dir);
    const {service, teardown} = await startHarness(store);
    try {
      const health = await service.health();
      expect(health.durable).toBe(true);
      expect(health.dataLocation).toBe(dir);
    } finally {
      await teardown();
      await store.close();
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  /**
   * Uptime is measured from when the host was constructed, not from when the
   * probe arrived — the bug this catches is a `Date.now()` read inside `health`
   * on both sides of the subtraction, which reports zero forever.
   */
  it('measures uptime from the server starting, and it advances', async () => {
    const {service, teardown} = await startHarness();
    try {
      const first = await service.health();
      await new Promise<void>((r) => setTimeout(r, 25));
      const second = await service.health();
      expect(second.uptimeMs).toBeGreaterThan(first.uptimeMs);
    } finally {
      await teardown();
    }
  });
});
