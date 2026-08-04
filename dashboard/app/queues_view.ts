/**
 * @fileoverview
 * `<queues-view>` — which pools and which workflow types are in trouble.
 *
 * The last of the planned views (planning/sprints/06-dashboard.md). It answers
 * a question the executions list cannot: that list shows one page of individual
 * executions, and no amount of scrolling turns that into "the `email` queue has
 * forty failures and nothing polling it".
 *
 * ## Two sources, joined here
 *
 * Counts come from `groupExecutions` and liveness from `listQueues`, and the
 * queue table is the **union** of both — because each answers half of it. A
 * queue with workers and no executions is an idle pool, which is fine and worth
 * seeing. A queue with executions and no workers is the one worth waking
 * someone for, and listing only what has been polled would hide exactly that.
 *
 * Both are read by the same poller pair the rest of the app uses, so this view
 * inherits the backoff, the hidden-tab pause, and the abort-on-disconnect
 * without restating any of it.
 *
 * ## Rows are links, because a count is not an answer
 *
 * Every row navigates to the executions list filtered to it. "Six stuck on
 * `email`" is where the question starts, not where it ends, and the filter is
 * already expressible as a URL (see `routes.ts`) — so the count and the list of
 * what it counted are one click apart.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import {
  ANY_TASK_QUEUE,
  isQueueServed,
  type ExecutionGroup,
  type ExecutionGroups,
  type QueueWorkers,
  type WorkerRole,
} from 'workflow-engine/protocol';
import {client} from './client.js';
import {Poller} from './poller.js';
import {executionsHref} from './routes.js';
import {badge, heading, panel, surface, table} from './theme.js';

export class QueuesView extends LitElement {
  private readonly groups = new Poller<ExecutionGroups>(this, (signal) =>
    client.groupExecutions(signal),
  );

  private readonly queues = new Poller<QueueWorkers[]>(this, (signal) =>
    client.listQueues(signal),
  );

  static override styles = [
    surface,
    heading,
    table,
    badge,
    panel,
    css`
      :host {
        display: block;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      th.num {
        text-align: right;
      }
      .zero {
        color: var(--dim);
      }
      .bad {
        color: var(--danger);
        font-weight: 600;
      }
      .wedged {
        color: var(--warn);
        font-weight: 600;
      }
      .roles {
        display: flex;
        gap: 6px;
      }
      .live {
        background: var(--ok-bg);
        color: var(--ok);
      }
      .absent {
        background: var(--warn-bg);
        color: var(--warn);
      }
      .unknown {
        background: var(--neutral-bg);
        color: var(--neutral);
      }
      .rows tr:hover td {
        background: var(--panel);
      }
      .status {
        min-height: 18px;
        margin: 0 0 10px;
        font-size: 12.5px;
      }
      .footnote {
        color: var(--muted);
        font-size: 12px;
        margin-top: 12px;
      }
      code {
        font-family: var(--mono);
      }
    `,
  ];

  /**
   * A role's liveness pill.
   *
   * Three states, not two. Before the fleet has been read the honest answer is
   * "unknown", and rendering that as "absent" would raise an alarm on every
   * first paint.
   */
  private rolePill(taskQueue: string, role: WorkerRole): TemplateResult {
    const queues = this.queues.value;
    const label = role === 'workflow' ? 'wf' : 'act';
    if (queues === undefined)
      return html`<span class="badge unknown">${label} ?</span>`;
    const served = isQueueServed(queues, taskQueue, role, Date.now());
    return html`<span class="badge ${served ? 'live' : 'absent'}"
      title=${
        served
          ? `something is polling ${taskQueue} for ${role} work`
          : `nothing is polling ${taskQueue} for ${role} work — no worker, or all of them busy`
      }
      >${label} ${served ? 'live' : 'none'}</span
    >`;
  }

  /** A count, dimmed at zero so the non-zero ones are what the eye lands on. */
  private count(value: number, tone?: 'bad' | 'wedged'): TemplateResult {
    if (value === 0) return html`<span class="zero">0</span>`;
    return html`<span class=${tone ?? ''}>${value}</span>`;
  }

  override render(): TemplateResult {
    const error = this.groups.error ?? this.queues.error;
    return html`
      <h1>Queues &amp; types</h1>
      <div class="status">
        ${
          error
            ? html`<span class="error">cannot reach the server — ${error}</span>`
            : nothing
        }
      </div>
      ${this.queueTable()} ${this.nameTable()}
    `;
  }

  private queueTable(): TemplateResult {
    const groups = this.groups.value;
    const queues = this.queues.value;
    if (groups === undefined && queues === undefined)
      return html`<div class="muted">loading…</div>`;

    const counts = new Map(
      (groups?.byTaskQueue ?? []).map((g) => [g.key, g] as const),
    );
    // The union: a polled queue with no executions, and an executing queue with
    // no poller, are both worth a row — see the fileoverview.
    const names = [
      ...new Set([
        ...(groups?.byTaskQueue ?? []).map((g) => g.key),
        ...(queues ?? []).map((q) => q.taskQueue),
      ]),
    ];
    if (names.length === 0)
      return html`<div class="muted">
        Nothing has run, and no worker has polled this server.
      </div>`;

    // Trouble first, matching the server's own ordering for the groups it knows
    // about; queues with no executions have nothing to sort on and fall to the
    // end alphabetically.
    names.sort((a, b) => {
      const ga = counts.get(a);
      const gb = counts.get(b);
      return (
        (gb?.stuck ?? 0) - (ga?.stuck ?? 0) ||
        (gb?.failed ?? 0) - (ga?.failed ?? 0) ||
        (gb?.running ?? 0) - (ga?.running ?? 0) ||
        (a < b ? -1 : a > b ? 1 : 0)
      );
    });

    return html`
      <div class="panel">
        <h2>By task queue</h2>
        <table>
          <thead>
            <tr>
              <th>Queue</th>
              <th>Workers</th>
              <th class="num">Running</th>
              <th class="num">Stuck</th>
              <th class="num">Failed</th>
              <th class="num">Completed</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody class="rows">
            ${names.map((name) => this.queueRow(name, counts.get(name)))}
          </tbody>
        </table>
        ${
          names.includes(ANY_TASK_QUEUE)
            ? html`<div class="footnote">
              <code>${ANY_TASK_QUEUE}</code> is a worker polling every queue —
              the in-process runtime does this, so it serves every row above.
            </div>`
            : nothing
        }
      </div>
    `;
  }

  private queueRow(
    name: string,
    group: ExecutionGroup | undefined,
  ): TemplateResult {
    return html`
      <tr>
        <td class="mono">
          <a href=${executionsHref({taskQueue: name})}>${name}</a>
        </td>
        <td>
          <div class="roles">
            ${this.rolePill(name, 'workflow')}${this.rolePill(name, 'activity')}
          </div>
        </td>
        <td class="num">${this.count(group?.running ?? 0)}</td>
        <td class="num">${this.count(group?.stuck ?? 0, 'wedged')}</td>
        <td class="num">${this.count(group?.failed ?? 0, 'bad')}</td>
        <td class="num">${this.count(group?.completed ?? 0)}</td>
        <td class="num">${group?.total ?? 0}</td>
      </tr>
    `;
  }

  private nameTable(): TemplateResult | typeof nothing {
    const groups = this.groups.value;
    if (groups === undefined || groups.byName.length === 0) return nothing;
    return html`
      <div class="panel">
        <h2>By workflow type</h2>
        <table>
          <thead>
            <tr>
              <th>Workflow</th>
              <th class="num">Running</th>
              <th class="num">Stuck</th>
              <th class="num">Failed</th>
              <th class="num">Completed</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody class="rows">
            ${groups.byName.map(
              (g) => html`
                <tr>
                  <td><a href=${executionsHref({name: g.key})}>${g.key}</a></td>
                  <td class="num">${this.count(g.running)}</td>
                  <td class="num">${this.count(g.stuck, 'wedged')}</td>
                  <td class="num">${this.count(g.failed, 'bad')}</td>
                  <td class="num">${this.count(g.completed)}</td>
                  <td class="num">${g.total}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}

customElements.define('queues-view', QueuesView);
