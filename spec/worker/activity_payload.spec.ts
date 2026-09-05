/**
 * @fileoverview
 * The cap on what an activity is handed and what it hands back, at the two seams
 * that produce those values.
 *
 * Both are written into history and replayed on every later task, so a pipeline
 * that passes a batch of rows to an activity pays for that batch on every task
 * for the rest of the run — and nothing says so until replay is slow. The cap
 * (`MAX_ACTIVITY_PAYLOAD_BYTES`) turns that into a loud failure at the first call
 * that crosses the line, and the failure's message states the rule: a reference,
 * never the data.
 *
 * The two seams fail differently, on purpose. Arguments are checked in the
 * workflow worker after replay, so an oversized call is a *task* failure — the
 * same severity as the carryover and `awaiting` caps: retried rather than fatal,
 * nothing durable written, recovered by shipping a fix. A result is checked in
 * the activity worker and is the *attempt's* outcome, so it is an activity failure
 * the workflow can see. The end-to-end case at the bottom shows the first of
 * those as an operator meets it: an execution still running, with a task failure
 * naming the activity and the cap.
 */

import {createLocalRuntime} from '../../src';
import {
  MAX_ACTIVITY_PAYLOAD_BYTES,
  type ActivityTask,
  type WorkflowTask,
} from '../../src/protocol';
import {MemoryHistoryStore} from '../../src/server';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
} from '../../src/worker';
import {runActivity} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A string that serializes to just over the cap, quotes included. */
const OVERSIZED = 'x'.repeat(MAX_ACTIVITY_PAYLOAD_BYTES);
/** Comfortably under it. */
const FITS = 'x'.repeat(1024);

function workflowTask(): WorkflowTask {
  return {
    token: 'wt-1',
    workflowId: 'wf',
    name: 'wf',
    props: undefined,
    history: [],
    continueAsNewSuggested: false,
    carryover: {},
  };
}

describe('activity arguments over the cap', () => {
  it('fail the workflow task, naming the activity, the size, and the largest argument', async () => {
    const registry = createWorkflowRegistry();
    registry.set('wf', async () => runActivity('ingest', 'batch-7', OVERSIZED));

    await expectAsync(
      createWorkflowWorker(registry).replayTask(workflowTask()),
    ).toBeRejectedWithError(
      /called activity "ingest" with \d+ bytes of arguments, over the \d+ limit \(largest is argument 1/,
    );
  });

  it('pass when they fit', async () => {
    const registry = createWorkflowRegistry();
    registry.set('wf', async () => runActivity('ingest', 'batch-7', FITS));

    const result =
      await createWorkflowWorker(registry).replayTask(workflowTask());

    expect(result.commands.length).toBe(1);
  });

  /**
   * A command history already holds was checked when it was first issued.
   * Re-checking it would serialize the arguments on every task for a decision
   * already made — and would fail a run whose history predates the cap.
   */
  it('are not re-checked for a command history already holds', async () => {
    const registry = createWorkflowRegistry();
    registry.set('wf', async () => runActivity('ingest', OVERSIZED));
    const task: WorkflowTask = {
      ...workflowTask(),
      history: [
        {
          type: 'activityScheduled',
          seq: 0,
          name: 'ingest',
          args: [OVERSIZED],
          options: {},
        },
      ],
    };

    const result = await createWorkflowWorker(registry).replayTask(task);

    expect(result.commands).toEqual([]); // suppressed, and not complained about
  });
});

describe('an activity result over the cap', () => {
  function activityTask(): ActivityTask {
    return {workflowId: 'wf', seq: 0, name: 'fetchAll', args: [], options: {}};
  }

  it('is an activity failure naming the activity, the size, and the cap', async () => {
    const registry = createActivityRegistry();
    registry.set('fetchAll', async () => OVERSIZED);

    const result = await createActivityWorker(registry).runTask(activityTask());

    expect(result).toEqual(
      jasmine.objectContaining({
        ok: false,
        error: jasmine.stringMatching(
          /activity "fetchAll" returned \d+ bytes, over the \d+ limit/,
        ),
      }),
    );
  });

  it('passes when it fits, and when there is no result at all', async () => {
    const registry = createActivityRegistry();
    registry.set('fetchAll', async () => FITS);
    registry.set('sideEffect', async () => undefined);
    const worker = createActivityWorker(registry);

    expect(await worker.runTask(activityTask())).toEqual({
      ok: true,
      result: FITS,
    });
    expect(
      await worker.runTask({...activityTask(), name: 'sideEffect'}),
    ).toEqual({ok: true, result: undefined});
  });
});

describe('the cap as an operator meets it', () => {
  it('leaves the execution running with a task failure that says what to fix', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerActivity('ingest', () => 'never runs')
      .registerWorkflow('bulk', async () => runActivity('ingest', OVERSIZED))
      .start('bulk', undefined, {workflowId: 'bulk-1'});
    await wait(150);

    const rec = await store.get('bulk-1');
    // Still running — this is an authoring mistake, not a workflow outcome — and
    // nothing was written: the oversized arguments never became history.
    expect(rec?.status).toBe('running');
    expect(rec?.taskFailures).toBeGreaterThan(0);
    expect(rec?.lastTaskFailure).toContain('over the');
    expect(rec?.lastTaskFailure).toContain('a reference');
    expect(
      rec?.history.some((e) => e.type === 'activityScheduled'),
    ).toBeFalse();
  });
});
