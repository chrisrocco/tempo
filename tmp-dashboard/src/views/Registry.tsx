/**
 * Main view: the workflow catalogue — `listWorkflows()`, which is what the live
 * fleet reports it can run. The `split-manifest` scenario is what makes the
 * `conflicting` badge appear on one row.
 */
import type {WorkflowSummary} from '../../../src/protocol';
import {usePoll} from '../rpc';

export function Registry() {
  const {data, error} = usePoll<WorkflowSummary[]>(() => ({
    method: 'listWorkflows',
  }));

  return (
    <div>
      <h2>Workflow registry</h2>
      <p className="view-sub">
        Every workflow the live fleet reports, deduped by name — what you could
        start right now, whether or not it has ever run.
      </p>
      {error !== undefined && <p className="error-text">{error}</p>}
      {data === undefined ? (
        <p className="muted">Loading…</p>
      ) : data.length === 0 ? (
        <p className="muted">No workers are reporting any workflows.</p>
      ) : (
        data.map((wf) => <WorkflowCard key={wf.name} wf={wf} />)
      )}
    </div>
  );
}

function WorkflowCard({wf}: {wf: WorkflowSummary}) {
  const props = wf.props?.properties ?? {};
  const required = new Set(wf.props?.required ?? []);
  const propNames = Object.keys(props);

  return (
    <div className="card">
      <div className="row">
        <h3>{wf.title}</h3>
        <code className="muted">{wf.name}</code>
        {wf.conflicting === true && (
          <span
            className="badge warn"
            title="Two workers describe this workflow differently — the fleet is running two versions of a binary."
          >
            conflicting reports
          </span>
        )}
        <span style={{marginLeft: 'auto'}} className="row">
          {wf.taskQueues.map((q) => (
            <span key={q} className="chip queue" title="served on this queue">
              {q}
            </span>
          ))}
        </span>
      </div>
      {wf.description !== undefined && <p className="desc">{wf.description}</p>}
      {propNames.length > 0 && (
        <table className="props-table">
          <thead>
            <tr>
              <th>prop</th>
              <th>type</th>
              <th>required</th>
              <th>description</th>
            </tr>
          </thead>
          <tbody>
            {propNames.map((name) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>
                  <code className="muted">{props[name].type ?? '—'}</code>
                </td>
                <td className="muted">{required.has(name) ? 'yes' : 'no'}</td>
                <td className="muted">{props[name].description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
