// A durable HistoryStore backed by the local filesystem — the first real
// persistence adapter (ROADMAP Phase 4), aimed at single-binary, single-writer
// deployments on a developer's workstation.
//
// Layout under <dir>:
//   lock                       — single-writer guard (this process's pid)
//   executions/<enc-id>/
//     meta.json                — {workflowId, runId, name, args, status, result, failure}
//     events.jsonl             — the history, one JSON event per line (append-only)
//
// The event-sourced history maps almost 1:1 onto an append-only log: `append` is
// an O(1) line append; `meta.json` is rewritten (atomically, temp+rename) only on
// create / setStatus / continue-as-new. A write-through in-memory cache is the
// working copy — it makes reads synchronous-visible (so a signal fired right after
// start finds the record) and is what a fresh process rebuilds from disk via
// `load()`. Per-execution write chains serialize concurrent writes.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ExecutionStatus, HistoryEvent } from '../../protocol';
import type { ExecutionRecord, HistoryStore } from '../ports/history_store';

interface PersistedMeta {
  workflowId: string;
  runId: number;
  name: string;
  args: unknown[];
  status: ExecutionStatus;
  result?: unknown;
  failureMessage?: string;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

  private constructor(private readonly dir: string) {}

  /** Open (or create) a data dir: acquire the single-writer lock, then load state. */
  static async open(dir: string): Promise<FileHistoryStore> {
    await fs.mkdir(dir, { recursive: true });
    await acquireLock(dir);
    const store = new FileHistoryStore(dir);
    await store.load();
    return store;
  }

  /** Flush pending writes and release the lock. */
  async close(): Promise<void> {
    await Promise.all([...this.writeChains.values()]);
    await fs.rm(path.join(this.dir, 'lock'), { force: true });
  }

  async create(workflowId: string, name: string, args: unknown[]): Promise<void> {
    if (this.cache.has(workflowId)) throw new Error(`execution ${workflowId} already exists`);
    const rec: ExecutionRecord = {
      workflowId, runId: 0, name, args, history: [], version: 0, status: 'running',
    };
    this.cache.set(workflowId, rec); // synchronous → immediately visible to get()
    await this.enqueue(workflowId, async () => {
      const d = this.execDir(workflowId);
      await fs.mkdir(d, { recursive: true });
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
    rec.history.push(...events);
    rec.version += 1;
    const lines = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    await this.enqueue(workflowId, () =>
      fs.appendFile(path.join(this.execDir(workflowId), 'events.jsonl'), lines));
  }

  async setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: { result?: unknown; failure?: unknown },
  ): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.status = status;
    if (outcome && 'result' in outcome) rec.result = outcome.result;
    if (outcome && 'failure' in outcome) rec.failure = outcome.failure;
    await this.enqueue(workflowId, () => this.writeMeta(rec));
  }

  async resetForContinueAsNew(workflowId: string, args: unknown[]): Promise<void> {
    const rec = this.cache.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history = [];
    rec.args = args;
    rec.version = 0;
    rec.runId += 1;
    await this.enqueue(workflowId, async () => {
      await fs.writeFile(path.join(this.execDir(workflowId), 'events.jsonl'), ''); // truncate old run
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
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const result = prev.then(op, op).then(() => undefined);
    this.writeChains.set(id, result.then(() => {}, () => {}));
    return result;
  }

  private async writeMeta(rec: ExecutionRecord): Promise<void> {
    const meta: PersistedMeta = {
      workflowId: rec.workflowId, runId: rec.runId, name: rec.name, args: rec.args,
      status: rec.status, result: rec.result,
      failureMessage: rec.failure !== undefined ? errorMessage(rec.failure) : undefined,
    };
    const metaPath = path.join(this.execDir(rec.workflowId), 'meta.json');
    const tmp = `${metaPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, metaPath); // atomic replace on the same filesystem
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
      const metaRaw = await fs.readFile(path.join(d, 'meta.json'), 'utf8').catch(() => null);
      if (metaRaw === null) continue;
      const meta = JSON.parse(metaRaw) as PersistedMeta;
      const eventsRaw = await fs.readFile(path.join(d, 'events.jsonl'), 'utf8').catch(() => '');
      const history = parseEvents(eventsRaw);
      this.cache.set(meta.workflowId, {
        workflowId: meta.workflowId,
        runId: meta.runId,
        name: meta.name,
        args: meta.args,
        history,
        version: history.length,
        status: meta.status,
        result: meta.result,
        failure: meta.failureMessage !== undefined ? new Error(meta.failureMessage) : undefined,
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

async function acquireLock(dir: string): Promise<void> {
  const lockPath = path.join(dir, 'lock');
  try {
    const fh = await fs.open(lockPath, 'wx'); // exclusive create — fails if held
    await fh.writeFile(String(process.pid));
    await fh.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`data dir ${dir} is locked by another process (remove ${lockPath} if stale)`);
    }
    throw e;
  }
}
