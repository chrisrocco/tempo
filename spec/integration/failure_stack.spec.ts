/**
 * @fileoverview
 * An activity's stack, from the line that threw to the operator reading the CLI.
 *
 * The stack is the one part of a failure that cannot be reconstructed after the
 * fact: it lives on the thrown `Error`, in the worker process, and every hop from
 * there to a client is a place that used to flatten the failure to `.message`.
 * There were four, and any one of them silently undoes the others — which is why
 * this is pinned end to end rather than at a single seam.
 *
 * The frame these tests look for is the *activity's own*, not the engine's. A
 * stack that survives the trip but points at replay machinery would satisfy a
 * looser assertion while being exactly as useless as no stack at all.
 *
 * The second half — connecting those frames to the workflow line that awaited
 * them — has its own describe below, because it is a different mechanism: the
 * origin is recorded where the throw happened, the await site is captured where
 * the command was issued, and `apply_event` stitches the two (issue #116).
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
import {
  CancelledFailure,
  executeChild,
  runActivity,
  sleep,
} from '../../src/workflow';

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

  /**
   * A thrown non-Error has no origin frames to record, and none are invented —
   * but the await site is real and is stitched on anyway, clearly labelled,
   * because then it is the only pointer the reader gets. The message survives
   * whole rather than as the literal text "undefined", which is what reading
   * `.message` off a string used to record.
   */
  it('stitches only the await site when the origin has no stack', async () => {
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
    expect(detail!.failureStack).toContain('Error: a bare string');
    expect(detail!.failureStack).toContain('--- awaited by workflow at ---');
    expect(detail!.failureStack).toContain('failure_stack.spec');
    // No origin frames were invented: the seam is the first thing after the header.
    expect(detail!.failureStack!.split('\n')[1]).toContain(
      'awaited by workflow',
    );
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

/**
 * The other half of the trip: the frames above cannot name the workflow line
 * that awaited the failure, because V8 never stamps a resuming await onto a
 * rejected promise and the recorded stack comes from a different process. The
 * engine stitches the await site — captured when the command was issued — onto
 * the rebuilt error, behind a labelled seam, so one read connects the line that
 * threw to the line that waited.
 */
describe('a failure names the workflow await site', () => {
  it('stitches the await site after the origin frames, behind a labelled seam', async () => {
    let seen = '';
    const rt = createLocalRuntime()
      .registerActivity('boom', () => explode())
      .registerWorkflow('wf', async () => {
        try {
          await runActivity('boom');
        } catch (e) {
          seen = (e as Error).stack ?? '';
        }
        return 'done';
      });

    await rt.start('wf').result();
    const [origin, awaited] = seen.split('--- awaited by workflow at ---');
    // The origin half holds the activity's frames; the awaited half holds the
    // workflow's own call, which lives in this file too — the split is what
    // proves each half is on its own side of the seam.
    expect(origin).toContain('explode');
    expect(awaited).toContain('failure_stack.spec');
    expect(awaited).not.toContain('explode');
  });

  it('reaches the execution record when the workflow does not catch it', async () => {
    const service = serviceWith(
      async () => runActivity('boom'),
      () => explode(),
    );
    const {workflowId} = service.start('wf');
    await expectAsync(service.getResult(workflowId)).toBeRejected();

    const detail = await service.describeExecution(workflowId);
    expect(detail!.failureStack).toContain('explode');
    expect(detail!.failureStack).toContain('--- awaited by workflow at ---');
  });

  it('stitches the parent’s await site onto a child failure', async () => {
    let seen = '';
    const rt = createLocalRuntime()
      .registerActivity('boom', () => explode())
      .registerWorkflow('child', async () => runActivity('boom'))
      .registerWorkflow('parent', async () => {
        try {
          await executeChild('child');
        } catch (e) {
          seen = (e as Error).stack ?? '';
        }
        return 'done';
      });

    await rt.start('parent').result();
    expect(seen).toContain('--- awaited by workflow at ---');
    expect(seen).toContain('failure_stack.spec');
  });

  // Cancellation is not a fault, and it rejects everything outstanding at once —
  // a per-site stitch there would attach one command's frames to a story about
  // the whole run.
  it('leaves cancellation unstitched', async () => {
    let seen = '';
    const rt = createLocalRuntime().registerWorkflow('wf', async () => {
      try {
        await sleep(60_000);
      } catch (e) {
        if (e instanceof CancelledFailure) seen = (e as Error).stack ?? '';
      }
      return 'done';
    });

    const handle = rt.start('wf');
    await new Promise((r) => setTimeout(r, 5));
    handle.cancel();
    await handle.result();
    expect(seen).not.toContain('awaited by workflow');
  });
});
