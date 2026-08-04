/**
 * @fileoverview
 * `<execution-list>` — the home view: what is running, and what is broken.
 *
 * The filter bar writes to the URL rather than to local state (see
 * `router.ts`), so this component has no filter of its own: it renders the one
 * it is given and navigates when the user changes it. That is what makes the
 * filtered view linkable, and it also means the back button does what a back
 * button should.
 *
 * **Text fields commit on `change`, not on `input`.** Navigating per keystroke
 * would push a history entry per character and fire a request per character.
 * `change` fires on blur or Enter, which is the granularity a filter actually
 * has.
 *
 * ## Paging against a moving list
 *
 * The listing is newest-first and the underlying set changes while it is being
 * read, so "page 2" is not a stable thing. `cursors` is the stack of cursors
 * that led to the current page: pushing on next and popping on previous means
 * *back* always returns to a page that was really visited, rather than being
 * recomputed from an offset that has since shifted.
 *
 * Paging state resets whenever the filter changes, because a cursor from one
 * filter means nothing under another.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {ExecutionPage, ExecutionSummary} from '../src/protocol/service';
import {client} from './client.js';
import {Poller} from './poller.js';
import {navigate} from './router.js';
import {executionHref, executionsHref, type RouteFilter} from './routes.js';
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
import './status_badge.js';

/** How many rows a page shows. Well under `MAX_PAGE_SIZE`. */
const PAGE_SIZE = 50;

export class ExecutionList extends LitElement {
  static override properties = {
    filter: {attribute: false},
    cursors: {state: true},
  };

  declare filter: RouteFilter;
  /** The cursors of the pages behind this one; empty means the first page. */
  declare cursors: string[];

  private readonly poller = new Poller<ExecutionPage>(this, (signal) =>
    client.listExecutions(
      {...this.filter, limit: PAGE_SIZE, cursor: this.cursors.at(-1)},
      signal,
    ),
  );

  /** What the poller was last reading, so a change can be detected. */
  private polling = '';

  constructor() {
    super();
    this.filter = {};
    this.cursors = [];
  }

  /**
   * Restart the poll when what it should be reading changes.
   *
   * The task closes over `this`, so it always reads the current filter — but it
   * would not do so until the *next* tick, leaving up to a poll interval of
   * visibly wrong data after a filter change. Comparing a serialization of the
   * inputs is what makes the change immediate.
   */
  override willUpdate(): void {
    const key = JSON.stringify([this.filter, this.cursors.at(-1)]);
    if (key === this.polling) return;
    this.polling = key;
    this.poller.replaceTask((signal) =>
      client.listExecutions(
        {...this.filter, limit: PAGE_SIZE, cursor: this.cursors.at(-1)},
        signal,
      ),
    );
  }

  /** Any filter change starts again at the first page. */
  private applyFilter(patch: Partial<RouteFilter>): void {
    const next: RouteFilter = {...this.filter, ...patch};
    for (const [k, v] of Object.entries(next))
      if (v === '' || v === false || v === undefined)
        delete next[k as keyof RouteFilter];
    this.cursors = [];
    navigate(executionsHref(next));
  }

  static override styles = [
    surface,
    heading,
    table,
    badge,
    controls,
    panel,
    css`
      :host {
        display: block;
      }
      .bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 0 0 16px;
      }
      .bar input {
        width: 150px;
      }
      .check {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
        cursor: pointer;
        user-select: none;
      }
      .check input {
        width: auto;
        accent-color: var(--warn);
      }
      .clear {
        color: var(--muted);
      }
      .rows tr:hover td {
        background: var(--panel);
      }
      .reason {
        color: var(--muted);
        font-size: 12px;
        max-width: 380px;
      }
      .age {
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .queue {
        color: var(--muted);
        font-size: 12px;
      }
      .paging {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 16px;
        font-size: 12.5px;
        color: var(--muted);
      }
      .status {
        min-height: 18px;
        margin: 0 0 10px;
        font-size: 12.5px;
      }
    `,
  ];

  private filterBar(): TemplateResult {
    const filter = this.filter;
    const active = Object.keys(filter).length > 0;
    return html`
      <div class="bar">
        <input
          placeholder="id prefix"
          .value=${filter.workflowIdPrefix ?? ''}
          @change=${(e: Event) =>
            this.applyFilter({
              workflowIdPrefix: (e.target as HTMLInputElement).value.trim(),
            })}
        />
        <input
          placeholder="workflow name"
          .value=${filter.name ?? ''}
          @change=${(e: Event) =>
            this.applyFilter({
              name: (e.target as HTMLInputElement).value.trim(),
            })}
        />
        <input
          placeholder="task queue"
          .value=${filter.taskQueue ?? ''}
          @change=${(e: Event) =>
            this.applyFilter({
              taskQueue: (e.target as HTMLInputElement).value.trim(),
            })}
        />
        <select
          .value=${filter.status ?? ''}
          @change=${(e: Event) =>
            this.applyFilter({
              status: ((e.target as HTMLSelectElement).value ||
                undefined) as RouteFilter['status'],
            })}
        >
          <option value="">any status</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="terminated">terminated</option>
        </select>
        <label class="check">
          <input
            type="checkbox"
            .checked=${filter.stuck === true}
            @change=${(e: Event) =>
              this.applyFilter({
                stuck: (e.target as HTMLInputElement).checked,
              })}
          />
          stuck only
        </label>
        ${
          active
            ? html`<button
              class="clear"
              @click=${() => {
                this.cursors = [];
                navigate(executionsHref({}));
              }}
            >
              clear
            </button>`
            : nothing
        }
      </div>
    `;
  }

  private row(execution: ExecutionSummary): TemplateResult {
    return html`
      <tr>
        <td class="mono">
          <a href=${executionHref(execution.workflowId)}
            >${execution.workflowId}</a
          >
        </td>
        <td>${execution.name}</td>
        <td><status-badge .execution=${execution}></status-badge></td>
        <td class="queue">${execution.taskQueue}</td>
        <td class="age" title=${absoluteTime(execution.createdAt)}>
          ${relativeTime(execution.createdAt)}
        </td>
        <td>${execution.historyLength}</td>
        <td class="reason">${execution.lastTaskFailure ?? ''}</td>
      </tr>
    `;
  }

  override render(): TemplateResult {
    const page = this.poller.value;
    const executions = page?.executions ?? [];
    return html`
      <h1>Executions</h1>
      ${this.filterBar()}
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
        page === undefined
          ? html`<div class="muted">loading…</div>`
          : executions.length === 0
            ? html`<div class="muted">
              ${
                Object.keys(this.filter).length > 0
                  ? 'No executions match this filter.'
                  : 'Nothing has run yet.'
              }
            </div>`
            : html`
              <table>
                <thead>
                  <tr>
                    <th>Workflow ID</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Queue</th>
                    <th>Created</th>
                    <th>Events</th>
                    <th>Last task failure</th>
                  </tr>
                </thead>
                <tbody class="rows">
                  ${executions.map((execution) => this.row(execution))}
                </tbody>
              </table>
            `
      }
      ${this.paging(page)}
    `;
  }

  private paging(
    page: ExecutionPage | undefined,
  ): TemplateResult | typeof nothing {
    if (!page) return nothing;
    const hasPrevious = this.cursors.length > 0;
    const hasNext = page.nextCursor !== undefined;
    if (!hasPrevious && !hasNext) return nothing;
    return html`
      <div class="paging">
        <button
          ?disabled=${!hasPrevious}
          @click=${() => {
            this.cursors = this.cursors.slice(0, -1);
          }}
        >
          ← previous
        </button>
        <button
          ?disabled=${!hasNext}
          @click=${() => {
            this.cursors = [...this.cursors, page.nextCursor!];
          }}
        >
          next →
        </button>
        <span>page ${this.cursors.length + 1}</span>
      </div>
    `;
  }
}

customElements.define('execution-list', ExecutionList);
