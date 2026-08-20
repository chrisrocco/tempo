/**
 * Fleet view: `listQueues()` — which pools are being asked for work, by whom,
 * and what is waiting on them. The verdicts come from the engine's own
 * predicates (`isQueueServed`), not reimplemented here — that is the point.
 */
import type {QueueWorkers, WorkerRole} from '../../../src/protocol';
import {isQueueServed} from '../../../src/protocol';
import {usePoll, formatAge} from '../rpc';

export function Fleet() {
  const {data, error} = usePoll<QueueWorkers[]>(() => ({method: 'listQueues'}));
  const now = Date.now();

  return (
    <div>
      <h2>Fleet</h2>
      <p className="view-sub">
        Task queues and the workers polling them. A queue can be quiet because
        nothing needs doing — or because nothing is coming. The backlog columns
        are what tell those apart.
      </p>
      {error !== undefined && <p className="error-text">{error}</p>}
      {data === undefined ? (
        <p className="muted">Loading…</p>
      ) : data.length === 0 ? (
        <p className="muted">No queue has ever been polled or given work.</p>
      ) : (
        data.map((q) => <QueueCard key={q.taskQueue} q={q} queues={data} now={now} />)
      )}
    </div>
  );
}

function ServedBadge({
  queues,
  taskQueue,
  role,
  now,
}: {
  queues: QueueWorkers[];
  taskQueue: string;
  role: WorkerRole;
  now: number;
}) {
  const served = isQueueServed(queues, taskQueue, role, now);
  return (
    <span className={served ? 'badge ok' : 'badge bad'}>
      {role} {served ? 'served' : 'unserved'}
    </span>
  );
}

function QueueCard({
  q,
  queues,
  now,
}: {
  q: QueueWorkers;
  queues: QueueWorkers[];
  now: number;
}) {
  const backlog = q.pendingWorkflowTasks + q.pendingActivities;
  return (
    <div className="card">
      <div className="row">
        <h3>
          <code>{q.taskQueue}</code>
        </h3>
        <ServedBadge queues={queues} taskQueue={q.taskQueue} role="workflow" now={now} />
        <ServedBadge queues={queues} taskQueue={q.taskQueue} role="activity" now={now} />
        {backlog > 0 && (
          <span className="badge warn">
            {backlog} task{backlog === 1 ? '' : 's'} waiting
          </span>
        )}
        <span style={{marginLeft: 'auto'}} className="muted">
          wf poll {formatAge(q.workflowPolledAt, now)} · act poll{' '}
          {formatAge(q.activityPolledAt, now)}
        </span>
      </div>
      <div className="row" style={{marginTop: 6}}>
        <span className="chip">
          pending workflow tasks: {q.pendingWorkflowTasks}
        </span>
        <span className="chip">pending activities: {q.pendingActivities}</span>
      </div>
      {q.workers.length > 0 ? (
        <table className="props-table">
          <thead>
            <tr>
              <th>identity</th>
              <th>role</th>
              <th>state</th>
              <th>last poll</th>
              <th>serves</th>
            </tr>
          </thead>
          <tbody>
            {q.workers.map((w) => (
              <tr key={`${w.identity}:${w.role}`}>
                <td>
                  <code>{w.identity}</code>
                </td>
                <td className="muted">{w.role}</td>
                <td>
                  {w.busy ? (
                    <span className="badge running">busy</span>
                  ) : (
                    <span className="muted">idle</span>
                  )}
                </td>
                <td className="muted">{formatAge(w.lastPolledAt, now)}</td>
                <td className="muted">
                  {w.serves === undefined ? (
                    <em title="This worker has not reported (or its report is stale) — unknown, not none.">
                      unknown
                    </em>
                  ) : (
                    w.serves.map((name) => (
                      <span key={name} className="chip" style={{marginRight: 4}}>
                        {name}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted" style={{marginBottom: 0}}>
          No worker has ever polled this queue — work routed here waits forever.
        </p>
      )}
    </div>
  );
}
