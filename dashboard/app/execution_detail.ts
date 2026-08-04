/**
 * @fileoverview
 * `<execution-detail>` — why is *this* execution doing that.
 *
 * Almost free, as the sprint predicted: `describeExecution` already returns
 * status, args, pending work, result, failure with its stack, carryover, and
 * the task-failure count with its reason. This view adds no API; it decides
 * what order those answers are wanted in.
 *
 * The order is the order of the questions. **Is it broken** (the failure, and
 * the replay failure that is not the same thing), then **what is it waiting
 * on**, then **what state is it carrying**, then the history. A reader who
 * opened this page because something is wrong should not have to scroll past
 * the arguments to find out what.
 *
 * ## Two different failures
 *
 * `failure` is the workflow raising — a normal, recorded outcome. `taskFailures`
 * with `lastTaskFailure` is the *engine* unable to replay it at all, on a retry
 * loop, still reporting `running`. They are rendered as separate panels because
 * conflating them sends the reader to the wrong code: one is a bug in the
 * workflow's logic, the other is usually a nondeterminism error from changing a
 * workflow that had live executions.
 *
 * ## History paging
 *
 * `fromEvent` is undefined until the reader asks for a page, which is what makes
 * the default *the most recent* events rather than the first — the end of a
 * history is where a diagnosis starts. Once they page, the choice sticks, so the
 * two-second poll does not yank them back to the end mid-read.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import {
  isQueueServed,
  isStuck,
  type ExecutionDetail as Detail,
  type QueueWorkers,
  type WorkerRole,
} from 'workflow-engine/protocol';
import {client} from './client.js';
import {Poller} from './poller.js';
import {executionsHref} from './routes.js';
import {
  absoluteTime,
  badge,
  controls,
  heading,
  panel,
  relativeTime,
  surface,
  table,
} from './theme.js';
import {formatDuration} from './history_view.js';
import './action_bar.js';
import './history_timeline.js';
import './json_view.js';
import './status_badge.js';

export class ExecutionDetailView extends LitElement {
  static override properties = {
    workflowId: {attribute: false},
    fromEvent: {state: true},
  };

  declare workflowId: string;
  /** Which history page to read; undefined means the most recent. */
  declare fromEvent: number | undefined;

  private readonly poller = new Poller<Detail | undefined>(this, (signal) =>
    client.describeExecution(
      this.workflowId,
      this.fromEvent === undefined ? {} : {fromEvent: this.fromEvent},
      signal,
    ),
  );

  /**
   * Queue liveness, polled separately from the execution.
   *
   * Its own poller because it is a different subject with a different lifetime:
   * paging the history replaces the detail request, and folding these into one
   * call would re-read the fleet every time someone turned a page — while
   * making the "waiting on" panel flicker whenever either half was in flight.
   */
  private readonly queues = new Poller<QueueWorkers[]>(this, (signal) =>
    client.listQueues(signal),
  );

  private polling = '';

  constructor() {
    super();
    this.workflowId = '';
    this.fromEvent = undefined;
  }

  override willUpdate(): void {
    const key = `${this.workflowId}@${this.fromEvent ?? 'end'}`;
    if (key === this.polling) return;
    // Paging within one execution should not blank the page; switching
    // executions should, because the old one's panels would otherwise sit there
    // labelled with the new id until the first response lands.
    const sameExecution = this.polling.startsWith(`${this.workflowId}@`);
    this.polling = key;
    const task = (signal: AbortSignal) =>
      client.describeExecution(
        this.workflowId,
        this.fromEvent === undefined ? {} : {fromEvent: this.fromEvent},
        signal,
      );
    if (sameExecution) this.poller.replaceTaskKeepingValue(task);
    else this.poller.replaceTask(task);
  }

  static override styles = [
    surface,
    heading,
    table,
    badge,
    panel,
    controls,
    css`
      :host {
        display: block;
      }
      .back {
        display: inline-block;
        font-size: 12.5px;
        margin-bottom: 14px;
      }
      .title {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin: 0 0 4px;
      }
      .id {
        font-family: var(--mono);
        font-size: 17px;
        font-weight: 600;
      }
      .meta {
        color: var(--muted);
        font-size: 12.5px;
        margin: 0 0 18px;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }
      .stuck-panel {
        border-color: var(--warn-bg);
      }
      .fail-panel {
        border-color: var(--danger-bg);
      }
      h2 .count {
        color: var(--dim);
        font-weight: 400;
      }
      pre.stack {
        margin: 8px 0 0;
        font-family: var(--mono);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--muted);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .failure-message {
        font-family: var(--mono);
        font-size: 12.5px;
        color: var(--danger);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .warn {
        color: var(--warn);
      }
      .pending td {
        border-bottom: none;
        padding: 4px 14px 4px 0;
      }
      .note {
        color: var(--muted);
        font-size: 12px;
        margin-top: 10px;
      }
      .unserved {
        background: var(--warn-bg);
        color: var(--warn);
        border-radius: 6px;
        padding: 8px 10px;
        margin: 0 0 12px;
        font-size: 12.5px;
        line-height: 1.5;
      }
      .unserved code {
        font-family: var(--mono);
      }
      .status {
        min-height: 18px;
        font-size: 12.5px;
        margin-bottom: 10px;
      }
    `,
  ];

  override render(): TemplateResult {
    const detail = this.poller.value;
    return html`
      <a class="back" href=${executionsHref()}>← all executions</a>
      <div class="status">
        ${
          this.poller.error
            ? html`<span class="error"
              >cannot reach the server — ${this.poller.error}</span
            >`
            : nothing
        }
      </div>
      ${
        detail === undefined
          ? html`<div class="muted">
            ${
              this.poller.pending && !this.poller.error
                ? 'loading…'
                : `No execution with id ${this.workflowId}.`
            }
          </div>`
          : this.detail(detail)
      }
    `;
  }

  private detail(detail: Detail): TemplateResult {
    return html`
      <div class="title">
        <span class="id">${detail.workflowId}</span>
        <status-badge .execution=${detail}></status-badge>
      </div>
      <div class="meta">
        <span>${detail.name}</span>
        <span>queue ${detail.taskQueue}</span>
        <span>run ${detail.runId}</span>
        <span title=${absoluteTime(detail.createdAt)}
          >created ${relativeTime(detail.createdAt)}</span
        >
        <span>${detail.historyLength} events</span>
        ${
          detail.cancelRequested
            ? html`<span class="warn">cancellation requested</span>`
            : nothing
        }
      </div>

      ${this.stuckPanel(detail)} ${this.failurePanel(detail)}
      ${this.resultPanel(detail)}

      <action-bar
        .execution=${detail}
        @acted=${() => this.poller.refresh()}
      ></action-bar>

      ${this.pendingPanel(detail)} ${this.carryoverPanel(detail)}

      <div class="panel">
        <h2>Arguments</h2>
        <json-view .value=${detail.args}></json-view>
      </div>

      <div class="panel">
        <history-timeline
          .history=${detail.history}
          .offset=${detail.historyOffset}
          .total=${detail.historyLength}
          @history-page=${(e: CustomEvent<{fromEvent: number}>) => {
            this.fromEvent = e.detail.fromEvent;
          }}
        ></history-timeline>
      </div>
    `;
  }

  /** The engine cannot replay it — distinct from the workflow having failed. */
  private stuckPanel(detail: Detail): TemplateResult | typeof nothing {
    if (!isStuck(detail)) return nothing;
    return html`
      <div class="panel stuck-panel">
        <h2>
          Cannot replay
          <span class="count">— ${detail.taskFailures} consecutive failures</span>
        </h2>
        <div class="failure-message warn">
          ${detail.lastTaskFailure ?? 'no reason recorded'}
        </div>
        <div class="note">
          The execution is still running and the engine is still retrying it on a
          backoff. A <code>nondeterminism at seq N</code> here means the workflow
          code no longer produces the commands its history records — usually an
          edit to a workflow that had live executions. Terminate is the only
          control that reaches an execution in this state.
        </div>
      </div>
    `;
  }

  /** The workflow itself raised. */
  private failurePanel(detail: Detail): TemplateResult | typeof nothing {
    if (detail.failure === undefined) return nothing;
    return html`
      <div class="panel fail-panel">
        <h2>Failure</h2>
        <div class="failure-message">${detail.failure}</div>
        ${
          detail.failureStack
            ? html`<pre class="stack">${detail.failureStack}</pre>`
            : nothing
        }
      </div>
    `;
  }

  private resultPanel(detail: Detail): TemplateResult | typeof nothing {
    if (detail.status !== 'completed') return nothing;
    return html`
      <div class="panel">
        <h2>Result</h2>
        <json-view .value=${detail.result}></json-view>
      </div>
    `;
  }

  /**
   * What the execution is parked on. Rendered for every running execution
   * including the empty case, because "running, waiting on nothing" is itself
   * the diagnosis — it means mid-task or wedged, and an absent panel would read
   * as an absent answer.
   */
  /**
   * Whether anything is polling this execution's queue for `role`.
   *
   * `undefined` while the fleet has not been read yet, which renders as nothing
   * rather than as a warning — an unanswered question must not look like a bad
   * answer, especially on first paint.
   */
  private served(detail: Detail, role: WorkerRole): boolean | undefined {
    const queues = this.queues.value;
    if (queues === undefined) return undefined;
    return isQueueServed(queues, detail.taskQueue, role, Date.now());
  }

  /**
   * The warning that turns "waiting" into a diagnosis.
   *
   * Worded as what was observed rather than what it implies. A sequential
   * worker inside a long activity stops polling and is indistinguishable from
   * an absent one (see `isQueueServed`), so this says nothing is asking for
   * work and names both explanations instead of picking one.
   */
  private unservedWarning(
    detail: Detail,
    role: WorkerRole,
  ): TemplateResult | typeof nothing {
    if (this.served(detail, role) !== false) return nothing;
    return html`<div class="unserved">
      Nothing is polling <code>${detail.taskQueue}</code> for ${role} work —
      either no ${role} worker is running, or every worker on this queue is
      busy. This execution cannot progress until one asks.
    </div>`;
  }

  private pendingPanel(detail: Detail): TemplateResult | typeof nothing {
    if (detail.status !== 'running') return nothing;
    const {activities, timers, children} = detail.pending;
    const empty =
      activities.length === 0 && timers.length === 0 && children.length === 0;
    const now = Date.now();
    return html`
      <div class="panel">
        <h2>Waiting on</h2>
        ${
          // A pending activity that nobody is polling for is the case this
          // whole registry exists to surface. The workflow-role warning goes on
          // the empty case instead: nothing dispatched and no workflow worker
          // means the execution has never been replayed at all.
          activities.length > 0
            ? this.unservedWarning(detail, 'activity')
            : nothing
        }
        ${empty ? this.unservedWarning(detail, 'workflow') : nothing}
        ${
          empty
            ? html`<div class="muted">
              Nothing dispatched. The execution is either mid-task or unable to
              make progress.
            </div>`
            : html`
              <table class="pending">
                <tbody>
                  ${activities.map(
                    (a) => html`
                      <tr>
                        <td class="mono">#${a.seq}</td>
                        <td>activity</td>
                        <td class="mono">${a.name}</td>
                        <td></td>
                      </tr>
                    `,
                  )}
                  ${timers.map(
                    (t) => html`
                      <tr>
                        <td class="mono">#${t.seq}</td>
                        <td>timer</td>
                        <td class="muted" title=${absoluteTime(t.fireAt)}>
                          ${
                            t.fireAt <= now
                              ? 'due'
                              : `fires in ${formatDuration(t.fireAt - now)}`
                          }
                        </td>
                        <td></td>
                      </tr>
                    `,
                  )}
                  ${children.map(
                    (c) => html`
                      <tr>
                        <td class="mono">#${c.seq}</td>
                        <td>${c.detached ? 'detached child' : 'child'}</td>
                        <td class="mono">
                          <a href="#/executions/${encodeURIComponent(c.childId)}"
                            >${c.childId}</a
                          >
                        </td>
                        <td></td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `
        }
      </div>
    `;
  }

  /**
   * The carryover, with the caveat that makes it readable.
   *
   * What is shown is the latest value the server has stored — written back on
   * every workflow task. What the *workflow* sees is the value its run started
   * with: `getCarryover` is per-run, not per-task, and a write takes effect at
   * the next continue-as-new. Anything else would break replay determinism.
   *
   * Without that note the panel actively misleads, because the common reason to
   * open it is "why did this item not get processed" — and the answer is
   * frequently that the value on screen is not the one the code read.
   */
  private carryoverPanel(detail: Detail): TemplateResult | typeof nothing {
    // Most executions never touch carryover, and the server sends `{}` rather
    // than omitting it — so testing for `undefined` alone put an empty panel,
    // and a paragraph of caveat about it, on every page.
    if (
      detail.carryover === undefined ||
      Object.keys(detail.carryover).length === 0
    )
      return nothing;
    return html`
      <div class="panel">
        <h2>Carryover</h2>
        <json-view .value=${detail.carryover}></json-view>
        <div class="note">
          The latest stored value. The running workflow reads what its
          <em>run</em> started with — a write lands at the next
          continue-as-new, not on the next task.
        </div>
      </div>
    `;
  }
}

customElements.define('execution-detail', ExecutionDetailView);
