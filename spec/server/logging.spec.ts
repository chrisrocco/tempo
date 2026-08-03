/**
 * @fileoverview
 * The structured lifecycle log: that events are emitted where they matter, and
 * that the line shape stays machine-readable. These assertions are deliberately
 * about *event names and fields* rather than prose — the whole reason for
 * structured logging is that a later metrics backend can consume this without
 * anyone parsing sentences, and a test on wording would not protect that.
 */

import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createJsonLogger,
  createServerCore,
  silentLogger,
  type LogFields,
} from '../../src/server';

interface Captured {
  event: string;
  fields: LogFields;
}

function capturingCore(historyStore: MemoryHistoryStore) {
  const events: Captured[] = [];
  const workflowTaskQueue = new MemoryWorkflowTaskQueue();
  const core = createServerCore({
    historyStore,
    workflowTaskQueue,
    activityTaskQueue: new MemoryTaskQueue(),
    timerService: new MemoryTimerService(),
    launch: () => 'child',
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
    log: (event, fields = {}) => events.push({ event, fields }),
  });
  return { core, workflowTaskQueue, events };
}

describe('the JSON Lines log format', () => {
  it('writes one self-contained JSON object per line', () => {
    const lines: string[] = [];
    const log = createJsonLogger((line) => lines.push(line));

    log('activity.scheduled', { workflowId: 'wf', seq: 0 });

    expect(lines.length).toBe(1);
    expect(lines[0].endsWith('\n')).toBeTrue();
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.event).toBe('activity.scheduled');
    expect(parsed.workflowId).toBe('wf');
    expect(parsed.seq).toBe(0);
    expect(typeof parsed.ts).toBe('string');
  });

  it('emits an event with no fields as a valid line', () => {
    const lines: string[] = [];
    createJsonLogger((line) => lines.push(line))('server.started');
    expect(JSON.parse(lines[0]).event).toBe('server.started');
  });
});

describe('lifecycle events', () => {
  it('records an activity being scheduled and then settling', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, events } = capturingCore(historyStore);
    await historyStore.create('wf', 'w', []);
    await core.applyWorkflowTaskResult('wf', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        {
          type: 'scheduleActivity',
          seq: 0,
          name: 'greet',
          args: [],
          options: {},
        },
      ],
    });
    await core.reportActivityResult('wf', 0, { ok: true, result: 'hi' });

    expect(events.map((e) => e.event)).toEqual([
      'activity.scheduled',
      'activity.settled',
    ]);
    expect(events[0].fields).toEqual({
      workflowId: 'wf',
      seq: 0,
      name: 'greet',
      taskQueue: 'default',
    });
    expect(events[1].fields.ok).toBeTrue();
  });

  it('reports a failing workflow task with its consecutive count and next retry', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue, events } = capturingCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'nondeterminism at seq 0');

    const failed = events.find((e) => e.event === 'workflow_task.failed');
    expect(failed).toBeDefined();
    expect(failed!.fields.reason).toBe('nondeterminism at seq 0');
    expect(failed!.fields.consecutiveFailures).toBe(1);
    expect(typeof failed!.fields.retryInMs).toBe('number');
  });

  it('records a terminated execution with the reason and how long it was stuck', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue, events } = capturingCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');
    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'boom');

    await core.terminate('wf', 'operator gave up');

    const settled = events.find((e) => e.event === 'execution.settled');
    expect(settled!.fields.status).toBe('terminated');
    expect(settled!.fields.reason).toBe('operator gave up');
    expect(settled!.fields.taskFailures).toBe(1);
  });

  // The dedup is invisible by construction — it drops work rather than doing it —
  // so without an event the only evidence would be an absence in history.
  it('records a duplicate activity completion being dropped', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, events } = capturingCore(historyStore);
    await historyStore.create('wf', 'w', []);
    await historyStore.append('wf', [
      { type: 'activityScheduled', seq: 0, name: 'a', args: [], options: {} },
      { type: 'activityCompleted', seq: 0, result: 'first' },
    ]);

    await core.reportActivityResult('wf', 0, { ok: true, result: 'second' });

    expect(events.map((e) => e.event)).toContain('activity.duplicate_dropped');
  });

  // A library that writes to stderr uninvited is one people wrap to shut up, so
  // the default is silence — and that is worth an assertion against the real
  // stream rather than against a stub that could not have been called anyway.
  it('writes nothing to stderr when no logger is supplied', async () => {
    const stderr = spyOn(process.stderr, 'write').and.returnValue(true);
    const historyStore = new MemoryHistoryStore();
    const core = createServerCore({
      historyStore,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => 'child',
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
      // `log` deliberately omitted — this is the default path.
    });
    await historyStore.create('wf', 'w', []);
    await core.terminate('wf', 'quiet please');

    expect(stderr).not.toHaveBeenCalled();
  });

  it('is silent when explicitly given the silent logger', async () => {
    const stderr = spyOn(process.stderr, 'write').and.returnValue(true);
    const historyStore = new MemoryHistoryStore();
    const core = createServerCore({
      historyStore,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => 'child',
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
      log: silentLogger,
    });
    await historyStore.create('wf', 'w', []);
    await core.terminate('wf', 'quiet please');

    expect(stderr).not.toHaveBeenCalled();
  });
});
