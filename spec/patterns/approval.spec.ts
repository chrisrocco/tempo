/**
 * @fileoverview
 * `waitForApproval`: a human decision as a workflow step.
 *
 * Two contracts under test, and they face different parties. To the *operator*
 * (a dashboard): while the workflow waits, its parked state advertises
 * `{kind: 'approval', signal, detail}` — everything needed to render the
 * request and know where to send the decision — and stops advertising it once
 * decided. To the *workflow author*: the decision comes back as data, verbatim,
 * with the attribution the sender put in the payload; a denial is a return
 * value, not an exception.
 *
 * The helper is a composition over `setHandler` + `condition({awaiting})`, so
 * most of its machinery is pinned elsewhere; these specs pin the convention.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {waitForApproval, type ApprovalDecision} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('a workflow waiting for approval', () => {
  it('advertises the request on its parked state', async () => {
    // The operator-facing half: a dashboard that knows nothing about this
    // workflow can read what is being asked and which signal answers it.
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('release', async () => {
        await waitForApproval({
          signal: 'approve-release',
          detail: {version: '2.4.0'},
        });
        return 'shipped';
      })
      .start('release', undefined, {workflowId: 'ap-1'});
    await wait(150);

    const parked = (await store.get('ap-1'))?.parked ?? [];
    expect(parked.length).toBe(1);
    expect(parked[0]?.awaiting).toEqual({
      kind: 'approval',
      signal: 'approve-release',
      detail: {version: '2.4.0'},
    });
  });

  it('resolves with the decision, attribution and all', async () => {
    // The attribution is the payload — a client-sent signal has no provenance
    // of its own, so what the sender asserts is the whole record. It must
    // arrive verbatim, because the signal event in history is the audit trail.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'release',
      async () => waitForApproval({signal: 'approve-release'}),
    );
    const handle = rt.start<ApprovalDecision>('release', undefined, {
      workflowId: 'ap-2',
    });
    await wait(150);

    handle.signal('approve-release', {
      approved: true,
      approvedBy: 'chris@example.com',
      via: 'dashboard',
    });
    const decision = await handle.result();
    expect(decision).toEqual({
      approved: true,
      approvedBy: 'chris@example.com',
      via: 'dashboard',
    });

    // Decided means no longer advertised.
    expect((await store.get('ap-2'))?.parked ?? []).toEqual([]);
  });

  it('returns a denial rather than throwing', async () => {
    // Which paths are failures is the workflow's call; the most ordinary
    // outcome of asking a human must not arrive as an error.
    const rt = createLocalRuntime().registerWorkflow('release', async () => {
      const decision = await waitForApproval<ApprovalDecision>({
        signal: 'approve-release',
      });
      return decision.approved ? 'shipped' : `declined: ${decision.note}`;
    });
    const handle = rt.start<string>('release', undefined, {workflowId: 'ap-3'});
    await wait(150);

    handle.signal('approve-release', {
      approved: false,
      approvedBy: 'chris@example.com',
      note: 'not during freeze',
    });
    await expectAsync(handle.result()).toBeResolvedTo(
      'declined: not during freeze',
    );
  });

  it('gives the signal name back, so a later approval on it registers cleanly', async () => {
    // clearHandler in the helper's finally: without it the second wait would be
    // silently displaced and hang — the setHandler failure mode.
    const rt = createLocalRuntime().registerWorkflow('twoGates', async () => {
      const first = await waitForApproval<ApprovalDecision>({
        signal: 'approve',
        detail: 'stage one',
      });
      const second = await waitForApproval<ApprovalDecision>({
        signal: 'approve',
        detail: 'stage two',
      });
      return `${first.approvedBy}, then ${second.approvedBy}`;
    });
    const handle = rt.start<string>('twoGates', undefined, {
      workflowId: 'ap-4',
    });
    await wait(150);
    handle.signal('approve', {approved: true, approvedBy: 'first'});
    await wait(150);
    handle.signal('approve', {approved: true, approvedBy: 'second'});

    await expectAsync(handle.result()).toBeResolvedTo('first, then second');
  });
});
