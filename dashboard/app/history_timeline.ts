/**
 * @fileoverview
 * `<history-timeline>` — an execution's history as an ordered, timed table.
 *
 * This is the view the `ts` field was added for. Without timestamps a history
 * is a list of things that happened in some order; with them it answers the
 * questions an operator actually arrives with — when did it start, what has it
 * been doing for the last ten minutes, which activity is slow.
 *
 * Layout only. How an event *reads*, and how a duration is derived from a
 * dispatch/completion pair, live in `history_view.ts`.
 *
 * ## Paging
 *
 * `describeExecution` returns at most `MAX_HISTORY_PAGE` events and, given no
 * `fromEvent`, returns the *last* page — the right default, since the end of a
 * history is where the answer usually is. This component renders one page and
 * emits `history-page` for the one it wants; `execution_detail.ts` owns the
 * request, because it owns the poller that would otherwise fight with it.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {HistoryEvent} from 'workflow-engine/protocol';
import {
  describeEvent,
  durationOf,
  formatDuration,
  markerTimes,
} from './history_view.js';
import {executionHref} from './routes.js';
import {
  absoluteTime,
  heading,
  panel,
  relativeTime,
  surface,
  table,
} from './theme.js';
import './json_view.js';

export class HistoryTimeline extends LitElement {
  static override properties = {
    history: {attribute: false},
    offset: {attribute: false},
    total: {attribute: false},
  };

  declare history: HistoryEvent[];
  /** Index of the first event shown, within the whole history. */
  declare offset: number;
  /** The execution's total history length, for the paging controls. */
  declare total: number;

  constructor() {
    super();
    this.history = [];
    this.offset = 0;
    this.total = 0;
  }

  static override styles = [
    surface,
    heading,
    table,
    panel,
    css`
      .seq {
        color: var(--dim);
        font-family: var(--mono);
        font-size: 12px;
        white-space: nowrap;
      }
      .label {
        font-size: 13px;
      }
      .child {
        font-family: var(--mono);
        font-size: 12px;
        margin-left: 6px;
      }
      .ok {
        color: var(--ok);
      }
      .danger {
        color: var(--danger);
      }
      .accent {
        color: var(--accent);
      }
      .muted {
        color: var(--muted);
      }
      .when {
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .took {
        color: var(--warn);
        font-size: 12px;
        white-space: nowrap;
      }
      .payload {
        margin-top: 6px;
      }
      pre.stack {
        margin: 6px 0 0;
        font-family: var(--mono);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--muted);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .paging {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 14px;
        font-size: 12.5px;
        color: var(--muted);
      }
      button {
        font: inherit;
        font-size: 12.5px;
        color: var(--text);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 4px 10px;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.45;
        cursor: default;
      }
    `,
  ];

  /**
   * Ask the detail view for a different page. An event rather than a callback
   * property so the request crosses the shadow boundary the same way every
   * other user action in this app does.
   */
  private requestPage(fromEvent: number): void {
    this.dispatchEvent(
      new CustomEvent('history-page', {
        detail: {fromEvent},
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    if (this.history.length === 0)
      return html`<h2>History</h2>
        <div class="muted">No events yet.</div>`;

    const markers = markerTimes(this.history);
    const now = Date.now();

    return html`
      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Seq</th>
            <th>Event</th>
            <th>When</th>
            <th>Took</th>
          </tr>
        </thead>
        <tbody>
          ${this.history.map((event, i) => this.row(event, i, markers, now))}
        </tbody>
      </table>
      ${this.paging()}
    `;
  }

  private row(
    event: HistoryEvent,
    index: number,
    markers: Map<number, number>,
    now: number,
  ): TemplateResult {
    const view = describeEvent(event);
    const took = durationOf(event, markers);
    return html`
      <tr>
        <td class="seq">${this.offset + index}</td>
        <td class="seq">${'seq' in event ? event.seq : ''}</td>
        <td>
          <div class="label ${view.tone}">
            ${view.label}
            ${
              view.childId === undefined
                ? nothing
                : html`<a class="child" href=${executionHref(view.childId)}
                  >${view.childId}</a
                >`
            }
          </div>
          ${
            view.payload === undefined
              ? nothing
              : html`<div class="payload">
                <json-view .value=${view.payload}></json-view>
              </div>`
          }
          ${view.stack ? html`<pre class="stack">${view.stack}</pre>` : nothing}
        </td>
        <td class="when" title=${absoluteTime(event.ts)}>
          ${relativeTime(event.ts, now)}
        </td>
        <td class="took">${took === undefined ? '' : formatDuration(took)}</td>
      </tr>
    `;
  }

  private paging(): TemplateResult | typeof nothing {
    const shown = this.history.length;
    const end = this.offset + shown;
    if (this.offset === 0 && end >= this.total) return nothing;
    return html`
      <div class="paging">
        <button
          ?disabled=${this.offset === 0}
          @click=${() => this.requestPage(Math.max(0, this.offset - shown))}
        >
          ← earlier
        </button>
        <button
          ?disabled=${end >= this.total}
          @click=${() => this.requestPage(end)}
        >
          later →
        </button>
        <span>events ${this.offset}–${end - 1} of ${this.total}</span>
      </div>
    `;
  }
}

customElements.define('history-timeline', HistoryTimeline);
