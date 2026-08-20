/**
 * @fileoverview
 * An activity's stack, from the line that threw to the operator reading the CLI.
 *
 * The stack is the one part of a failure that cannot be reconstructed after the
 * fact: it lives on the thrown `Error`, in the worker process, and every hop from
 * there to a client is a place that can flatten the failure to `.message`. There
 * are four, and any one of them silently undoes the others — which is why this is
 * pinned end to end rather than at a single seam.
 *
 * The frame these tests look for is the *activity's own*, not the engine's. A
 * stack that survives the trip but points at replay machinery would satisfy a
 * looser assertion while being exactly as useless as no stack at all.
 */

import {createLocalRuntime} from '../../src';
import type {ActivityFn, WorkflowFn} from '../../src';
import {createLocalService} from '../../src/services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
} from '../../src/worker';
import {runActivity} from '../../src/workflow';

/** Throws from a named frame, so the assertions can look for it by name. */
function explode(): never {
  throw new TypeError('Cannot read properties of undefined (reading "name")');
}

/**
 * A service rather than a `Runtime`, because the record-level assertions need
 * `describeExecution`, which the runtime handle does not expose.
 */
function serviceWith(workflow: WorkflowFn, activity?: ActivityFn) {
  const workflows = createWorkflowRegistry();
  workflows.set('wf', workflow);
  const activities = createActivityRegistry();
  if (activity) activities.set('boom', activity);
  return createLocalService(
    createWorkflowWorker(workflows),
    createActivityWorker(activities),
  );
}

describe('an activity failure carries its stack', () => {
  it('reaches a workflow that catches it, with the origin frame intact', async () => {
    let seen: string | undefined;
    const rt = createLocalRuntime()
      .registerActivity('boom', () => explode())
      .registerWorkflow('wf', async () => {
        try {
          await runActivity('boom');
          return 'unreachable';
        } catch (e) {
          seen = (e as Error).stack;
          return 'caught';
        }
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo('caught');
    expect(seen).toContain('explode');
  });

  /**
   * The replacement is the point. The `Error` rebuilt during replay is born with
   * a stack describing apply_event — the engine, in a different process from the
   * failure, re-derived on every replay. Keeping it would look like a stack while
   * naming nothing the reader can act on.
   */
  it('replaces the stack replay would otherwise synthesize', async () => {
    let seen: string | undefined;
    const rt = createLocalRuntime()
      .registerActivity('boom', () => explode())
      .registerWorkflow('wf', async () => {
        try {
          await runActivity('boom');
        } catch (e) {
          seen = (e as Error).stack;
        }
        return 'done';
      });

    await rt.start('wf').result();
    expect(seen).not.toContain('apply_event');
  });

  it('reaches the execution record when the workflow does not catch it', async () => {
    const service = serviceWith(
      async () => runActivity('boom'),
      () => explode(),
    );
    const {workflowId} = service.start('wf');
    await expectAsync(service.getResult(workflowId)).toBeRejected();

    const detail = await service.describeExecution(workflowId);
    expect(detail!.status).toBe('failed');
    expect(detail!.failureStack).toContain('explode');
  });

  // A stack is the one thing here with no fallback, so a thrown non-Error must
  // degrade to "no stack" rather than crash the reporting path.
  it('survives an activity that throws something with no stack', async () => {
    const service = serviceWith(
      async () => runActivity('boom'),
      () => {
        throw 'a bare string';
      },
    );
    const {workflowId} = service.start('wf');
    await expectAsync(service.getResult(workflowId)).toBeRejected();

    const detail = await service.describeExecution(workflowId);
    expect(detail!.status).toBe('failed');
    expect(detail!.failureStack).toBeUndefined();
  });

  // Guards the view's own condition: a terminated execution's reason is an
  // operator's sentence, and there is no stack behind it to attach.
  it('reports no stack for an execution an operator terminated', async () => {
    const service = serviceWith(async () => new Promise(() => {}));
    const {workflowId} = service.start('wf');
    service.terminate(workflowId, 'operator gave up');
    await expectAsync(service.getResult(workflowId)).toBeRejected();

    const detail = await service.describeExecution(workflowId);
    expect(detail!.status).toBe('terminated');
    expect(detail!.failureStack).toBeUndefined();
  });
});
