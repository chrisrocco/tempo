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
import {condition, createWorkflow, sleep, t} from '../src/workflow';
import type {Schema} from '../src/libraries/schema';
import {workflowDescriptor} from '../src/workflow_descriptor';
import {
  registeredWorkflowImpls,
  resolveListedWorkflow,
  resolveWorkflowRegistration,
  workflowNameConflicts,
} from '../src/workflow_registry';
import {startWorker} from '../src';
import {isolateWorkflowRegistry} from './support/isolate_workflow_registry';

describe('createWorkflow — the reference and the registry', () => {
  isolateWorkflowRegistry();

  it('registers the implementation under the explicit name', async () => {
    const greet = createWorkflow({
      key: 'greet',
      run: async ({name}: {name: string}) => `hi ${name}`,
    });

    expect(registeredWorkflowImpls()).toEqual([['greet', greet.impl]]);
    expect(greet.workflowName).toBe('greet');
    // `.impl` is the body itself — the unit-test seam, since calling the
    // reference dispatches.
    await expectAsync(greet.impl({name: 'unit'})).toBeResolvedTo('hi unit');
  });

  it('accepts the described literal and attaches the descriptor to the body', () => {
    const nightly = createWorkflow({
      key: 'nightly',
      title: 'Nightly report',
      props: {
        type: 'object',
        properties: {day: {type: 'string'}},
        required: ['day'],
      },
      async run(props: {day: string}) {
        return props.day;
      },
    });

    expect(workflowDescriptor(nightly.impl)?.title).toBe('Nightly report');
    // A rendered document is carried as written: this form is for a schema a
    // caller already holds, so nothing here reshapes it.
    expect(workflowDescriptor(nightly.impl)?.props).toEqual({
      type: 'object',
      properties: {day: {type: 'string'}},
      required: ['day'],
    });
  });

  it('throws a directing error when called outside a workflow', () => {
    const greet = createWorkflow({key: 'greet', run: async () => 'hi'});

    // The reference looks like the function it replaced, so the error must
    // answer "why didn't my function run?" — and say where each caller goes.
    expect(() => greet()).toThrowError(/dispatches a child workflow/);
    expect(() => greet.detached()).toThrowError(/dispatches a child workflow/);
    expect(() => greet.execute()).toThrowError(/dispatches a child workflow/);
  });

  it('records a conflict for a name two implementations claim, tolerating re-evaluation', () => {
    const body = async (): Promise<string> => 'one';
    createWorkflow({key: 'dup', run: body});
    // The same function again is a module evaluating twice, not a mistake.
    createWorkflow({key: 'dup', run: body});
    expect(workflowNameConflicts()).toEqual([]);

    createWorkflow({key: 'dup', run: async () => 'two'});
    expect(workflowNameConflicts()).toEqual(['dup']);
  });

  it('makes startWorker refuse while a conflict is unresolved', () => {
    createWorkflow({key: 'charge', run: async () => 'a'});
    createWorkflow({key: 'charge', run: async () => 'b'});

    expect(() => startWorker({name: 'conflicted'})).toThrowError(
      /claimed by more than one createWorkflow call: charge/,
    );
  });

  it('resolves a WorkflowRef entry to its own wire name, and a plain function to its export name', () => {
    const pay = createWorkflow({key: 'pay', run: async () => 'paid'});
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

  it('takes a list of references, each registering under its own key', () => {
    const pay = createWorkflow({key: 'pay', run: async () => 'paid'});
    const ship = createWorkflow({key: 'ship', run: async () => 'shipped'});

    expect(resolveListedWorkflow(pay, 0)).toEqual(['pay', pay.impl]);
    expect(resolveListedWorkflow(ship, 1)).toEqual(['ship', ship.impl]);
  });

  // A list has no key to give a plain function, and `fn.name` cannot stand in
  // under minification. The map form is what covers that case, so the error
  // names it rather than only reporting the refusal.
  it('refuses a plain function in the list, naming both ways to give it a name', () => {
    const plain = async (): Promise<string> => 'plain';

    expect(() => resolveListedWorkflow(plain, 2)).toThrowError(
      /workflows\[2\][\s\S]*createWorkflow[\s\S]*module namespace/,
    );
  });

  // Through the entrypoint, to pin that the list is a branch `startWorker`
  // actually takes rather than a helper nothing reaches. It refuses before any
  // poll loop starts, which is what makes this assertable without a server.
  it('reaches the list branch from startWorker itself', () => {
    const plain = async (): Promise<string> => 'plain';

    expect(() =>
      startWorker({name: 'listed', workflows: [plain]}),
    ).toThrowError(/workflows\[0\] is a plain function/);
  });
});

/**
 * The props shape written once: `t.object({...})` renders the document a
 * catalogue publishes *and* types the body beside it, so the two cannot drift
 * the way a hand-written JSON Schema and a `run(props: {...})` annotation can.
 *
 * What the second test asserts is mostly that it **compiles**: the bodies below
 * annotate nothing, so a props type that stopped being inferred from the schema
 * would fail `npm run typecheck` rather than any expectation here.
 */
describe('createWorkflow — props authored as a schema', () => {
  isolateWorkflowRegistry();

  const Nightly = t.object({
    day: t.string({description: 'The date to total, as YYYY-MM-DD.'}),
  });

  it('renders the props schema into the descriptor a catalogue publishes', () => {
    const nightly = createWorkflow({
      key: 'nightlyFromSchema',
      title: 'Nightly revenue report',
      props: Nightly,
      async run({day}) {
        return day;
      },
    });

    expect(workflowDescriptor(nightly.impl)?.props).toEqual({
      type: 'object',
      properties: {
        day: {type: 'string', description: 'The date to total, as YYYY-MM-DD.'},
      },
      required: ['day'],
    });
  });

  it('infers the props of the body from the schema, with nothing annotated', async () => {
    const nightly = createWorkflow({
      key: 'nightlyTyped',
      props: Nightly,
      async run({day}) {
        return `totalled ${day}`;
      },
    });

    await expectAsync(nightly.impl({day: '2026-08-29'})).toBeResolvedTo(
      'totalled 2026-08-29',
    );
  });

  /**
   * The half of `t.defaulted` that does not survive the trip: the engine
   * describes and does not validate, so nothing parses props on the way in and
   * a default reaches a form — through the rendered document — without ever
   * reaching the handler. Hence `InferInput` rather than `InferOutput`, and
   * hence a body that wants the filled value parsing the props itself.
   */
  it('publishes a default without filling one, so the body sees what the caller sent', async () => {
    const Search = t.object({
      query: t.string(),
      limit: t.defaulted(t.integer({min: 1, max: 100}), 20),
    });
    const search = createWorkflow({
      key: 'searchDefaults',
      props: Search,
      async run(props) {
        return props.limit ?? 'unfilled';
      },
    });

    expect(
      (
        workflowDescriptor(search.impl)?.props?.['properties'] as Record<
          string,
          unknown
        >
      )['limit'],
    ).toEqual({type: 'integer', minimum: 1, maximum: 100, default: 20});
    await expectAsync(search.impl({query: 'durable'})).toBeResolvedTo(
      'unfilled',
    );
    // Which is what parsing in the body is for — the same schema value, run by
    // whoever declared it.
    const parsed = Search.validate({query: 'durable'});
    expect(parsed.ok && parsed.value.limit).toBe(20);
  });

  /**
   * `toJsonSchema` is the validator port's optional half, so a schema that
   * renders nothing lists as undescribed rather than taking a workflow that
   * runs perfectly well off its queue — the tolerance `connectors/catalogue.ts`
   * shows an unrenderable operation schema.
   */
  it('leaves the props undescribed when the schema renders nothing', () => {
    const unrenderable: Schema<{id: string}> = {
      validate: (value) => ({ok: true, value: value as {id: string}}),
    };
    const opaque = createWorkflow({
      key: 'opaque',
      title: 'Opaque',
      props: unrenderable,
      async run({id}) {
        return id;
      },
    });

    expect(workflowDescriptor(opaque.impl)?.title).toBe('Opaque');
    expect(workflowDescriptor(opaque.impl)?.props).toBeUndefined();
  });
});

describe('createWorkflow — dispatching children', () => {
  isolateWorkflowRegistry();

  it('runs an invoked reference as a blocking child, not inline', async () => {
    const child = createWorkflow({
      key: 'child',
      run: async ({name}: {name: string}) => `hi ${name}`,
    });
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
    const step = createWorkflow({
      key: 'step',
      run: async ({tag}: {tag: string}) => `ran ${tag}`,
    });
    const rt = createLocalRuntime()
      .registerWorkflow(step.workflowName, step)
      .registerWorkflow('parent', async () => {
        const first = await step.execute(
          {tag: 'a'},
          {workflowId: 'claimed-step'},
        );
        const second = await step.execute(
          {tag: 'b'},
          {workflowId: 'claimed-step'},
        );
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
    const kid = createWorkflow({
      key: 'kid',
      async run() {
        await condition(() => false);
        return 'unreachable';
      },
    });
    const rt = createLocalRuntime()
      .registerWorkflow(kid.workflowName, kid)
      .registerWorkflow('parent', async () => {
        kid.detached(undefined, {
          workflowId: 'the-kid',
          parentClosePolicy: 'abandon',
        });
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
