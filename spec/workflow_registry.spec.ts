/**
 * @fileoverview
 * `createWorkflow`: the reference dispatches, the registry feeds the worker, and
 * conflicts refuse the worker rather than replaying a body nobody chose.
 *
 * The property worth the most care is the first one. A reference that ran the
 * body inline would half-work — same results in the happy path — while folding
 * the child's activities into the parent's history: no separate execution, no
 * cancellation scope, no parent-close policy. So these specs assert on the
 * *shape* of what ran — two executions, a parent link, a detached child under
 * its claimed id — not just on returned values.
 */

import {createLocalRuntime} from '../src';
import {condition, createWorkflow, sleep} from '../src/workflow';
import {workflowDescriptor} from '../src/workflow_descriptor';
import {
  registeredWorkflowImpls,
  resolveWorkflowRegistration,
  workflowNameConflicts,
} from '../src/workflow_registry';
import {startWorker} from '../src';
import {isolateWorkflowRegistry} from './support/isolate_workflow_registry';

describe('createWorkflow — the reference and the registry', () => {
  isolateWorkflowRegistry();

  it('registers the implementation under the explicit name', async () => {
    const greet = createWorkflow(
      'greet',
      async ({name}: {name: string}) => `hi ${name}`,
    );

    expect(registeredWorkflowImpls()).toEqual([['greet', greet.impl]]);
    expect(greet.workflowName).toBe('greet');
    // `.impl` is the body itself — the unit-test seam, since calling the
    // reference dispatches.
    await expectAsync(greet.impl({name: 'unit'})).toBeResolvedTo('hi unit');
  });

  it('accepts the described literal and attaches the descriptor to the body', () => {
    const nightly = createWorkflow('nightly', {
      title: 'Nightly report',
      props: [{name: 'day', required: true, type: 'string'}],
      async start(props: {day: string}) {
        return props.day;
      },
    });

    expect(workflowDescriptor(nightly.impl)?.title).toBe('Nightly report');
  });

  it('throws a directing error when called outside a workflow', () => {
    const greet = createWorkflow('greet', async () => 'hi');

    // The reference looks like the function it replaced, so the error must
    // answer "why didn't my function run?" — and say where each caller goes.
    expect(() => greet()).toThrowError(/dispatches a child workflow/);
    expect(() => greet.detached([])).toThrowError(
      /dispatches a child workflow/,
    );
    expect(() => greet.execute([])).toThrowError(/dispatches a child workflow/);
  });

  it('records a conflict for a name two implementations claim, tolerating re-evaluation', () => {
    const body = async (): Promise<string> => 'one';
    createWorkflow('dup', body);
    // The same function again is a module evaluating twice, not a mistake.
    createWorkflow('dup', body);
    expect(workflowNameConflicts()).toEqual([]);

    createWorkflow('dup', async () => 'two');
    expect(workflowNameConflicts()).toEqual(['dup']);
  });

  it('makes startWorker refuse while a conflict is unresolved', () => {
    createWorkflow('charge', async () => 'a');
    createWorkflow('charge', async () => 'b');

    expect(() => startWorker({name: 'conflicted'})).toThrowError(
      /claimed by more than one createWorkflow call: charge/,
    );
  });

  it('resolves a WorkflowRef entry to its own wire name, and a plain function to its export name', () => {
    const pay = createWorkflow('pay', async () => 'paid');
    const plain = async (): Promise<string> => 'plain';

    // An export alias must not become a second name for a registered workflow.
    expect(resolveWorkflowRegistration('aliased', pay)).toEqual([
      'pay',
      pay.impl,
    ]);
    expect(resolveWorkflowRegistration('plain', plain)).toEqual([
      'plain',
      plain,
    ]);
  });
});

describe('createWorkflow — dispatching children', () => {
  isolateWorkflowRegistry();

  it('runs an invoked reference as a blocking child, not inline', async () => {
    const child = createWorkflow(
      'child',
      async ({name}: {name: string}) => `hi ${name}`,
    );
    const rt = createLocalRuntime()
      // The reference itself is registered, which must unwrap: an engine
      // invoking the dispatcher would start the child as its own child forever.
      .registerWorkflow(child.workflowName, child)
      .registerWorkflow('parent', async () => child({name: 'world'}));

    try {
      await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo(
        'hi world',
      );

      // The shape that separates a child from an inline call: a second
      // execution exists, and it names this parent.
      const {executions} = await rt.service.listExecutions();
      const childRun = executions.find((e) => e.name === 'child');
      expect(childRun).toBeDefined();
      const detail = await rt.service.describeExecution(childRun!.workflowId);
      expect(detail?.parent?.workflowId).toBe(
        executions.find((e) => e.name === 'parent')?.workflowId,
      );
    } finally {
      rt.shutdown();
    }
  });

  /**
   * `.execute` is the blocking call with its options, and `workflowId` is the
   * one worth a spec: a taken id awaits the existing execution rather than
   * starting a second, so two executes under one id are one child — the
   * second's args discarded, its result the first's. The dedup semantics
   * `executeChild` documents, reachable through the typed reference.
   */
  it('correlates two .execute calls under one claimed id to one child', async () => {
    const step = createWorkflow(
      'step',
      async ({tag}: {tag: string}) => `ran ${tag}`,
    );
    const rt = createLocalRuntime()
      .registerWorkflow(step.workflowName, step)
      .registerWorkflow('parent', async () => {
        const first = await step.execute([{tag: 'a'}], {
          workflowId: 'claimed-step',
        });
        const second = await step.execute([{tag: 'b'}], {
          workflowId: 'claimed-step',
        });
        return [first, second];
      });

    try {
      await expectAsync(rt.start<string[]>('parent').result()).toBeResolvedTo([
        'ran a',
        'ran a',
      ]);
      const {executions} = await rt.service.listExecutions();
      expect(executions.filter((e) => e.name === 'step').length).toBe(1);
    } finally {
      rt.shutdown();
    }
  });

  it('spawns a detached child under a claimed id via .detached()', async () => {
    const kid = createWorkflow('kid', async () => {
      await condition(() => false);
      return 'unreachable';
    });
    const rt = createLocalRuntime()
      .registerWorkflow(kid.workflowName, kid)
      .registerWorkflow('parent', async () => {
        kid.detached([], {workflowId: 'the-kid', parentClosePolicy: 'abandon'});
        // Dispatched by an earlier task than the one that settles the parent —
        // a start issued in the settling task is dropped (see
        // `parent_close.spec.ts`), and this spec is about the spawn, not that.
        await sleep(5);
        return 'done';
      });

    try {
      await expectAsync(rt.start<string>('parent').result()).toBeResolvedTo(
        'done',
      );
      // Fire-and-forget: the parent finished without it, and the claimed id
      // names the running child.
      const detail = await rt.service.describeExecution('the-kid');
      expect(detail?.status).toBe('running');
    } finally {
      rt.shutdown();
    }
  });
});
