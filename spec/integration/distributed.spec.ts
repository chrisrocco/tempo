// Against a REAL server process (spawned via `node --import tsx bin/server-main`),
// over real sockets, driving the real deployable worker entrypoint
// (`examples/greeter.ts`) exactly as `tempo deploy` would: one binary,
// its role chosen by TEMPO_ROLE. Test 2 demonstrates the phase's failure
// semantics: an activity whose worker "crashed" (ran it but never acked) has its
// lease expire and is redelivered — so it runs at-least-once.
import { spawn, type ChildProcess } from 'node:child_process';
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
import { runActivity } from '../../src/workflow';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WORKER = 'examples/greeter.ts';

function spawnMain(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    env: { ...process.env, ...env },
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

async function spawnServer(
  env: Record<string, string> = {},
): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawnMain('bin/server-main.ts', env);
  const m = await waitForLine(proc, /LISTENING (\d+)/);
  return { url: `http://127.0.0.1:${m[1]}`, proc };
}

const remote = (url: string, opts?: RemoteServiceOptions) =>
  createRemoteService(url, opts);

describe('distributed — real server process over RPC', () => {
  // The deployed shape: one worker binary, started twice, each process taking a
  // single role from TEMPO_ROLE — what the generated systemd units do.
  it('runs a workflow across a server and the worker binary in each role', async () => {
    const { url, proc: server } = await spawnServer();
    const wf = spawnMain(WORKER, {
      TEMPO_SERVER_URL: url,
      TEMPO_ROLE: 'workflow',
    });
    const act = spawnMain(WORKER, {
      TEMPO_SERVER_URL: url,
      TEMPO_ROLE: 'activity',
    });
    try {
      await waitForLine(wf, /WORKER_READY greeter workflow/);
      await waitForLine(act, /WORKER_READY greeter activity/);

      const service = remote(url);
      const { workflowId } = service.start('greeter', ['world']);
      await expectAsync(service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await kill(wf);
      await kill(act);
      await kill(server);
    }
  }, 30000);

  // The dev shape: TEMPO_ROLE unset, so one process serves both roles. This is
  // what `tempo up` and a hand-run binary do.
  it('runs a workflow with one worker process serving both roles', async () => {
    const { url, proc: server } = await spawnServer();
    const worker = spawnMain(WORKER, { TEMPO_SERVER_URL: url });
    try {
      await waitForLine(worker, /WORKER_READY greeter workflow,activity/);

      const service = remote(url);
      const { workflowId } = service.start('greeter', ['world']);
      await expectAsync(service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await kill(worker);
      await kill(server);
    }
  }, 30000);

  // A workflow name the worker does not have is ordinary user error (a typo), so
  // it must settle the execution rather than wedge the worker. Before this was a
  // failed task result, replayTask threw, the task could never be completed, and
  // the lease redelivered it forever while the client waited on `running`.
  it('fails an execution whose workflow is not registered, rather than retrying forever', async () => {
    const { url, proc: server } = await spawnServer();
    const worker = spawnMain(WORKER, { TEMPO_SERVER_URL: url });
    try {
      await waitForLine(worker, /WORKER_READY/);

      const service = remote(url);
      const { workflowId } = service.start('not-a-workflow');
      await expectAsync(service.getResult(workflowId)).toBeRejectedWithError(
        /no workflow registered as not-a-workflow/,
      );
    } finally {
      await kill(worker);
      await kill(server);
    }
  }, 30000);

  // How `tempo deploy` interrogates a built binary: it reports what it contains
  // and exits, without connecting to a server (none is running here).
  it('reports its workflows and activities under --describe, without connecting', async () => {
    const proc = spawnMain(WORKER, {}, ['--describe']);
    try {
      const [line] = await waitForLine(proc, /\{.*\}/);
      expect(JSON.parse(line)).toEqual({
        name: 'greeter',
        workflows: ['greeter'],
        activities: ['greet'], // GREETING is a constant, so it is not an activity
      });
    } finally {
      await kill(proc);
    }
  }, 30000);

  it('redelivers an activity after its lease expires, running it at-least-once', async () => {
    const { url, proc: server } = await spawnServer({
      ACTIVITY_LEASE_MS: '60',
    });
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

      const { workflowId } = service.start('doer');

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
