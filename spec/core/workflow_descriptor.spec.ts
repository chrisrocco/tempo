/**
 * @fileoverview
 * `defineWorkflow` — defining a workflow and describing it in one object.
 *
 * The point of the shape is that it changes nothing downstream. `defineWorkflow` returns
 * `start` itself, so a described workflow registers, runs, and unit-tests exactly as an
 * undescribed one does — adopting this is one workflow at a time rather than a migration.
 *
 * Most of these specs exist to pin that invisibility, which is the property a future
 * change is most likely to break by returning a wrapper object instead of the function.
 */

import 'jasmine';
import type {WorkflowPropsSchema} from '../../src/protocol';
import {createLocalRuntime} from '../../src';
import {defineWorkflow} from '../../src/workflow';
import {workflowDescriptor} from '../../src/workflow_descriptor';

describe('defineWorkflow', () => {
  it('returns the run function itself', () => {
    const run = async (): Promise<string> => 'hi';
    expect(defineWorkflow({title: 'Greeter', run})).toBe(run);
  });

  it('leaves it callable, with its props and result intact', async () => {
    const greet = defineWorkflow({
      title: 'Greeter',
      async run(props: {name: string}) {
        return `hello ${props.name}`;
      },
    });

    await expectAsync(greet({name: 'world'})).toBeResolvedTo('hello world');
  });

  it('reads back everything except the function', () => {
    const props: WorkflowPropsSchema = {
      type: 'object',
      properties: {
        customerId: {type: 'string'},
        locale: {description: 'Defaults to the account language.'},
      },
      required: ['customerId'],
    };
    const fn = defineWorkflow({
      title: 'Greet a customer',
      description: 'Sends the welcome email.',
      props,
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(fn)).toEqual({
      title: 'Greet a customer',
      description: 'Sends the welcome email.',
      props,
    });
  });

  // `start` is the function, not something to describe — it must not end up in the
  // descriptor, which is data destined for a wire and a screen.
  it('keeps start out of the descriptor', () => {
    const fn = defineWorkflow({
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });

    expect(Object.keys(workflowDescriptor(fn)!)).toEqual(['title']);
  });

  /**
   * The invisibility that matters most: a described function must not look different to
   * anything that enumerates it. `startWorker({workflows})` iterates entries, specs
   * compare objects, and a stray enumerable key would surface in all of them.
   */
  it('adds nothing enumerable', () => {
    const fn = defineWorkflow({
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });

    expect(Object.keys(fn)).toEqual([]);
    expect(JSON.stringify({fn})).toBe('{}');
    expect({...fn}).toEqual({});
  });

  it('freezes the descriptor, so one reader cannot alter another’s', () => {
    const fn = defineWorkflow({
      title: 'Greeter',
      async run() {
        return 'x';
      },
    });
    const read = workflowDescriptor(fn)!;

    expect(() => {
      (read as {title: string}).title = 'changed';
    }).toThrow();
    expect(workflowDescriptor(fn)?.title).toBe('Greeter');
  });

  it('reports nothing for a function nobody described', () => {
    expect(workflowDescriptor(async () => 'x')).toBeUndefined();
  });

  // The reader is handed whatever an entries loop produced, so it must tolerate values
  // that are not functions at all rather than being the thing that throws.
  it('reports nothing for a value that is not a function', () => {
    for (const value of [undefined, null, 42, 'x', {}, []])
      expect(workflowDescriptor(value)).toBeUndefined();
  });

  /**
   * Partial descriptions are ordinary, not a special case — a missing `title` falls back
   * to the registered name wherever this is displayed, which is the same fallback an
   * entirely undescribed workflow gets.
   */
  it('accepts a description with only some fields', () => {
    const fn = defineWorkflow({
      description: 'No title, just this.',
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(fn)).toEqual({
      description: 'No title, just this.',
    });
  });

  it('accepts a workflow with no props at all', () => {
    const fn = defineWorkflow({
      title: 'Takes nothing',
      async run() {
        return 'x';
      },
    });

    expect(workflowDescriptor(fn)?.props).toBeUndefined();
  });
});

describe('a described workflow on a runtime', () => {
  /**
   * The end-to-end claim: describing a workflow does not change how it is registered or
   * run. If this ever needs a different registration call, the shape has failed.
   *
   * Note the start args — `[props]`, a one-element list holding the props object. That is
   * the constraint a described workflow accepts in exchange for a start form that can be
   * rendered from names rather than from an argument order.
   */
  it('registers and runs exactly as an undescribed one does', async () => {
    const greeter = defineWorkflow({
      title: 'Greet a customer',
      props: {
        type: 'object',
        properties: {name: {type: 'string'}},
        required: ['name'],
      },
      async run(props: {name: string}) {
        return `hello ${props.name}`;
      },
    });
    const rt = createLocalRuntime().registerWorkflow('greeter', greeter);

    await expectAsync(
      rt.start<string>('greeter', {name: 'world'}).result(),
    ).toBeResolvedTo('hello world');
    rt.shutdown();
  });

  // Reading descriptors off a registry is how a catalogue will be assembled, so the
  // iteration shape is worth pinning now: described and undescribed side by side, with
  // the undescribed one present rather than skipped.
  it('lets a registry be read for descriptions, described or not', () => {
    const workflows = {
      described: defineWorkflow({
        title: 'Described',
        async run() {
          return 'x';
        },
      }),
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
