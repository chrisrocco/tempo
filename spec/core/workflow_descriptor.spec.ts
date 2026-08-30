/**
 * @fileoverview
 * The describing half of `createWorkflow` — what a workflow says about itself,
 * and how invisible saying it is.
 *
 * The point of the shape is that describing a workflow changes nothing about
 * running it. The descriptor rides on the body as a non-enumerable frozen
 * property, so a described workflow registers, runs, and unit-tests exactly as
 * an undescribed one does, and adopting descriptions is one workflow at a time
 * rather than a migration.
 *
 * Most of these specs exist to pin that invisibility, which is the property a
 * future change is most likely to break — by returning a wrapper object instead
 * of the function, or by leaving an enumerable key behind.
 *
 * `createWorkflow`'s *other* half — the reference it returns, and what calling
 * that reference dispatches — is `spec/workflow_registry.spec.ts`.
 *
 * Props are written as a schema (`t.object({...})`) throughout, which is the
 * form to reach for: `createWorkflow` renders it into the descriptor read back
 * here, types the body from the same value, and parses props against it before
 * that body runs. The parse is the one thing describing does change about
 * running, so it is pinned here beside the invisibility it qualifies; what the
 * parse *does* — defaults, rejections, where a failure lands — is
 * `spec/workflow_registry.spec.ts`, along with the pre-rendered form that
 * describes without enforcing.
 */

import 'jasmine';
import {createLocalRuntime} from '../../src';
import {createWorkflow, t} from '../../src/workflow';
import {workflowDescriptor} from '../../src/workflow_descriptor';
import {isolateWorkflowRegistry} from '../support/isolate_workflow_registry';

describe('createWorkflow — describing a workflow', () => {
  isolateWorkflowRegistry();

  it('leaves the body itself on `.impl`, unwrapped', () => {
    const run = async (): Promise<string> => 'hi';

    expect(createWorkflow({key: 'greeter', title: 'Greeter', run}).impl).toBe(
      run,
    );
  });

  // The exception, and the only one: a declared schema is enforced, so `.impl`
  // is the body behind its parse — the same thing the engine invokes, which is
  // what makes calling `.impl` in a unit test worth anything.
  it('puts the parse in front of the body when props are a schema', async () => {
    const run = async ({day}: {day: string}): Promise<string> => day;
    const nightly = createWorkflow({
      key: 'nightly',
      props: t.object({day: t.string()}),
      run,
    });

    expect(nightly.impl).not.toBe(run);
    await expectAsync(nightly.impl({day: '2026-08-30'})).toBeResolvedTo(
      '2026-08-30',
    );
    await expectAsync(nightly.impl({} as never)).toBeRejectedWithError(
      /nightly was started with props its schema rejects/,
    );
  });

  it('leaves it callable, with its props and result intact', async () => {
    const greet = createWorkflow({
      key: 'greeter',
      title: 'Greeter',
      async run(props: {name: string}) {
        return `hello ${props.name}`;
      },
    });

    // `.impl`, not the reference: calling the reference dispatches a child, which
    // is the whole distinction `workflow_registry.spec.ts` covers.
    await expectAsync(greet.impl({name: 'world'})).toBeResolvedTo(
      'hello world',
    );
  });

  it('reads back everything except the key and the function', () => {
    const props = t.object({
      customerId: t.string(),
      locale: t.optional(
        t.unknown({description: 'Defaults to the account language.'}),
      ),
    });
    const ref = createWorkflow({
      key: 'greeter',
      title: 'Greet a customer',
      description: 'Sends the welcome email.',
      props,
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(ref.impl)).toEqual({
      title: 'Greet a customer',
      description: 'Sends the welcome email.',
      // The schema's own rendering: one definition behind both the document a
      // form draws and the type the body is checked against.
      props: {
        type: 'object',
        properties: {
          customerId: {type: 'string'},
          locale: {description: 'Defaults to the account language.'},
        },
        required: ['customerId'],
      },
    });
  });

  // `run` is the function and `key` is the identity — neither is something to
  // describe, and the descriptor is data destined for a wire and a screen.
  it('keeps key and run out of the descriptor', () => {
    const ref = createWorkflow({
      key: 'greeter',
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });

    expect(Object.keys(workflowDescriptor(ref.impl)!)).toEqual(['title']);
  });

  /**
   * The invisibility that matters most: a described body must not look different
   * to anything that enumerates it. `startWorker({workflows})` iterates entries,
   * specs compare objects, and a stray enumerable key would surface in all of
   * them.
   */
  it('adds nothing enumerable to the body', () => {
    const ref = createWorkflow({
      key: 'greeter',
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });

    expect(Object.keys(ref.impl)).toEqual([]);
    expect(JSON.stringify({fn: ref.impl})).toBe('{}');
    expect({...ref.impl}).toEqual({});
  });

  it('freezes the descriptor, so one reader cannot alter another’s', () => {
    const ref = createWorkflow({
      key: 'greeter',
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });
    const read = workflowDescriptor(ref.impl)!;

    expect(() => {
      (read as {title: string}).title = 'changed';
    }).toThrow();
    expect(workflowDescriptor(ref.impl)?.title).toBe('Greeter');
  });

  it('reports nothing for a function nobody described', () => {
    expect(workflowDescriptor(async () => 'x')).toBeUndefined();
  });

  // The reader is handed whatever an entries loop produced, so it must tolerate
  // values that are not functions at all rather than being the thing that throws.
  it('reports nothing for a value that is not a function', () => {
    for (const value of [undefined, null, 42, 'x', {}, []])
      expect(workflowDescriptor(value)).toBeUndefined();
  });

  /**
   * Partial descriptions are ordinary, not a special case — a missing `title`
   * falls back to the registered name wherever this is displayed, which is the
   * same fallback an entirely undescribed workflow gets.
   */
  it('accepts a description with only some fields', () => {
    const ref = createWorkflow({
      key: 'greeter',
      description: 'No title, just this.',
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(ref.impl)).toEqual({
      description: 'No title, just this.',
    });
  });

  /**
   * An undescribed workflow gets an empty descriptor rather than none, since
   * `createWorkflow` writes one unconditionally. Every consumer spreads it with
   * `?? {}`, so this reads identically to "never described" — pinned because the
   * two are only interchangeable while that stays true.
   */
  it('describes an undescribed workflow as nothing in particular', () => {
    const ref = createWorkflow({
      key: 'bare',
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(ref.impl)).toEqual({});
    expect(workflowDescriptor(ref.impl)?.props).toBeUndefined();
  });
});

describe('a described workflow on a runtime', () => {
  isolateWorkflowRegistry();

  /**
   * The end-to-end claim: describing a workflow does not change how it is
   * registered or run. If this ever needs a different registration call, the
   * shape has failed.
   */
  it('registers and runs exactly as an undescribed one does', async () => {
    const greeter = createWorkflow({
      key: 'greeter',
      title: 'Greet a customer',
      props: t.object({name: t.string()}),
      async run({name}) {
        return `hello ${name}`;
      },
    });
    // The reference goes in as-is; `registerWorkflow` unwraps it. Registering the
    // dispatcher would have the workflow spawn itself forever.
    const rt = createLocalRuntime().registerWorkflow('greeter', greeter);

    await expectAsync(
      rt.start<string>('greeter', {name: 'world'}).result(),
    ).toBeResolvedTo('hello world');
    rt.shutdown();
  });

  // Reading descriptors off a registry is how a catalogue is assembled, so the
  // iteration shape is worth pinning: described and undescribed side by side,
  // with the undescribed one present rather than skipped.
  it('lets a registry be read for descriptions, described or not', () => {
    const workflows = {
      described: createWorkflow({
        key: 'described',
        title: 'Described',
        async run() {
          return 'x';
        },
      }).impl,
      plain: async (): Promise<string> => 'x',
    };

    expect(
      Object.entries(workflows).map(([name, fn]) => ({
        name,
        title: workflowDescriptor(fn)?.title ?? name,
        props: workflowDescriptor(fn)?.props,
      })),
    ).toEqual([
      {name: 'described', title: 'Described', props: undefined},
      {name: 'plain', title: 'plain', props: undefined},
    ]);
  });
});
