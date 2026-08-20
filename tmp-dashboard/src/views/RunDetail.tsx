/**
 * Run detail: `describeExecution()` — the summary plus history, pending work,
 * and parked conditions. The "why is this not moving" view: pending +
 * parked together distinguish waiting, mid-task, and wedged.
 */
import type {ExecutionDetail, HistoryEvent} from '../../../src/protocol';
import {isStuck} from '../../../src/protocol';
import {usePoll, formatAge} from '../rpc';

export function RunDetail({workflowId}: {workflowId: string}) {
  const {data, error} = usePoll<ExecutionDetail | null>(
    () => ({method: 'describeExecution', workflowId}),
    2000,
    [workflowId],
  );
  const now = Date.now();

  if (error !== undefined) return <p className="error-text">{error}</p>;
  if (data === undefined) return <p className="muted">Loading…</p>;
  if (data === null)
    return (
      <div>
        <a className="back-link" href="#/executions">
          ← executions
        </a>
        <p className="error-text">
          No execution with id <code>{workflowId}</code>.
        </p>
      </div>
    );

  const d = data;
  const waitingShape =
    d.status !== 'running'
      ? undefined
      : isStuck(d)
        ? 'Wedged: the engine cannot replay this execution and is retrying its workflow task on a backoff.'
        : d.parked.length > 0
          ? 'Parked on a condition — waiting for a signal or state change.'
          : d.pending.activities.length +
                d.pending.timers.length +
                d.pending.children.length >
              0
            ? 'Waiting on dispatched work below.'
            : 'Nothing pending and nothing parked: its workflow task is in flight right now.';

  return (
    <div>
      <a className="back-link" href="#/executions">
        ← executions
      </a>
      <div className="row" style={{margin: '10px 0 2px'}}>
        <h2 className="mono">{d.workflowId}</h2>
        <span className={`badge ${d.status}`}>{d.status}</span>
        {isStuck(d) && (
          <span className="badge warn">stuck ×{d.taskFailures}</span>
        )}
        {d.cancelRequested && <span className="badge warn">cancel requested</span>}
      </div>
      <p className="view-sub">
        <code>{d.name}</code> on <span className="chip queue">{d.taskQueue}</span>{' '}
        · started {formatAge(d.createdAt, now)} · run #{d.runId} ·{' '}
        {d.historyLength} events
        {d.parent !== undefined && (
          <>
            {' '}
            · child of{' '}
            <a
              className="id-link mono"
              href={`#/run/${encodeURIComponent(d.parent.workflowId)}`}
            >
              {d.parent.workflowId}
            </a>
          </>
        )}
      </p>

      {waitingShape !== undefined && (
        <div className="card">
          <strong>Why it is where it is:</strong>{' '}
          <span className="muted">{waitingShape}</span>
        </div>
      )}

      {d.failure !== undefined && (
        <div className="card">
          <strong className="error-text">Failure</strong>
          <pre className="block error-text">
            {d.failure}
            {d.failureStack !== undefined ? `\n\n${d.failureStack}` : ''}
          </pre>
        </div>
      )}
      {d.lastTaskFailure !== undefined && d.status === 'running' && (
        <div className="card">
          <strong className="error-text">Last workflow-task failure</strong>
          <pre className="block error-text">{d.lastTaskFailure}</pre>
        </div>
      )}
      {d.result !== undefined && (
        <div className="card">
          <strong>Result</strong>
          <pre className="block">{JSON.stringify(d.result, null, 2)}</pre>
        </div>
      )}

      {d.parked.length > 0 && (
        <>
          <div className="section-title">Parked conditions</div>
          <div className="card">
            {d.parked.map((p) => (
              <div key={p.seq}>
                <code>condition #{p.seq}</code>{' '}
                <span className="muted">
                  {p.site !== undefined
                    ? p.site.split('\n')[0]
                    : '(call site unknown)'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <PendingWork d={d} now={now} />

      {d.props !== undefined && d.props !== null && (
        <>
          <div className="section-title">Props</div>
          <div className="card">
            <pre className="block">{JSON.stringify(d.props, null, 2)}</pre>
          </div>
        </>
      )}

      {d.carryover !== undefined && Object.keys(d.carryover).length > 0 && (
        <>
          <div className="section-title">Carryover</div>
          <div className="card">
            <pre className="block">{JSON.stringify(d.carryover, null, 2)}</pre>
          </div>
        </>
      )}

      <div className="section-title">
        History{' '}
        <span className="muted" style={{textTransform: 'none'}}>
          {d.history.length === 0
            ? '(no events yet)'
            : `(events ${d.historyOffset + 1}–${d.historyOffset + d.history.length} of ${d.historyLength})`}
        </span>
      </div>
      <div className="card">
        {d.history.length === 0 ? (
          <p className="muted" style={{margin: 0}}>
            Nothing has been recorded — this execution has never successfully
            replayed a workflow task.
          </p>
        ) : (
          <div className="timeline">
            {d.history.map((ev, i) => (
              <Event key={d.historyOffset + i} ev={ev} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingWork({d, now}: {d: ExecutionDetail; now: number}) {
  const {activities, timers, children} = d.pending;
  if (activities.length + timers.length + children.length === 0) return null;
  return (
    <>
      <div className="section-title">Pending work</div>
      <div className="card">
        {activities.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>activity</th>
                <th>attempt</th>
                <th>next attempt</th>
                <th>checkpoint</th>
                <th>last error</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.seq}>
                  <td>
                    <code>{a.name}</code>
                  </td>
                  <td>
                    {a.attempt} of {a.maxAttempts}
                    {a.attempt > 1 && <span className="badge warn" style={{marginLeft: 6}}>retrying</span>}
                  </td>
                  <td className="muted">
                    {a.nextAttemptAt !== undefined
                      ? formatAge(a.nextAttemptAt, now)
                      : 'not between attempts'}
                  </td>
                  <td className="muted">
                    {a.checkpoint !== undefined
                      ? `${JSON.stringify(a.checkpoint)} (${formatAge(a.checkpointAt, now)})`
                      : '—'}
                  </td>
                  <td className="error-text">{a.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {timers.map((t) => (
          <div key={t.seq} className="muted">
            timer #{t.seq} fires {formatAge(t.fireAt, now)}
          </div>
        ))}
        {children.map((c) => (
          <div key={c.seq}>
            child{' '}
            <a
              className="id-link mono"
              href={`#/run/${encodeURIComponent(c.childId)}`}
            >
              {c.childId}
            </a>{' '}
            {c.detached && <span className="chip">detached</span>}
          </div>
        ))}
      </div>
    </>
  );
}

const EVENT_TONE: Record<string, string> = {
  activityCompleted: 'good',
  childCompleted: 'good',
  timerFired: 'good',
  activityFailed: 'bad',
  childFailed: 'bad',
  signal: 'info',
  activityStarted: 'info',
  activityRetryScheduled: 'bad',
  conditionParked: 'info',
  conditionUnparked: 'info',
};

function Event({ev, now}: {ev: HistoryEvent; now: number}) {
  const {type, ts, ...rest} = ev as HistoryEvent & Record<string, unknown>;
  const payload = JSON.stringify(rest);
  return (
    <div className={`event ${EVENT_TONE[type] ?? ''}`}>
      <div className="row">
        <code>{type}</code>
        <span className="muted">
          {ts !== undefined ? formatAge(ts as number, now) : ''}
        </span>
      </div>
      {payload !== '{}' && (
        <div className="payload mono">
          {payload.length > 300 ? `${payload.slice(0, 300)}…` : payload}
        </div>
      )}
    </div>
  );
}
