/**
 * @fileoverview
 * The browser shims, and the one property that makes the subtle one sound.
 *
 * These ship so a consumer hosting the engine in a browser does not have to
 * rediscover them — and the `async_hooks` one especially, because the obvious
 * implementation is wrong in a way that produces a baffling error far from its
 * cause. What it must do is survive an `await`: the engine's driver resolves a
 * parked promise from *outside* the `run()` scope, and the workflow's
 * continuation still has to find its context. A shim that restores in a
 * `finally` loses it the moment the workflow first suspends.
 *
 * Node has real `AsyncLocalStorage`, so these run against the shim by importing
 * it directly rather than through the alias a bundler would apply.
 */

import {AsyncLocalStorage} from '../../src/sandbox/shims/async_hooks';
import {createHash} from '../../src/sandbox/shims/crypto';
import {join} from '../../src/sandbox/shims/path';
import {promises as fs} from '../../src/sandbox/shims/fs';

describe('the AsyncLocalStorage shim', () => {
  it('keeps the store across an await, which is the whole point', async () => {
    const als = new AsyncLocalStorage<{id: string}>();
    let seen: string | undefined;

    // Exactly the engine's shape: `run` returns at the first suspension, and
    // the continuation reads the store afterwards.
    const running = als.run({id: 'wf-1'}, async () => {
      await Promise.resolve();
      seen = als.getStore()?.id;
    });
    await running;

    expect(seen).toBe('wf-1');
  });

  it('gives each instance its own slot', () => {
    // The engine keeps two — workflow context and activity context — and their
    // loops interleave. One slot shared across instances lets a running
    // activity clobber a parked workflow's context.
    const workflows = new AsyncLocalStorage<string>();
    const activities = new AsyncLocalStorage<string>();

    workflows.run('replaying', () => {
      activities.run('running an activity', () => undefined);
      expect(workflows.getStore()).toBe('replaying');
    });
  });

  it('hands the next replay its own store', () => {
    // Serialised replay is the constraint this shim depends on; what it must
    // do in exchange is never leak one replay's context into the next.
    const als = new AsyncLocalStorage<string>();

    als.run('first', () => undefined);
    als.run('second', () => undefined);

    expect(als.getStore()).toBe('second');
  });
});

describe('the remaining shims', () => {
  it('hashes stably, which is all the manifest digest needs', () => {
    // Compared for equality and nothing else — it authenticates nothing. What
    // it must be is the same answer twice, or a worker's report reads as stale
    // the moment it polls.
    const digest = () =>
      createHash('sha256').update('scenarioParks').digest('hex');

    expect(digest()).toBe(digest());
    expect(digest()).not.toBe(
      createHash('sha256').update('scenarioRetries').digest('hex'),
    );
  });

  it('joins paths without a disk', () => {
    expect(join('a', 'b', 'c')).toBe('a/b/c');
    expect(join('a/', '/b')).toBe('a/b');
  });

  it('refuses to pretend it wrote a file', () => {
    // Loud rather than silent, and synchronous rather than a rejected promise:
    // a stub nobody should reach is better as a stack trace at the call than as
    // a rejection something might swallow.
    expect(() => fs.writeFile()).toThrowError(
      /not available in the browser sandbox/,
    );
  });
});
