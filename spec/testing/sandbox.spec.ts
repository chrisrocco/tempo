/**
 * @fileoverview
 * The sandbox entrypoint: the same harness, reached without a socket.
 *
 * What these pin is the claim that makes the entrypoint worth having — that a
 * caller's code does not change between transports. The dispatch switch is
 * shared with the HTTP server rather than copied, so the interesting assertions
 * are that `createSandbox` composes a *real* fleet (workers polling, manifests
 * reported, scenarios seeded) and that `dispatch` answers the same
 * `RpcRequest` a remote client would have sent.
 *
 * These run in Node, where `node:async_hooks` is real. They cannot prove the
 * browser shims are correct — only a browser can — but they prove everything
 * upstream of the shims, which is where a break would otherwise hide.
 */

import {createSandbox, SCENARIO_IDS, type Sandbox} from '../../src/sandbox';
import type {
  ExecutionDetail,
  ExecutionPage,
  ServerHealth,
  WorkflowSummary,
} from '../../src/protocol';

const SETUP_TIMEOUT_MS = 60_000;

describe('the sandbox entrypoint', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await createSandbox(['parked', 'settled-mixed'], {
      timeoutMs: 30_000,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await sandbox?.stop();
  });

  it('answers the same RpcRequest an HTTP client would have sent', async () => {
    const detail = (await sandbox.dispatch({
      method: 'describeExecution',
      workflowId: SCENARIO_IDS.parked,
      options: {},
    })) as ExecutionDetail;

    expect(detail.workflowId).toBe(SCENARIO_IDS.parked);
    expect(detail.status).toBe('running');
    expect(detail.parked.length).toBeGreaterThan(0);
  });

  it('seeds the states it was asked for', async () => {
    const page = (await sandbox.dispatch({
      method: 'listExecutions',
      filter: {},
    })) as ExecutionPage;
    const ids = page.executions.map((execution) => execution.workflowId);

    expect(ids).toContain(SCENARIO_IDS.parked);
    expect(ids).toContain(SCENARIO_IDS.completed);
    expect(ids).toContain(SCENARIO_IDS.failed);
  });

  /**
   * The reason the loops poll through the service seam rather than reaching
   * into the host: without a real fleet a catalogue view is empty, and "the
   * sandbox looks broken" is indistinguishable from "the dashboard is broken".
   */
  it('runs a real fleet, so the catalogue and queues are populated', async () => {
    const workflows = (await sandbox.dispatch({
      method: 'listWorkflows',
    })) as WorkflowSummary[];
    const queues = (await sandbox.dispatch({method: 'listQueues'})) as {
      taskQueue: string;
      workers: {identity: string}[];
    }[];

    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.some((w) => w.name === 'scenarioParks')).toBe(true);
    const served = queues.find((q) => q.taskQueue === sandbox.taskQueue);
    expect(served?.workers.length).toBeGreaterThan(0);
  });

  it('reports an address, so a dashboard does not take its not-found path', async () => {
    const health = (await sandbox.dispatch({
      method: 'health',
    })) as ServerHealth;

    expect(health.hostname).toBe('sandbox');
    expect(health.durable).toBe(false);
  });

  it('rejects an unknown method rather than answering null', async () => {
    await expectAsync(
      sandbox.dispatch({method: 'nonsense'} as never),
    ).toBeRejectedWithError(/unknown RPC method/);
  });
});
