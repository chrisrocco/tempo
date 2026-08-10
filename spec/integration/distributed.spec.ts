/**
 * @fileoverview
 * Against a REAL server process (spawned via `node --import tsx bin/server-main`),
 * over real sockets, driving the real deployable worker entrypoint
 * (`examples/greeter.ts`) exactly as `tempo up` deploys it: one binary,
 * its role chosen by --role. Test 2 demonstrates the phase's failure
 * semantics: an activity whose worker "crashed" (ran it but never acked) has its
 * lease expire and is redelivered — so it runs at-least-once.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {
  createRemoteService,
  type RemoteServiceOptions,
} from '../../src/services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  runWorkflowWorker,
  type WorkerLoop,
} from '../../src/worker';
import {runActivity} from '../../src/workflow';
import {repoPath} from '../support/repo_root';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}
const WORKER = repoPath('examples/greeter.ts');

/**
 * Run a deployable entrypoint the way a systemd unit would: an argv and nothing
 * ambient. Configuration used to arrive here as environment variables; it is
 * flags now, for the reasons in `src/process_flags.ts`.
 */
function spawnMain(script: string, args: string[] = []): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForLine(
  proc: ChildProcess,
  re: RegExp,
  timeoutMs = 20000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const to = setTimeout(
      () => reject(new Error(`timeout for ${re}\n[out]${out}\n[err]${err}`)),
      timeoutMs,
    );
    const onOut = (d: Buffer) => {
      out += d.toString();
      const m = out.match(re);
      if (m) {
        cleanup();
        resolve(m);
      }
    };
    const onErr = (d: Buffer) => {
      err += d.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`exited ${code}\n[out]${out}\n[err]${err}`));
    };
    const cleanup = () => {
      clearTimeout(to);
      proc.stdout?.off('data', onOut);
      proc.stderr?.off('data', onErr);
      proc.off('exit', onExit);
    };
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onErr);
    proc.on('exit', onExit);
  });
}

async function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('pollUntil timed out');
    await wait(10);
  }
}

/**
 * A server on an arbitrary port. `--port=0` is asked for explicitly: the default
 * is 7777 now, and a suite leaning on a random default would have had every spec
 * here fighting over one port the moment that default changed.
 */
async function spawnServer(
  args: string[] = [],
): Promise<{url: string; proc: ChildProcess}> {
  const proc = spawnMain(repoPath('bin/server-main.ts'), ['--port=0', ...args]);
  const m = await waitForLine(proc, /LISTENING (\d+)/);
  return {url: `http://127.0.0.1:${m[1]}`, proc};
}

function remote(
  url: string,
  opts?: RemoteServiceOptions,
): ReturnType<typeof createRemoteService> {
  return createRemoteService(url, opts);
}

describe('distributed — real server process over RPC', () => {
  // The deployed shape: one worker binary, started twice, each process taking a
  // single role from --role — what the units `tempo up` writes do.
  it('runs a workflow across a server and the worker binary in each role', async () => {
    const {url, proc: server} = await spawnServer();
    const wf = spawnMain(WORKER, [`--server=${url}`, '--role=workflow']);
    const act = spawnMain(WORKER, [`--server=${url}`, '--role=activity']);
    try {
      await waitForLine(wf, /WORKER_READY greeter workflow/);
      await waitForLine(act, /WORKER_READY greeter activity/);

      const service = remote(url);
      const {workflowId} = service.start('greeter', ['world']);
      await expectAsync(service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await kill(wf);
      await kill(act);
      await kill(server);
    }
  }, 30000);

  // The dev shape: --role unset, so one process serves both roles. This is
  // what a hand-run binary does.
  it('runs a workflow with one worker process serving both roles', async () => {
    const {url, proc: server} = await spawnServer();
    const worker = spawnMain(WORKER, [`--server=${url}`]);
    try {
      await waitForLine(worker, /WORKER_READY greeter workflow,activity/);

      const service = remote(url);
      const {workflowId} = service.start('greeter', ['world']);
      await expectAsync(service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await kill(worker);
      await kill(server);
    }
  }, 30000);

  /**
   * A workflow the worker cannot run keeps its execution alive and reports why.
   *
   * This used to settle the execution as failed, on the reading that an
   * unregistered name is a typo. Once tasks are routed by queue it far more often
   * means a deploy still rolling, and a typo is no longer expensive to diagnose:
   * the reason is on the record, `describe` prints it, and `terminate` ends it.
   * Failing fast would trade a recoverable state for an unrecoverable one.
   */
  it('keeps an execution alive when no worker has its workflow, and says why', async () => {
    const {url, proc: server} = await spawnServer();
    const worker = spawnMain(WORKER, [`--server=${url}`]);
    try {
      await waitForLine(worker, /WORKER_READY/);

      const service = remote(url);
      const {workflowId} = service.start('not-a-workflow');

      // Give the task a few attempts to be reported and counted.
      let detail = await service.describeExecution(workflowId);
      const deadline = Date.now() + 10000;
      while ((detail?.taskFailures ?? 0) === 0 && Date.now() < deadline) {
        await wait(100);
        detail = await service.describeExecution(workflowId);
      }

      expect(detail?.status).toBe('running'); // not settled behind your back
      expect(detail?.taskFailures).toBeGreaterThan(0);
      expect(detail?.lastTaskFailure).toContain(
        'no workflow registered as not-a-workflow',
      );
    } finally {
      await kill(worker);
      await kill(server);
    }
  }, 30000);

  it('redelivers an activity after its lease expires, running it at-least-once', async () => {
    const {url, proc: server} = await spawnServer(['--activity-lease-ms=60']);
    const service = remote(url);

    const workflowRegistry = createWorkflowRegistry();
    workflowRegistry.set('doer', async () => runActivity<string>('work'));
    let runs = 0;
    const activityRegistry = createActivityRegistry();
    activityRegistry.set('work', () => {
      runs += 1;
      return 'done';
    });
    const activityWorker = createActivityWorker(activityRegistry);

    let wfLoop: WorkerLoop | undefined;
    try {
      // only the workflow worker runs a loop; we drive the activity by hand to
      // simulate a worker that ran the task but crashed before acking.
      wfLoop = runWorkflowWorker(
        service,
        createWorkflowWorker(workflowRegistry),
      );

      const {workflowId} = service.start('doer');

      const first = await pollUntil(() => service.pollActivityTask());
      await activityWorker.runTask(first); // ran once, but we never complete it → "crash"
      await wait(150); // lease (60ms) expires → the task is eligible for redelivery

      const second = await pollUntil(() => service.pollActivityTask());
      await activityWorker.runTask(second); // redelivered → runs again
      await service.completeActivityTask(second.token, {
        ok: true,
        result: 'done',
      });

      await expectAsync(service.getResult(workflowId)).toBeResolvedTo('done');
      expect(runs).toBe(2); // at-least-once: the crashed attempt + the redelivery
    } finally {
      if (wfLoop) await wfLoop.stop();
      await kill(server);
    }
  }, 30000);
});
