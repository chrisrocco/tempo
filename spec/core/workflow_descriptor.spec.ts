/**
 * @fileoverview
 * `defineWorkflow` — describing a workflow where it is defined.
 *
 * The point of the shape is that it changes nothing. A described workflow registers,
 * runs, and unit-tests exactly as an undescribed one does, because it *is* the same
 * function — so adopting this is one workflow at a time rather than a migration.
 *
 * Most of these specs exist to pin that invisibility, which is the property a future
 * change is most likely to break by reaching for a wrapper object instead.
 */

import 'jasmine';
import {createLocalRuntime} from '../../src';
import {defineWorkflow} from '../../src/workflow';
import {workflowDescriptor} from '../../src/workflow_descriptor';

describe('defineWorkflow', () => {
  it('returns the very same function', () => {
    const fn = async (): Promise<string> => 'hi';
    expect(defineWorkflow({title: 'Greeter'}, fn)).toBe(fn);
  });

  it('leaves the function callable, with its arguments and result intact', async () => {
    const greet = defineWorkflow(
      {title: 'Greeter'},
      async (name: string) => `hello ${name}`,
    );

    await expectAsync(greet('world')).toBeResolvedTo('hello world');
  });

  it('reads back what it was given', () => {
    const input = {type: 'array', prefixItems: [{type: 'string'}]};
    const fn = defineWorkflow(
      {
        title: 'Greet a customer',
        description: 'Sends the welcome email.',
        input,
      },
      async () => 'x',
    );

    expect(workflowDescriptor(fn)).toEqual({
      title: 'Greet a customer',
      description: 'Sends the welcome email.',
      input,
    });
  });

  /**
   * The invisibility that matters most: a described function must not look different to
   * anything that enumerates it. `startWorker({workflows})` iterates entries, specs
   * compare objects, and a stray enumerable key would surface in all of them.
   */
  it('adds nothing enumerable', () => {
    const fn = defineWorkflow({title: 'Greeter'}, async () => 'x');

    expect(Object.keys(fn)).toEqual([]);
    expect(JSON.stringify({fn})).toBe('{}');
    expect({...fn}).toEqual({});
  });

  it('freezes the descriptor, so one reader cannot alter another’s', () => {
    const fn = defineWorkflow({title: 'Greeter'}, async () => 'x');
    const read = workflowDescriptor(fn)!;

    expect(() => {
      (read as {title: string}).title = 'changed';
    }).toThrow();
    expect(workflowDescriptor(fn)?.title).toBe('Greeter');
  });

  // Copied on the way in: a caller that keeps mutating its own object does not thereby
  // mutate what every reader sees.
  it('is unaffected by later changes to the object passed in', () => {
    const descriptor = {title: 'Greeter'};
    const fn = defineWorkflow(descriptor, async () => 'x');
    descriptor.title = 'changed';

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

  it('takes the last description when one function is described twice', () => {
    const fn = async (): Promise<string> => 'x';
    defineWorkflow({title: 'First'}, fn);
    defineWorkflow({title: 'Second'}, fn);

    expect(workflowDescriptor(fn)?.title).toBe('Second');
  });

  /**
   * Partial descriptions are ordinary, not a special case — a missing `title` falls back
   * to the registered name wherever this is displayed, which is the same fallback an
   * entirely undescribed workflow gets.
   */
  it('accepts a description with only some fields', () => {
    const fn = defineWorkflow(
      {description: 'No title, just this.'},
      async () => 'x',
    );

    expect(workflowDescriptor(fn)).toEqual({
      description: 'No title, just this.',
    });
  });
});

describe('a described workflow on a runtime', () => {
  /**
   * The end-to-end claim: describing a workflow does not change how it is registered or
   * run. If this ever needs a different registration call, the shape has failed.
   */
  it('registers and runs exactly as an undescribed one does', async () => {
    const greeter = defineWorkflow(
      {
        title: 'Greet a customer',
        input: {type: 'array', prefixItems: [{type: 'string'}]},
      },
      async (name: string) => `hello ${name}`,
    );
    const rt = createLocalRuntime().registerWorkflow('greeter', greeter);

    await expectAsync(
      rt.start<string>('greeter', ['world']).result(),
    ).toBeResolvedTo('hello world');
    rt.shutdown();
  });

  // Reading descriptors off a registry is how a catalogue will be assembled, so the
  // iteration shape is worth pinning now: described and undescribed side by side, with
  // the undescribed one present rather than skipped.
  it('lets a registry be read for descriptions, described or not', () => {
    const workflows = {
      described: defineWorkflow({title: 'Described'}, async () => 'x'),
      plain: async (): Promise<string> => 'x',
    };

    expect(
      Object.entries(workflows).map(([name, fn]) => ({
        name,
        title: workflowDescriptor(fn)?.title ?? name,
      })),
    ).toEqual([
      {name: 'described', title: 'Described'},
      {name: 'plain', title: 'plain'},
    ]);
  });
});
