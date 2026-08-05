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
 *
 * ## Selection is per page, and stays out of the URL
 *
 * A batch acts on rows that are on screen, never on "everything matching this
 * filter". The page is capped at fifty, which bounds the blast radius of an
 * irreversible action to something the operator can see — and friction
 * proportional to that radius is the right trade here. Someone who means to
 * terminate two hundred can page, and will have looked at them.
 *
 * The selection clears whenever the filter or the page changes, so it always
 * refers to rows that are actually rendered. And unlike the filter it is
 * deliberately *not* a route: a link that arrives with rows pre-selected for
 * termination is a hazard, not a convenience.
 *
 * Only running executions can be selected. Signalling or cancelling a settled
 * execution is a no-op the operator would be entitled to read as success, which
 * is the same reason `action_bar.ts` disables its buttons.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {ExecutionPage, ExecutionSummary} from 'workflow-engine/protocol';
import {failuresOf, runBatch, type BatchOutcome} from './batch.js';
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
import './counts_strip.js';
import './start_form.js';
import './status_badge.js';

/** How many rows a page shows. Well under `MAX_PAGE_SIZE`. */
const PAGE_SIZE = 50;

export class ExecutionList extends LitElement {
  static override properties = {
    filter: {attribute: false},
    cursors: {state: true},
    selected: {state: true},
    batching: {state: true},
    batchNote: {state: true},
    batchFailures: {state: true},
    terminateReason: {state: true},
  };

  declare filter: RouteFilter;
  /** The cursors of the pages behind this one; empty means the first page. */
  declare cursors: string[];
  /** Workflow ids ticked on the current page. Never survives a page change. */
  declare selected: ReadonlySet<string>;
  declare batching: boolean;
  /** Progress or result of the last batch, as one line. */
  declare batchNote: string | undefined;
  /** The executions a batch could not act on, which is the part worth keeping. */
  declare batchFailures: BatchOutcome[];
  declare terminateReason: string;

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
    this.selected = new Set();
    this.batching = false;
    this.batchNote = undefined;
    this.batchFailures = [];
    this.terminateReason = '';
  }

  /** Forget a selection that no longer refers to what is on screen. */
  private clearSelection(): void {
    this.selected = new Set();
    this.batchNote = undefined;
    this.batchFailures = [];
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
    this.clearSelection();
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
      .pick {
        width: 26px;
      }
      .pick input {
        accent-color: var(--accent);
      }
      .batch {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 0 0 12px;
        font-size: 12.5px;
      }
      .batch .count {
        color: var(--text);
        font-weight: 600;
      }
      /* Not .reason — that is the failure cell in the table, and an input would
         inherit its muted 12px treatment. */
      .batch .reason-input {
        width: 220px;
      }
      .batch .note {
        color: var(--muted);
      }
      .failures {
        margin: 0 0 14px;
        padding-left: 18px;
        font-size: 12px;
        color: var(--danger);
      }
      .failures .mono {
        font-family: var(--mono);
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

  /**
   * The tick box, on running executions only.
   *
   * Settled rows render an empty cell rather than a disabled control: there is
   * nothing to explain and a row of greyed boxes reads as broken. The column
   * header's select-all covers "every running execution on this page", which is
   * the same set.
   */
  private selectBox(
    execution: ExecutionSummary,
  ): TemplateResult | typeof nothing {
    if (execution.status !== 'running') return nothing;
    return html`<input
      type="checkbox"
      aria-label="select ${execution.workflowId}"
      .checked=${this.selected.has(execution.workflowId)}
      @change=${(e: Event) => {
        const next = new Set(this.selected);
        if ((e.target as HTMLInputElement).checked)
          next.add(execution.workflowId);
        else next.delete(execution.workflowId);
        this.selected = next;
      }}
    />`;
  }

  private row(execution: ExecutionSummary): TemplateResult {
    return html`
      <tr>
        <td class="pick">${this.selectBox(execution)}</td>
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
      <counts-strip></counts-strip>
      <start-form></start-form>
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
              ${this.batchBar(executions)}
              <table>
                <thead>
                  <tr>
                    <th class="pick">${this.selectAllBox(executions)}</th>
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

  /** Every running execution on this page — the set select-all covers. */
  private selectableOf(executions: ExecutionSummary[]): string[] {
    return executions
      .filter((e) => e.status === 'running')
      .map((e) => e.workflowId);
  }

  private selectAllBox(
    executions: ExecutionSummary[],
  ): TemplateResult | typeof nothing {
    const selectable = this.selectableOf(executions);
    if (selectable.length === 0) return nothing;
    const all = selectable.every((id) => this.selected.has(id));
    return html`<input
      type="checkbox"
      aria-label="select every running execution on this page"
      .checked=${all}
      @change=${() => {
        this.selected = all ? new Set() : new Set(selectable);
      }}
    />`;
  }

  /**
   * The bar that appears once something is ticked.
   *
   * Cancel goes straight through; terminate takes a reason first, the same gate
   * `action_bar.ts` puts on a single one — except the count is in the button, so
   * the thing being confirmed is *how many* as much as what.
   */
  private batchBar(
    executions: ExecutionSummary[],
  ): TemplateResult | typeof nothing {
    const ids = this.selectableOf(executions).filter((id) =>
      this.selected.has(id),
    );
    if (ids.length === 0 && this.batchNote === undefined) return nothing;
    return html`
      <div class="batch">
        ${
          ids.length === 0
            ? nothing
            : html`
              <span class="count">${ids.length} selected</span>
              <button
                ?disabled=${this.batching}
                @click=${() =>
                  void this.runOver(ids, 'cancel', (id) => client.cancel(id))}
              >
                cancel
              </button>
              <input
                class="reason-input"
                placeholder="reason, to terminate"
                .value=${this.terminateReason}
                @input=${(e: Event) => {
                  this.terminateReason = (e.target as HTMLInputElement).value;
                }}
              />
              <button
                class="danger"
                ?disabled=${this.batching || this.terminateReason.trim() === ''}
                @click=${() =>
                  void this.runOver(ids, 'terminate', (id) =>
                    client.terminate(id, this.terminateReason.trim()),
                  )}
              >
                terminate ${ids.length}
              </button>
            `
        }
        ${
          this.batchNote === undefined
            ? nothing
            : html`<span class="note">${this.batchNote}</span>`
        }
      </div>
      ${
        this.batchFailures.length === 0
          ? nothing
          : html`<ul class="failures">
            ${this.batchFailures.map(
              (f) => html`<li><span class="mono">${f.workflowId}</span> —
                ${f.error}</li>`,
            )}
          </ul>`
      }
    `;
  }

  /**
   * Run one action across the selection, then re-read the page.
   *
   * The failures survive the refresh and the successes do not, which is the
   * asymmetry that matters: the rows that worked are visible in the listing
   * underneath, and the ones that did not are the only thing the operator has to
   * carry forward.
   */
  private async runOver(
    ids: string[],
    verb: string,
    action: (workflowId: string) => Promise<unknown>,
  ): Promise<void> {
    this.batching = true;
    this.batchFailures = [];
    this.batchNote = `${verb}: 0 of ${ids.length}`;
    const outcomes = await runBatch(ids, action, (progress) => {
      this.batchNote = `${verb}: ${progress.done} of ${progress.total}`;
    });
    const failures = failuresOf(outcomes);
    this.batchFailures = failures;
    this.batchNote =
      failures.length === 0
        ? `${verb}: all ${outcomes.length} done`
        : `${verb}: ${outcomes.length - failures.length} of ${outcomes.length} done, ${failures.length} could not be reached`;
    this.selected = new Set();
    this.terminateReason = '';
    this.batching = false;
    this.poller.refresh();
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
            this.clearSelection();
          }}
        >
          ← previous
        </button>
        <button
          ?disabled=${!hasNext}
          @click=${() => {
            this.cursors = [...this.cursors, page.nextCursor!];
            this.clearSelection();
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
