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
 *
 * The endpoint cases are here for the same reason and the same span: the host
 * does not bind anything, so what is being proved is that the tier that *did*
 * bind told it, and that the answer survived the wire. They bind a real port and
 * assert against what the listener reports rather than what it was asked for —
 * see `spec/protocol/server_url.spec.ts` for the string rules underneath.
 */

import {promises as fs} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {FileHistoryStore} from '../../src';
import {serverUrl, type ServerEndpoint} from '../../src/protocol';
import type {HistoryStore} from '../../src/server';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
  resolveEndpoint,
  type RemoteWorkflowService,
} from '../../src/services';

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-health-'));
}

interface Harness {
  service: RemoteWorkflowService;
  /** The port this harness bound, for the cases that assert on it. */
  port: number;
  teardown: () => Promise<void>;
}

interface HarnessOptions {
  store?: HistoryStore;
  /**
   * Tell the host where it was bound, the way `startServer` does. Off by
   * default, so the cases above it keep exercising a host that has been told
   * nothing — which is a real configuration and the one that pins the absence.
   */
  reportEndpoint?: boolean;
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  let endpoint: ServerEndpoint | undefined;
  const host = createServerHost(options.store, {endpoint: () => endpoint});
  const server: Server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as AddressInfo;
  if (options.reportEndpoint) endpoint = resolveEndpoint(address);
  return {
    service: createRemoteService(`http://127.0.0.1:${address.port}`),
    port: address.port,
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
    const {service, teardown} = await startHarness({store});
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

describe('server health — where the server says it is', () => {
  it('reports the interface and port its listener bound', async () => {
    const {service, port, teardown} = await startHarness({
      reportEndpoint: true,
    });
    try {
      const health = await service.health();

      // Asserted against the port the listener reported, not against a
      // requested one: the harness binds 0, which is the case the field exists
      // for — a caller that cannot read the resolved port has a server nothing
      // can be pointed at.
      expect(health.port).toBe(port);
      expect(health.host).toBe('127.0.0.1');
    } finally {
      await teardown();
    }
  });

  it('names the machine the server process runs on', async () => {
    const {service, teardown} = await startHarness({reportEndpoint: true});
    try {
      expect((await service.health()).hostname).toBe(os.hostname());
    } finally {
      await teardown();
    }
  });

  /**
   * The round trip the endpoint is for: what the server said about its bind,
   * put back through `serverUrl` on the reader's side, reaches the same server.
   *
   * That the URL is derived by the caller rather than shipped by the server is
   * the whole design — see the declaration for why a server cannot honestly
   * claim one. This pins the case where the inference is sound: nothing in front
   * of the server, so what it bound is what reaches it.
   */
  it('describes its bind well enough for a caller to dial it back', async () => {
    const {service, port, teardown} = await startHarness({
      reportEndpoint: true,
    });
    try {
      const url = serverUrl(await service.health());
      expect(url).toBe(`http://127.0.0.1:${port}`);

      expect((await createRemoteService(url!).health()).port).toBe(port);
    } finally {
      await teardown();
    }
  });

  /**
   * The host binds nothing itself, so a host nobody has told is a host that does
   * not know — and the three fields go missing together rather than arriving as
   * keys holding `undefined`. Pinned because the tempting alternative is for the
   * host to read its own `os.hostname()` and guess the rest, which would report
   * an endpoint for a server that is not listening on anything.
   */
  it('says nothing about an endpoint when nothing has told it where it bound', async () => {
    const {service, teardown} = await startHarness();
    try {
      const health = await service.health();
      expect('host' in health).toBeFalse();
      expect('port' in health).toBeFalse();
      expect('hostname' in health).toBeFalse();
      expect(serverUrl(health)).toBeUndefined();
    } finally {
      await teardown();
    }
  });
});
