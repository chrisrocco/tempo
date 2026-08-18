/**
 * @fileoverview
 * The catalogue: what workers report, folded into one list of workflows.
 *
 * This is the half of the question `listQueues` could never answer. A queue view says a
 * worker serves `nightlyReport`; it cannot say what that is, what it takes, or that a
 * workflow exists at all before anyone has run it. The catalogue is sourced from what
 * workers push rather than from executions, which is exactly why a never-run workflow
 * appears — that being the point, since the question is "what can I start".
 *
 * Three properties get most of the attention here. Undescribed workflows must appear, or
 * a catalogue that hides half the fleet is worse than one with gaps. Disagreement must
 * be *reported* rather than resolved: two workers describing one name differently is a
 * fleet running two versions of a worker binary (#65), and picking a winner silently is
 * the thing that hides it. And the catalogue must be **present tense**: reports are kept
 * for the life of the server, so without the currency check (`isReportCurrent`) every
 * queue any worker ever served would stay on its workflows forever — a dev worker's
 * ten-minute session reading, a week later, as a pool that can run work.
 */

import type {WorkflowReport} from '../../src/protocol';
import {QUEUE_STALE_MS} from '../../src/protocol';
import {isReportCurrent, type ObservedQueue} from '../../src/server';
import {createServerHost} from '../../src/services';
import {reportHash} from '../../src/worker';

/**
 * Report `workflows` and poll as that worker would — the two halves of the
 * protocol, the way `Tempo.startWorker` performs them. The poll is what makes
 * the report *current*: the catalogue only counts a report while the worker
 * behind it vouches for it with the digest on its polls.
 */
async function servingWorker(
  host: ReturnType<typeof createServerHost>,
  identity: string,
  taskQueue: string,
  workflows: WorkflowReport[],
): Promise<void> {
  const hash = reportHash(workflows);
  await host.reportWorkflows({identity, taskQueue, hash, workflows});
  await host.pollWorkflowTask({taskQueue, identity, servesHash: hash});
}

describe('the workflow catalogue', () => {
  let host: ReturnType<typeof createServerHost>;

  beforeEach(() => {
    host = createServerHost();
  });

  afterEach(() => {
    host.shutdown();
  });

  it('is empty before any worker has reported', async () => {
    expect(await host.listWorkflows()).toEqual([]);
  });

  it('lists what a worker reported, with the queue it serves it on', async () => {
    await servingWorker(host, 'w1', 'default', [
      {
        name: 'nightlyReport',
        title: 'Nightly revenue report',
        description: 'Totals yesterday.',
        props: [{name: 'day', required: true, type: 'string'}],
      },
    ]);

    expect(await host.listWorkflows()).toEqual([
      {
        name: 'nightlyReport',
        title: 'Nightly revenue report',
        description: 'Totals yesterday.',
        props: [{name: 'day', required: true, type: 'string'}],
        taskQueues: ['default'],
      },
    ]);
  });

  /**
   * The fallback that makes adoption incremental: a workflow nobody described is present,
   * titled by its registered name, rather than missing.
   */
  it('resolves a missing title to the registered name', async () => {
    await servingWorker(host, 'w1', 'default', [{name: 'plainThing'}]);

    const [workflow] = await host.listWorkflows();
    expect(workflow?.title).toBe('plainThing');
    expect(workflow?.props).toBeUndefined();
  });

  it('appears before the workflow has ever run', async () => {
    await servingWorker(host, 'w1', 'default', [
      {name: 'neverRun', title: 'Never run'},
    ]);

    expect((await host.listWorkflows()).map((w) => w.name)).toEqual([
      'neverRun',
    ]);
    // Nothing was started; the catalogue is not derived from executions.
    expect((await host.listExecutions()).executions).toEqual([]);
  });

  it('deduplicates a workflow two workers both serve', async () => {
    const workflows: WorkflowReport[] = [{name: 'shared', title: 'Shared'}];
    await servingWorker(host, 'w1', 'default', workflows);
    await servingWorker(host, 'w2', 'default', workflows);

    const listed = await host.listWorkflows();
    expect(listed.length).toBe(1);
    expect(listed[0]?.taskQueues).toEqual(['default']);
    expect(listed[0]?.conflicting).toBeUndefined();
  });

  it('collects every queue a workflow is served on', async () => {
    const workflows: WorkflowReport[] = [{name: 'shared', title: 'Shared'}];
    await servingWorker(host, 'w1', 'default', workflows);
    await servingWorker(host, 'w2', 'reports', workflows);

    expect((await host.listWorkflows())[0]?.taskQueues).toEqual([
      'default',
      'reports',
    ]);
  });

  /**
   * The version-skew signal. Two workers describing one name differently cannot both be
   * current, and which is right is not something the server can know — so it keeps the
   * first, says they disagree, and leaves the choice to whoever is reading.
   */
  it('flags a workflow two workers describe differently', async () => {
    await servingWorker(host, 'v1', 'default', [
      {name: 'charge', title: 'Charge a card'},
    ]);
    await servingWorker(host, 'v2', 'default', [
      {name: 'charge', title: 'Charge a card', props: [{name: 'amount'}]},
    ]);

    const [workflow] = await host.listWorkflows();
    expect(workflow?.conflicting).toBe(true);
    // First report kept, rather than a silent overwrite.
    expect(workflow?.props).toBeUndefined();
  });

  // A worker redeployed under one identity replaces what it said; it does not accumulate
  // the union of everything it has ever run, which would hide the skew above.
  it('replaces a worker’s report rather than merging it', async () => {
    await servingWorker(host, 'w1', 'default', [{name: 'old', title: 'Old'}]);
    await servingWorker(host, 'w1', 'default', [{name: 'new', title: 'New'}]);

    expect((await host.listWorkflows()).map((w) => w.name)).toEqual(['new']);
  });

  /**
   * The present-tense rule, from the catalogue's side. A report the server holds with no
   * polls behind it — a worker that reported and died before asking for work, or one
   * remembered from before nothing but the report survived — describes a fleet that is
   * not there, and "what can I start" must not answer from it.
   */
  it('omits a report from a worker that has never polled', async () => {
    const workflows: WorkflowReport[] = [{name: 'ghost', title: 'Ghost'}];
    await host.reportWorkflows({
      identity: 'w1',
      taskQueue: 'default',
      hash: reportHash(workflows),
      workflows,
    });

    expect(await host.listWorkflows()).toEqual([]);
  });

  /**
   * The user-visible shape of the rule: a queue whose worker is gone drops off the
   * workflow's row, while the queue still served stays. Without this, one abandoned
   * session on `default` keeps `default` on the workflow forever.
   */
  it('lists only the queues whose workers still vouch for it', async () => {
    const workflows: WorkflowReport[] = [{name: 'greeter', title: 'Greeter'}];
    // Reported on `default` once, but its worker never polls — the ghost.
    await host.reportWorkflows({
      identity: 'w-old',
      taskQueue: 'default',
      hash: reportHash(workflows),
      workflows,
    });
    await servingWorker(host, 'w-dev', 'dev', workflows);

    expect((await host.listWorkflows())[0]?.taskQueues).toEqual(['dev']);
  });

  /**
   * The same reconciliation `WorkerInfo.serves` performs, seen from the catalogue: a
   * redeployed worker polls with a new digest from its first poll onward, so the old
   * report stops counting the moment it is stale — not up to a report interval later.
   */
  it('omits a report once its worker polls under a different digest', async () => {
    await servingWorker(host, 'w1', 'default', [{name: 'old', title: 'Old'}]);

    // Redeployed: polling with a digest for a set it has not reported yet.
    await host.pollWorkflowTask({
      taskQueue: 'default',
      identity: 'w1',
      servesHash: reportHash([{name: 'new'}]),
    });

    expect(await host.listWorkflows()).toEqual([]);
  });
});

describe('isReportCurrent', () => {
  const at = 1_000_000;
  const report = {identity: 'w1', taskQueue: 'reports'};
  const none: ReadonlySet<string> = new Set();

  /** A queue as the registry observed it, with one workflow-role worker row. */
  const observed = (
    overrides: {
      taskQueue?: string;
      identity?: string;
      role?: 'workflow' | 'activity';
      lastPolledAt?: number;
      serves?: string[];
    } = {},
  ): ObservedQueue => ({
    taskQueue: overrides.taskQueue ?? 'reports',
    workflowPolledAt: overrides.lastPolledAt ?? at,
    workers: [
      {
        identity: overrides.identity ?? 'w1',
        role: overrides.role ?? 'workflow',
        taskQueue: overrides.taskQueue ?? 'reports',
        lastPolledAt: overrides.lastPolledAt ?? at,
        // `serves` present is the digest reconciliation having succeeded — the
        // registry resolves it only while the worker's polls carry the hash its
        // report was pushed under.
        ...('serves' in overrides && overrides.serves === undefined
          ? {}
          : {serves: overrides.serves ?? ['nightly']}),
      },
    ],
  });

  it('is current while the worker polls with its report resolved', () => {
    expect(isReportCurrent(report, [observed()], none, at)).toBe(true);
  });

  it('is not current when nothing has ever polled the queue', () => {
    expect(isReportCurrent(report, [], none, at)).toBe(false);
  });

  /**
   * The ghost this predicate exists for: a worker that served a queue and stopped. Its
   * poll rows stay in the registry forever — with the matching digest still on them — so
   * recency, not the digest, is what tells a remembered worker from a live one.
   */
  it('is not current once the worker stopped polling', () => {
    const queues = [observed({lastPolledAt: at})];
    expect(isReportCurrent(report, queues, none, at + QUEUE_STALE_MS + 1)).toBe(
      false,
    );
  });

  // A worker mid-task stops polling without having gone anywhere — the same
  // allowance `isQueueServed` makes, for the same reason.
  it('is current for a quiet worker that holds a lease', () => {
    const queues = [observed({lastPolledAt: at})];
    const busy = new Set(['w1']);
    expect(isReportCurrent(report, queues, busy, at + QUEUE_STALE_MS + 1)).toBe(
      true,
    );
  });

  /**
   * `serves` unresolved is the digest disagreeing with the report — a redeploy the
   * report does not describe yet — or a worker that sends no digest at all. Both are
   * unknown, and unknown reads as silence rather than as a queue that can run work.
   */
  it('is not current while the worker’s serves is unresolved', () => {
    const queues = [observed({serves: undefined})];
    expect(isReportCurrent(report, queues, none, at)).toBe(false);
  });

  // Only the workflow role reports — see `composeRemote` — so only its polls vouch.
  it('is not current on the strength of an activity worker’s polls', () => {
    const queues = [observed({role: 'activity'})];
    expect(isReportCurrent(report, queues, none, at)).toBe(false);
  });

  it('is not current on the strength of another worker’s polls', () => {
    const queues = [observed({identity: 'w2'})];
    expect(isReportCurrent(report, queues, none, at)).toBe(false);
  });

  it('is not current on the strength of another queue’s polls', () => {
    const queues = [observed({taskQueue: 'other'})];
    expect(isReportCurrent(report, queues, none, at)).toBe(false);
  });
});

describe('reportHash', () => {
  it('is the same for the same set in a different order', () => {
    const a: WorkflowReport[] = [{name: 'a'}, {name: 'b'}];
    const b: WorkflowReport[] = [{name: 'b'}, {name: 'a'}];

    // Otherwise two workers running identical code would look like they disagreed,
    // purely because their registries were built in a different order.
    expect(reportHash(a)).toBe(reportHash(b));
  });

  it('changes when a description changes', () => {
    expect(reportHash([{name: 'a'}])).not.toBe(
      reportHash([{name: 'a', title: 'A'}]),
    );
  });

  it('changes when a workflow is added', () => {
    expect(reportHash([{name: 'a'}])).not.toBe(
      reportHash([{name: 'a'}, {name: 'b'}]),
    );
  });
});
