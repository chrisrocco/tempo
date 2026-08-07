/**
 * @fileoverview
 * A process with pending workflow work must not exit, and a process with none
 * must not hang.
 *
 * Both halves matter, and they pull against each other — which is why they are
 * asserted together rather than separately. Timers that never hold the loop open
 * lose work silently; timers that always hold it open leave a script that has
 * finished sitting there forever. The engine has to distinguish "something is
 * going to happen" from "nothing is".
 *
 * ## Why this spawns a process
 *
 * Because the failure is invisible from inside the suite. Jasmine's runner holds
 * the event loop open for the duration of a run, so a workflow timer that could
 * not keep a process alive on its own still fires here every time. Every
 * in-suite assertion about this passes whether the bug is present or not — which
 * is how it survived: `createLocalRuntime` + `sleep` in a standalone script
 * exited 0, printed nothing, and ran none of the workflow past its first park.
 *
 * The child is `spec/support/parked_workflow.ts`, deliberately written the way
 * someone trying the engine out would write it: no shutdown, no keepalive,
 * nothing awaiting the result.
 */

import {spawn} from 'node:child_process';
import * as path from 'node:path';

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * Run a script to completion, killing it if it outlives `timeoutMs`.
 *
 * A timeout is a *result* here rather than an error, because "did it exit on its
 * own" is one of the things under test — a hang has to be assertable rather than
 * something that takes the suite down with it.
 */
function run(script: string, timeoutMs = 10_000): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve(script)],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

const SCRIPT = 'spec/support/parked_workflow.ts';

describe('process lifetime — a workflow parked on a timer', () => {
  let result: Run;

  beforeAll(async () => {
    result = await run(SCRIPT);
  }, 20_000);

  it('keeps the process alive until the timer fires', () => {
    // The whole bug in one assertion. Before this was fixed the script printed
    // SCRIPT_ENDED and exited 0 without this line ever appearing.
    expect(result.stdout).toContain('WORKFLOW_FINISHED');
  });

  it('lets the script itself finish first, rather than blocking it', () => {
    // The workflow is not awaited: `start` returns immediately and the script
    // runs to its end. What keeps the process alive is the pending timer, not
    // anything the script is waiting on.
    expect(result.stdout.indexOf('SCRIPT_ENDED')).toBeLessThan(
      result.stdout.indexOf('WORKFLOW_FINISHED'),
    );
  });

  it('exits on its own once nothing is pending', () => {
    // The other half. A timer that holds the loop open forever would trade a
    // silent exit for a script that never returns, which is not an improvement.
    expect(result.timedOut).toBeFalse();
    expect(result.code).toBe(0);
  });

  it('exits promptly rather than waiting out some unrelated interval', () => {
    // Generous, because this spawns a TypeScript-transpiling child on a loaded
    // CI box. It is here to catch a keepalive that outlives the work — a stray
    // `setInterval` would push this into the seconds.
    expect(result.elapsedMs).toBeLessThan(8_000);
  });

  it('reports no error on the way out', () => {
    expect(result.stderr).toBe('');
  });
});

/**
 * The same property for the other scheduler. Workflow `sleep` goes through the
 * `TimerService`; a retry backoff is a bare `setTimeout` inside `server_core`.
 * They are different code, so fixing one proves nothing about the other — and
 * the second was a live instance of the bug after the first was fixed.
 */
describe('process lifetime — an activity waiting out a retry backoff', () => {
  let result: Run;

  beforeAll(async () => {
    result = await run('spec/support/retrying_workflow.ts');
  }, 20_000);

  it('keeps the process alive until the retry runs', () => {
    expect(result.stdout).toContain('WORKFLOW_FINISHED');
  });

  it('exits on its own once the retry has happened', () => {
    expect(result.timedOut).toBeFalse();
    expect(result.code).toBe(0);
  });
});

/**
 * The price of ref'ing progress timers, and the thing that pays it.
 *
 * Once a pending retry keeps a process alive, an abandoned one keeps it alive
 * forever — so `shutdown` has to be able to drop them. The backoff here is 30
 * seconds and the script asks to stop after 300ms, so "released it" and "waited
 * it out" are not close enough to confuse.
 */
describe('process lifetime — shutdown during a retry backoff', () => {
  let result: Run;

  beforeAll(async () => {
    result = await run('spec/support/shutdown_during_backoff.ts', 15_000);
  }, 25_000);

  it('reached the backoff it is meant to abandon', () => {
    // Otherwise the timing assertion below would pass for the wrong reason: a
    // script that never armed a retry has nothing to release.
    expect(result.stdout).toContain('ATTEMPTED');
    expect(result.stdout).toContain('SHUTDOWN_CALLED');
  });

  it('exits without waiting out the backoff', () => {
    expect(result.timedOut).toBeFalse();
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(10_000); // the backoff is 30s
  });
});
