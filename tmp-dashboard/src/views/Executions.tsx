/**
 * Executions view: one page of `listExecutions()`, with `groupExecutions()` for
 * the counts a paged listing structurally cannot answer. Stuck-ness comes from
 * the engine's own `isStuck`, so this view and the server cannot disagree.
 */
import type {
  ExecutionGroups,
  ExecutionPage,
  ExecutionSummary,
} from '../../../src/protocol';
import {isStuck} from '../../../src/protocol';
import {usePoll, formatAge} from '../rpc';

export function Executions() {
  const {data: page, error} = usePoll<ExecutionPage>(() => ({
    method: 'listExecutions',
  }));
  const {data: groups} = usePoll<ExecutionGroups>(() => ({
    method: 'groupExecutions',
  }));
  const now = Date.now();

  const totals = groups?.byName.reduce(
    (acc, g) => ({
      total: acc.total + g.total,
      running: acc.running + g.running,
      completed: acc.completed + g.completed,
      failed: acc.failed + g.failed,
      terminated: acc.terminated + g.terminated,
      stuck: acc.stuck + g.stuck,
    }),
    {total: 0, running: 0, completed: 0, failed: 0, terminated: 0, stuck: 0},
  );

  return (
    <div>
      <h2>Executions</h2>
      <p className="view-sub">
        Newest first. A running execution that is failing its tasks is wedged —
        that is the <code>stuck</code> count, and it hides inside{' '}
        <code>running</code> everywhere a listing does not surface it.
      </p>
      {error !== undefined && <p className="error-text">{error}</p>}

      {totals !== undefined && (
        <div className="stat-row">
          <Stat n={totals.total} l="total" />
          <Stat n={totals.running} l="running" />
          <Stat n={totals.stuck} l="stuck" warn={totals.stuck > 0} />
          <Stat n={totals.completed} l="completed" />
          <Stat n={totals.failed} l="failed" warn={totals.failed > 0} />
          <Stat n={totals.terminated} l="terminated" />
        </div>
      )}

      {page === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>workflow id</th>
                <th>workflow</th>
                <th>status</th>
                <th>queue</th>
                <th>age</th>
                <th>history</th>
                <th>last task failure</th>
              </tr>
            </thead>
            <tbody>
              {page.executions.map((e) => (
                <ExecutionRow key={e.workflowId} e={e} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {groups !== undefined && groups.retryingActivities.length > 0 && (
        <>
          <div className="section-title">Activities between attempts</div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>activity</th>
                  <th>retrying</th>
                  <th>failed attempts</th>
                  <th>next attempt</th>
                  <th>last error</th>
                </tr>
              </thead>
              <tbody>
                {groups.retryingActivities.map((g) => (
                  <tr key={g.name}>
                    <td>
                      <code>{g.name}</code>
                    </td>
                    <td>{g.retrying}</td>
                    <td>{g.attempts}</td>
                    <td className="muted">{formatAge(g.nextAttemptAt, now)}</td>
                    <td className="error-text">{g.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({n, l, warn = false}: {n: number; l: string; warn?: boolean}) {
  return (
    <div className="stat">
      <div className="n" style={warn && n > 0 ? {color: 'var(--warn)'} : {}}>
        {n}
      </div>
      <div className="l">{l}</div>
    </div>
  );
}

function ExecutionRow({e, now}: {e: ExecutionSummary; now: number}) {
  return (
    <tr
      className="clickable"
      onClick={() => {
        window.location.hash = `#/run/${encodeURIComponent(e.workflowId)}`;
      }}
    >
      <td>
        <a
          className="id-link mono"
          href={`#/run/${encodeURIComponent(e.workflowId)}`}
        >
          {e.workflowId}
        </a>
      </td>
      <td className="muted">{e.name}</td>
      <td>
        <span className={`badge ${e.status}`}>{e.status}</span>{' '}
        {isStuck(e) && (
          <span
            className="badge warn"
            title={`${e.taskFailures} consecutive workflow-task failures — the engine cannot replay this execution.`}
          >
            stuck ×{e.taskFailures}
          </span>
        )}
      </td>
      <td>
        <span className="chip queue">{e.taskQueue}</span>
      </td>
      <td className="muted">{formatAge(e.createdAt, now)}</td>
      <td className="muted">{e.historyLength}</td>
      <td className="error-text">{e.lastTaskFailure ?? ''}</td>
    </tr>
  );
}
