/**
 * @fileoverview
 * `status` against a recording `Host` and a real server.
 *
 * The case worth the most is the one where the two sources disagree: systemd says
 * the process is up and the server says nothing is polling. That is a deployment
 * that looks healthy from the outside and is not doing any work, and it is the
 * whole reason `status` asks both.
 *
 * The second is that an unreachable server is an **answer**. A status that threw
 * on a refused connection could never say "the units are up and nothing is
 * listening", which is the most useful thing it will ever be asked to report.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {status, type DeploymentStatus, type UnitState} from '../../src/deploy';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker} from '../../src/tempo';
import {fakeHost} from '../support/fake_host';

/** systemd's answer for a unit that is up and enabled. */
function showing(activeState: string, fileState = 'enabled', restarts = 0) {
  return {
    match: 'show',
    result: {
      stdout: `ActiveState=${activeState}\nUnitFileState=${fileState}\nLoadState=loaded\nNRestarts=${restarts}\n`,
    },
  };
}

/**
 * The units out of a report, insisting they were readable.
 *
 * Both halves of a `DeploymentStatus` are optional, so reading either means saying
 * which case you expected. These specs supply a fake `systemctl`, so "unavailable"
 * here is a spec bug rather than a scenario.
 */
function unitsOf(report: DeploymentStatus): readonly UnitState[] {
  if (!report.systemd.available)
    throw new Error(`expected systemd to answer: ${report.systemd.reason}`);
  return report.systemd.units;
}

interface Harness {
  url: string;
  teardown: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const host = createServerHost();
  const server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    teardown: async () => {
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function greeter(name: string): Promise<string> {
  return `Hello, ${name}!`;
}

describe('status — reading systemd', () => {
  it('reports every unit, server first', async () => {
    const host = fakeHost({responses: [showing('active')]});
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(unitsOf(report).map((u) => u.unit)).toEqual([
      'tempo-server',
      'tempo-worker-workflow',
      'tempo-worker-activity',
    ]);
    expect(unitsOf(report)[0]?.activeState).toBe('active');
    expect(unitsOf(report)[0]?.fileState).toBe('enabled');
  });

  it('carries the restart count, which is how a crash loop is visible at all', async () => {
    const host = fakeHost({responses: [showing('active', 'enabled', 47)]});
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(unitsOf(report)[0]?.restarts).toBe(47);
  });

  /**
   * A unit systemd has never heard of reports `UnitFileState=` empty, with
   * `LoadState` carrying the answer. Reporting the empty string would read as "it
   * exists and I could not tell", which is a worse answer than "not deployed".
   */
  it('says not-found for a unit that was never installed', async () => {
    const host = fakeHost({
      responses: [
        {
          match: 'show',
          result: {
            stdout:
              'ActiveState=inactive\nUnitFileState=\nLoadState=not-found\n',
          },
        },
      ],
    });
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(unitsOf(report)[0]?.fileState).toBe('not-found');
  });

  it('needs no root, unlike up and down', async () => {
    const host = fakeHost({euid: 1000, responses: [showing('active')]});

    await expectAsync(
      status({serverUrl: 'http://127.0.0.1:1'}, host),
    ).toBeResolved();
  });
});

/**
 * The other half of "report what you found". Found by assembling a CLI on a
 * machine with no systemd and watching `status` throw `spawn systemctl ENOENT`:
 * the degrade-rather-than-throw rule had been applied to the server half and not
 * to this one, which is the one thing a status command must never do.
 */
describe('status — a machine without systemd is an answer too', () => {
  /** What `Host.run` does for a command that is not installed. */
  const noSystemctl = {
    match: 'systemctl',
    result: {throws: 'spawn systemctl ENOENT'},
  };

  it('reports systemd as unavailable rather than throwing', async () => {
    const host = fakeHost({responses: [noSystemctl]});
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(report.systemd.available).toBe(false);
    if (!report.systemd.available)
      expect(report.systemd.reason).toContain('ENOENT');
  });

  // The point of degrading: everything the server had to say still arrives.
  it('still reports the server when systemd cannot be consulted', async () => {
    const server = await startServer();
    const host = fakeHost({responses: [noSystemctl]});

    try {
      const report = await status({serverUrl: server.url}, host);

      expect(report.systemd.available).toBe(false);
      expect(report.server.reachable).toBe(true);
      if (report.server.reachable)
        expect(report.server.health.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await server.teardown();
    }
  }, 15000);

  // Not knowing is not the same as being fine.
  it('never calls a deployment healthy on a source it could not consult', async () => {
    const host = fakeHost({responses: [noSystemctl]});
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(report.healthy).toBe(false);
  });
});

describe('status — an unreachable server is an answer', () => {
  it('reports the units and names what it could not reach', async () => {
    const host = fakeHost({responses: [showing('active')]});
    const report = await status({serverUrl: 'http://127.0.0.1:1'}, host);

    expect(report.server.reachable).toBe(false);
    if (!report.server.reachable) {
      expect(report.server.serverUrl).toBe('http://127.0.0.1:1');
      expect(report.server.reason).toBeTruthy();
    }
    // The half that does not depend on the server is still there.
    expect(unitsOf(report).length).toBe(3);
    expect(report.healthy).toBe(false);
  });
});

describe('status — reading the fleet', () => {
  it('reports a worker that is actually polling', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      identity: 'spec-worker',
      workflows: {greeter},
      activities: {},
    });
    const host = fakeHost({responses: [showing('active')]});

    try {
      // The first poll is what registers a worker, so wait for one to land.
      let report = await status({serverUrl: server.url}, host);
      const deadline = Date.now() + 5000;
      while (
        report.server.reachable &&
        report.server.queues.length === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
        report = await status({serverUrl: server.url}, host);
      }

      expect(report.server.reachable).toBe(true);
      if (report.server.reachable) {
        const queue = report.server.queues.find(
          (q) => q.taskQueue === 'default',
        );
        expect(queue?.workflowServed).toBe(true);
        expect(queue?.workers).toContain('spec-worker');
      }
    } finally {
      await worker.stop();
      await server.teardown();
    }
  }, 15000);

  /**
   * The case the whole function exists for. systemd is satisfied — the process is
   * up — and the work is going nowhere because nothing polls the queue it was
   * started on. Neither source can see this alone.
   */
  it('names a queue with running work and nothing serving it', async () => {
    const server = await startServer();
    const host = fakeHost({responses: [showing('active')]});

    try {
      const service = createRemoteService(server.url);
      service.start('greeter', ['world'], {taskQueue: 'nobody-serves-this'});

      // Let the start land before asking about it.
      await new Promise((r) => setTimeout(r, 50));
      const report = await status({serverUrl: server.url}, host);

      expect(report.server.reachable).toBe(true);
      if (report.server.reachable)
        expect(report.server.unservedQueues).toContain('nobody-serves-this');
      // Every unit is active and the deployment is still not healthy, which is
      // exactly the judgement a units-only status could not make.
      expect(unitsOf(report).every((u) => u.activeState === 'active')).toBe(
        true,
      );
      expect(report.healthy).toBe(false);
    } finally {
      await server.teardown();
    }
  }, 15000);

  /**
   * The catastrophic-and-invisible case, and the reason `status` asks for health
   * at all. A server keeping history in memory completes workflows normally, reads
   * `active` to systemd, and loses every execution on its next restart. It is what
   * a server started without `--data-dir` looks like, and nothing else reports it.
   */
  it('reports a non-durable server, and refuses to call it healthy', async () => {
    const server = await startServer();
    const host = fakeHost({responses: [showing('active')]});

    try {
      const report = await status({serverUrl: server.url}, host);

      expect(report.server.reachable).toBe(true);
      if (report.server.reachable) {
        // This spec's server is in-memory, which is exactly the condition.
        expect(report.server.health.durable).toBe(false);
        expect(report.server.health.uptimeMs).toBeGreaterThanOrEqual(0);
      }
      expect(unitsOf(report).every((u) => u.activeState === 'active')).toBe(
        true,
      );
      expect(report.healthy).toBe(false);
    } finally {
      await server.teardown();
    }
  }, 15000);

  // An idle pool nobody is using is not a problem, and reporting it as one trains
  // an operator to ignore the field that matters.
  it('does not call an idle queue unserved', async () => {
    const server = await startServer();
    const host = fakeHost({responses: [showing('active')]});

    try {
      const report = await status({serverUrl: server.url}, host);

      expect(report.server.reachable).toBe(true);
      if (report.server.reachable)
        expect(report.server.unservedQueues).toEqual([]);
    } finally {
      await server.teardown();
    }
  }, 15000);
});
