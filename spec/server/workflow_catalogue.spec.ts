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
 * Two properties get most of the attention here. Undescribed workflows must appear, or a
 * catalogue that hides half the fleet is worse than one with gaps. And disagreement must
 * be *reported* rather than resolved: two workers describing one name differently is a
 * fleet running two versions of a worker binary (#65), and picking a winner silently is
 * the thing that hides it.
 */

import type {WorkflowReport} from '../../src/protocol';
import {createServerHost} from '../../src/services';
import {reportHash} from '../../src/worker';

/** Report `workflows` as `identity` would. */
async function reports(
  host: ReturnType<typeof createServerHost>,
  identity: string,
  taskQueue: string,
  workflows: WorkflowReport[],
): Promise<void> {
  await host.reportWorkflows({
    identity,
    taskQueue,
    hash: reportHash(workflows),
    workflows,
  });
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
    await reports(host, 'w1', 'default', [
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
    await reports(host, 'w1', 'default', [{name: 'plainThing'}]);

    const [workflow] = await host.listWorkflows();
    expect(workflow?.title).toBe('plainThing');
    expect(workflow?.props).toBeUndefined();
  });

  it('appears before the workflow has ever run', async () => {
    await reports(host, 'w1', 'default', [
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
    await reports(host, 'w1', 'default', workflows);
    await reports(host, 'w2', 'default', workflows);

    const listed = await host.listWorkflows();
    expect(listed.length).toBe(1);
    expect(listed[0]?.taskQueues).toEqual(['default']);
    expect(listed[0]?.conflicting).toBeUndefined();
  });

  it('collects every queue a workflow is served on', async () => {
    const workflows: WorkflowReport[] = [{name: 'shared', title: 'Shared'}];
    await reports(host, 'w1', 'default', workflows);
    await reports(host, 'w2', 'reports', workflows);

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
    await reports(host, 'v1', 'default', [
      {name: 'charge', title: 'Charge a card'},
    ]);
    await reports(host, 'v2', 'default', [
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
    await reports(host, 'w1', 'default', [{name: 'old', title: 'Old'}]);
    await reports(host, 'w1', 'default', [{name: 'new', title: 'New'}]);

    expect((await host.listWorkflows()).map((w) => w.name)).toEqual(['new']);
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
