/**
 * @fileoverview
 * A durable HistoryStore backed by the local filesystem — the first real
 * persistence adapter (ROADMAP Phase 4), aimed at single-binary, single-writer
 * deployments on a developer's workstation.
 *
 * Layout under <dir>:
 *   lock                       — single-writer guard (this process's pid)
 *   executions/<enc-id>/
 *     meta.json                — {workflowId, runId, name, args, status, result, failure}
 *     events.jsonl             — the history, one JSON event per line (append-only)
 *
 * The event-sourced history maps almost 1:1 onto an append-only log: `append` is
 * an O(1) line append; `meta.json` is rewritten (atomically, temp+rename) only on
 * create / setStatus / continue-as-new. A write-through in-memory cache is the
 * working copy — it makes reads synchronous-visible (so a signal fired right after
 * start finds the record) and is what a fresh process rebuilds from disk via
 * `load()`. Per-execution write chains serialize concurrent writes.
 */

import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_TASK_QUEUE,
  type Carryover,
  type ExecutionStatus,
  type HistoryEvent,
} from '../../protocol';
import type {
  ActivityRetryState,
  ExecutionRecord,
  HistoryStore,
} from '../ports/history_store';
import {VersionConflictError} from '../ports/history_store';

interface PersistedMeta {
  workflowId: string;
  runId: number;
  name: string;
  args: unknown[];
  /** Absent in data dirs written before routing existed; reads as the default. */
  taskQueue?: string;
  status: ExecutionStatus;
  /** Absent in data dirs written before creation time was recorded. */
  createdAt?: number;
  result?: unknown;
  failureMessage?: string;
  /** Absent in data dirs written before stacks were carried; reads as undefined. */
  failureStack?: string;
  /** Absent in data dirs written before task-failure tracking; reads as 0. */
  taskFailures?: number;
  lastTaskFailure?: string;
  /**
   * Absent in data dirs written before server-decided retry; reads as empty.
   *
   * A bare `number` in dirs written before the failure and the next attempt time
   * were carried alongside the count — those read as an attempt count with
   * neither, which is exactly what was known when they were written.
   */
  activityAttempts?: Record<number, number | ActivityRetryState>;
  /** Absent in data dirs written before carryover existed; reads as empty. */
  carryover?: Carryover;
}

/**
 * Read the retry state back, in either shape it may have been written in.
 *
 * A bare number is a dir written when the count was all that was kept. It
 * restores as that count with no failure message and no next attempt, which is
 * the truth about it — the alternative, discarding the entry, would hand a
 * half-exhausted activity a fresh retry budget on the first boot after an
 * upgrade.
 */
function restoreActivityAttempts(
  stored: Record<number, number | ActivityRetryState> | undefined,
): Record<number, ActivityRetryState> {
  const restored: Record<number, ActivityRetryState> = {};
  for (const [seq, state] of Object.entries(stored ?? {}))
    restored[Number(seq)] =
      typeof state === 'number' ? {attempts: state} : state;
  return restored;
}

/**
 * Rebuild the failure an in-process caller sees after a restart. The stack is
 * reattached rather than left as the one `new Error` just synthesized here,
 * which would describe the *loader* — frames inside the store, on the wrong
 * process, dated to boot time.
 */
function restoreFailure(message: string, stack?: string): Error {
  const error = new Error(message);
  if (stack !== undefined) error.stack = stack;
  return error;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A filesystem-safe, collision-free directory name. The real id lives in meta.json,
// so this need not be reversible — a readable prefix plus a hash is enough.
function encodeName(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

export class FileHistoryStore implements HistoryStore {
  private readonly cache = new Map<string, ExecutionRecord>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private closed = false;

  private constructor(private readonly dir: string) {}

  /** Open (or create) a data dir: acquire the single-writer lock, then load state. */
  static async open(dir: string): Promise<FileHistoryStore> {
    await fs.mkdir(dir, {recursive: true});
    await acquireLock(dir);
    const store = new FileHistoryStore(dir);
    await store.load();
    return store;
  }

  /** Flush pending writes and release the lock. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.writeChains.values()]);
    await fs.rm(path.join(this.dir, 'lock'), {force: true});
  }

  async create(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string = DEFAULT_TASK_QUEUE,
  ): Promise<void> {
    if (this.cache.has(workflowId))
      throw new Error(`execution ${workflowId} already exists`);
    const rec: ExecutionRecord = {
      workflowId,
      runId: 0,
      name,
      args,
      taskQueue,
      createdAt: Date.now(),
      history: [],
      version: 0,
      status: 'running',
      carryover: {},
      taskFailures: 0,
      activityAttempts: {},
    };
    this.cache.set(workflowId, rec); // synchronous → immediately visible to get()
    await this.enqueue(workflowId, async () => {
      const d = this.execDir(workflowId);
      await fs.mkdir(d, {recursive: true});
      await fs.writeFile(path.join(d, 'events.jsonl'), '');
      await this.writeMeta(rec);
    });
  }

  async get(workflowId: string): Promise<ExecutionRecord | undefined> {
    return this.cache.get(workflowId);
  }

  async list(): Promise<ExecutionRecord[]> {
    return [...this.cache.values()];
  }

  async append(workflowId: string, events: HistoryEvent[]): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    await this.persistAppend(workflowId, rec, events);
  }

  async appendIfVersion(
    workflowId: string,
    events: HistoryEvent[],
    expectedVersion: number,
  ): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    if (rec.version !== expectedVersion)
      throw new VersionConflictError(workflowId, expectedVersion, rec.version);
    await this.persistAppend(workflowId, rec, events);
  }

  private async persistAppend(
    workflowId: string,
    rec: ExecutionRecord,
    events: HistoryEvent[],
  ): Promise<void> {
    rec.history.push(...events);
    rec.version += 1;
    const lines = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    await this.enqueue(workflowId, () =>
      fs.appendFile(path.join(this.execDir(workflowId), 'events.jsonl'), lines),
    );
  }

  async recordTaskFailure(workflowId: string, reason: string): Promise<number> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.taskFailures += 1;
    rec.lastTaskFailure = reason;
    await this.enqueue(workflowId, () => this.writeMeta(rec));
    return rec.taskFailures;
  }

  // Guarded, not unconditional: this runs after every successful workflow task,
  // and meta is rewritten atomically (temp + rename). Paying that on every task
  // to clear a counter that is almost always already zero is pure waste.
  async clearTaskFailures(workflowId: string): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec || rec.taskFailures === 0) return;
    rec.taskFailures = 0;
    rec.lastTaskFailure = undefined;
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async recordActivityAttempt(
    workflowId: string,
    seq: number,
    error?: string,
  ): Promise<number> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    const attempts = (rec.activityAttempts[seq]?.attempts ?? 0) + 1;
    // `nextAttemptAt` is dropped rather than carried: the attempt this failure
    // belongs to has just run, so any previously scheduled time is in the past
    // and would read as a retry that is overdue.
    rec.activityAttempts[seq] = {attempts, lastError: error};
    await this.enqueue(workflowId, () => this.writeMeta(rec));
    return attempts;
  }

  async setActivityNextAttempt(
    workflowId: string,
    seq: number,
    at: number,
  ): Promise<void> {
    const rec = this.cache.get(workflowId);
    const state = rec?.activityAttempts[seq];
    if (!rec || !state) return;
    state.nextAttemptAt = at;
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async clearActivityAttempts(workflowId: string, seq: number): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec || rec.activityAttempts[seq] === undefined) return; // nothing to write
    delete rec.activityAttempts[seq];
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async setCarryover(workflowId: string, carryover: Carryover): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.carryover = {...carryover};
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: {result?: unknown; failure?: unknown; failureStack?: string},
  ): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.status = status;
    if (outcome && 'result' in outcome) rec.result = outcome.result;
    if (outcome && 'failure' in outcome) rec.failure = outcome.failure;
    if (outcome && 'failureStack' in outcome)
      rec.failureStack = outcome.failureStack;
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async resetForContinueAsNew(
    workflowId: string,
    args: unknown[],
  ): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history = [];
    rec.args = args;
    rec.version = 0;
    rec.runId += 1;
    await this.enqueue(workflowId, async () => {
      await fs.writeFile(
        path.join(this.execDir(workflowId), 'events.jsonl'),
        '',
      ); // truncate old run
      await this.writeMeta(rec);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────
  private execDir(id: string): string {
    return path.join(this.dir, 'executions', encodeName(id));
  }

  // Serialize writes per execution: each op runs after the previous one settles,
  // and the caller awaits its own op. Errors don't break the chain.
  private enqueue(id: string, op: () => Promise<unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const result = prev
      .then(
        () => (this.closed ? undefined : op()),
        () => (this.closed ? undefined : op()),
      )
      .then(() => undefined);
    this.writeChains.set(
      id,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }

  private async writeMeta(rec: ExecutionRecord): Promise<void> {
    if (this.closed) return;
    const meta: PersistedMeta = {
      workflowId: rec.workflowId,
      runId: rec.runId,
      name: rec.name,
      args: rec.args,
      taskQueue: rec.taskQueue,
      status: rec.status,
      createdAt: rec.createdAt,
      result: rec.result,
      failureMessage:
        rec.failure !== undefined ? errorMessage(rec.failure) : undefined,
      failureStack: rec.failureStack,
      taskFailures: rec.taskFailures,
      lastTaskFailure: rec.lastTaskFailure,
      activityAttempts: rec.activityAttempts,
      carryover: rec.carryover,
    };
    const metaPath = path.join(this.execDir(rec.workflowId), 'meta.json');
    const tmp = `${metaPath}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
      await fs.rename(tmp, metaPath); // atomic replace on the same filesystem
    } catch (e) {
      if (!this.closed) throw e;
    }
  }

  private async load(): Promise<void> {
    const execRoot = path.join(this.dir, 'executions');
    let entries: string[];
    try {
      entries = await fs.readdir(execRoot);
    } catch {
      return; // no executions yet
    }
    for (const entry of entries) {
      const d = path.join(execRoot, entry);
      const metaRaw = await fs
        .readFile(path.join(d, 'meta.json'), 'utf8')
        .catch(() => null);
      if (metaRaw === null) continue;
      const meta = JSON.parse(metaRaw) as PersistedMeta;
      const eventsRaw = await fs
        .readFile(path.join(d, 'events.jsonl'), 'utf8')
        .catch(() => '');
      const history = parseEvents(eventsRaw);
      this.cache.set(meta.workflowId, {
        workflowId: meta.workflowId,
        runId: meta.runId,
        name: meta.name,
        args: meta.args,
        taskQueue: meta.taskQueue ?? DEFAULT_TASK_QUEUE,
        // A data dir written before creation time was recorded still has to sort
        // somewhere, and the first event's timestamp is the closest true answer
        // available. Falling back to 0 rather than to `now` matters: `now` would
        // make every old execution look brand new on the first boot after an
        // upgrade, and shuffle the listing on every boot after that.
        createdAt: meta.createdAt ?? history.find((e) => e.ts)?.ts ?? 0,
        history,
        version: history.length,
        status: meta.status,
        result: meta.result,
        failure:
          meta.failureMessage !== undefined
            ? restoreFailure(meta.failureMessage, meta.failureStack)
            : undefined,
        failureStack: meta.failureStack,
        taskFailures: meta.taskFailures ?? 0,
        lastTaskFailure: meta.lastTaskFailure,
        activityAttempts: restoreActivityAttempts(meta.activityAttempts),
        carryover: meta.carryover ?? {},
      });
    }
  }
}

// Parse the event log, tolerating a crash-truncated final line (that event simply
// wasn't durable — the workflow re-runs it, which is the at-least-once contract).
function parseEvents(raw: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as HistoryEvent);
    } catch {
      // truncated tail — stop here
      break;
    }
  }
  return out;
}

// Is a process still running? Signal 0 checks existence without killing; ESRCH
// means gone, EPERM means alive-but-not-ours. Same-host only (a pid is meaningless
// across machines), which matches the single-writer, single-box assumption.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireLock(dir: string): Promise<void> {
  const lockPath = path.join(dir, 'lock');
  try {
    const fh = await fs.open(lockPath, 'wx'); // exclusive create — fails if held
    await fh.writeFile(String(process.pid));
    await fh.close();
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // A lock file exists. If its holder is still alive, refuse; if the holder is
  // dead (a crash left a stale lock), reclaim it so a restart can proceed. (A live
  // holder includes this same process — a genuine double-open is a bug.)
  const holder = Number(
    (await fs.readFile(lockPath, 'utf8').catch(() => '')).trim(),
  );
  if (holder && isProcessAlive(holder)) {
    throw new Error(
      `data dir ${dir} is locked by a live process (pid ${holder})`,
    );
  }
  await fs.writeFile(lockPath, String(process.pid)); // stale → take it over
}
