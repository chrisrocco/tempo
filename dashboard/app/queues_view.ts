/**
 * @fileoverview
 * `<queues-view>` — which pools and which workflow types are in trouble.
 *
 * The last of the planned views. It answers
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
 *
 * The retry table is the exception: there is no execution filter for "running
 * an activity called `charge`", so its rows are not links. Inventing one would
 * mean an `ExecutionFilter` field the server would have to derive from history
 * on every poll, which is the cost `ActivityRetryGroup` exists to avoid.
 *
 * ## The third table is a live view, and says so
 *
 * "Activities retrying right now" is worded that way because the natural
 * reading of an activity table is cumulative, and this one is not: it counts
 * what is between attempts at this instant, and an activity that recovers
 * leaves it. `ActivityRetryGroup` explains why the cumulative version is not
 * derivable at all rather than merely absent — history records an activity's
 * final outcome, never its attempts.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import {
  ANY_TASK_QUEUE,
  isQueueServed,
  workersServing,
  type ExecutionGroup,
  type ExecutionGroups,
  type QueueWorkers,
  type WorkerInfo,
  type WorkerRole,
} from 'workflow-engine/protocol';
import {client} from './client.js';
import {Poller} from './poller.js';
import {executionsHref} from './routes.js';
import {formatDuration} from './history_view.js';
import {
  absoluteTime,
  badge,
  heading,
  panel,
  relativeTime,
  surface,
  table,
} from './theme.js';

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
      /* Matches the listing's treatment of the same two kinds of cell, so a
         failure message reads the same wherever it is shown. */
      .when {
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .reason {
        color: var(--muted);
        font-size: 12px;
        max-width: 380px;
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
   * A role's liveness pill: whether a pool is served, and by how many.
   *
   * Three states, not two. Before the fleet has been read the honest answer is
   * "unknown", and rendering that as "absent" would raise an alarm on every
   * first paint.
   *
   * The pill used to hedge — "no worker, or all of them busy" — because a poll
   * record could not tell those apart. It can now: a worker holding a lease is
   * reported busy and counts as serving, so "none" means none, and a saturated
   * pool reads as `act 2/2 busy` rather than as an absent one.
   *
   * The count is omitted when no worker has identified itself, which is what a
   * client polling without an identity looks like. Rendering "0" there would
   * claim the pool is empty on the strength of something that never said.
   */
  private rolePill(taskQueue: string, role: WorkerRole): TemplateResult {
    const queues = this.queues.value;
    const label = role === 'workflow' ? 'wf' : 'act';
    if (queues === undefined)
      return html`<span class="badge unknown">${label} ?</span>`;
    const served = isQueueServed(queues, taskQueue, role, Date.now());
    const workers = workersServing(queues, taskQueue, role);
    const busy = workers.filter((w) => w.busy).length;
    const text = !served
      ? 'none'
      : workers.length === 0
        ? 'live'
        : busy === 0
          ? `${workers.length}`
          : `${busy}/${workers.length} busy`;
    return html`<span
      class="badge ${served ? 'live' : 'absent'}"
      title=${this.pillTitle(taskQueue, role, served, workers)}
      >${label} ${text}</span
    >`;
  }

  /** The pill's tooltip: who, and when each was last heard from. */
  private pillTitle(
    taskQueue: string,
    role: WorkerRole,
    served: boolean,
    workers: WorkerInfo[],
  ): string {
    if (workers.length === 0)
      return served
        ? `something is polling ${taskQueue} for ${role} work, without identifying itself`
        : `nothing has polled ${taskQueue} for ${role} work recently`;
    const now = Date.now();
    return workers
      .map(
        (w) =>
          `${w.identity} — ${w.busy ? 'busy' : `idle, last polled ${relativeTime(w.lastPolledAt, now)}`}`,
      )
      .join('\n');
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
      ${this.queueTable()} ${this.nameTable()} ${this.retryTable()}
    `;
  }

  /**
   * What is between retry attempts, by activity.
   *
   * Absent rather than empty when nothing is retrying — unlike the two tables
   * above, whose emptiness is a fact worth stating ("no queues"), an empty
   * retry table says only that things are fine, and a permanent empty panel on
   * a healthy server trains the eye to skip the place trouble will appear.
   *
   * The heading says "right now" because this is a live view and the reader's
   * default assumption would be cumulative — see `ActivityRetryGroup`, which
   * explains why the historical version is not derivable at all.
   */
  private retryTable(): TemplateResult | typeof nothing {
    const groups = this.groups.value;
    if (groups === undefined || groups.retryingActivities.length === 0)
      return nothing;
    // `nextAttemptAt` is in the *future*, which `relativeTime` cannot express —
    // it clamps at zero and renders a pending retry as "0s ago". Same countdown
    // idiom the detail view's retry panel uses, for the same field.
    const now = Date.now();
    return html`
      <div class="panel">
        <h2>Activities retrying right now</h2>
        <table>
          <thead>
            <tr>
              <th>Activity</th>
              <th class="num">Retrying</th>
              <th class="num">Attempts</th>
              <th>Next attempt</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody class="rows">
            ${groups.retryingActivities.map(
              (g) => html`
                <tr>
                  <td>${g.name}</td>
                  <td class="num">${this.count(g.retrying, 'wedged')}</td>
                  <td class="num">${this.count(g.attempts, 'wedged')}</td>
                  <td class="when" title=${absoluteTime(g.nextAttemptAt)}>
                    ${
                      g.nextAttemptAt === undefined
                        ? '—'
                        : g.nextAttemptAt <= now
                          ? 'now'
                          : `in ${formatDuration(g.nextAttemptAt - now)}`
                    }
                  </td>
                  <td class="reason">${g.lastError ?? ''}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
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
