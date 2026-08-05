/**
 * @fileoverview
 * `<history-timeline>` — an execution's history, as an ordered table or as bars
 * on a time axis.
 *
 * This is the view the `ts` field was added for. Without timestamps a history
 * is a list of things that happened in some order; with them it answers the
 * questions an operator actually arrives with — when did it start, what has it
 * been doing for the last ten minutes, which activity is slow.
 *
 * Layout only. How an event *reads* and which family it belongs to live in
 * `history_view.ts`; how a page of events becomes spans on an axis lives in
 * `history_spans.ts`. Both are DOM-free and specified; this file is the part
 * that would need a browser to test, and it is kept thin for that reason.
 *
 * ## Two views of the same events
 *
 * The table is lossless — every event, its payload, its stack — and is the
 * default. The timeline discards all of that to answer one question, where the
 * time went, which a five-hundred-row table turns into a subtraction exercise.
 * Neither replaces the other, so the toggle is a toggle rather than a migration.
 *
 * ## Paging
 *
 * `describeExecution` returns at most `MAX_HISTORY_PAGE` events and, given no
 * `fromEvent`, returns the *last* page — the right default, since the end of a
 * history is where the answer usually is. This component renders one page and
 * emits `history-page` for the one it wants; `execution_detail.ts` owns the
 * request, because it owns the poller that would otherwise fight with it.
 *
 * ## The filter narrows the page, and says so
 *
 * Filtering happens here, over the events already loaded — not in
 * `DescribeOptions`. Pushing it to the server would be the more capable answer
 * and it is the wrong shape for this protocol: history paging is by *index*
 * precisely because event 40 is event 40 forever (see `DescribeOptions`), and a
 * server-side filter makes offsets describe a filtered sequence that shifts as
 * the history grows. That trades a property the paging design depends on for a
 * convenience.
 *
 * What client-side filtering costs is real, though: on a history longer than one
 * page, "no child events" can mean there are none, or that they are on a page
 * that is not loaded. Those are opposite answers to the question being asked.
 * So whenever a filter is on and the page is not the whole history, the row
 * count says which events were actually searched. The filter never claims to
 * have looked at more than it did.
 *
 * ## This component holds no state
 *
 * The filter, the table/timeline choice, and which page of history is showing
 * are all given to it; it renders what it is handed and dispatches an event to
 * ask for something else. The first two live in the URL (`routes.ts`) and the
 * third belongs to `execution_detail.ts`, which owns the poller.
 *
 * That is not ceremony. This element is torn down whenever the detail view
 * switches tabs, so anything it held locally would silently reset on a round
 * trip through another tab — which is exactly what happened when the filter and
 * the view mode lived here. Putting them in the URL fixes that and makes "the
 * failed activities of execution X, as bars" a link, which is what the
 * executions filter is already built around.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {HistoryEvent} from 'workflow-engine/protocol';
import {
  EVENT_CATEGORIES,
  describeEvent,
  durationOf,
  eventCategory,
  formatDuration,
  markerTimes,
  type EventCategory,
} from './history_view.js';
import {
  buildTimeline,
  fractionOf,
  type CompactTimeline,
  type HistorySpan,
  type TimelineMark,
} from './history_spans.js';
import {
  DEFAULT_HISTORY_VIEW,
  executionHref,
  type HistoryView,
} from './routes.js';
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
    category: {attribute: false},
    view: {attribute: false},
  };

  declare history: HistoryEvent[];
  /** Index of the first event shown, within the whole history. */
  declare offset: number;
  /** The execution's total history length, for the paging controls. */
  declare total: number;
  /**
   * Which family to show; undefined means all of them.
   *
   * A property rather than local state: it lives in the URL, so this component
   * renders what it is given and asks for a change rather than holding one. See
   * the fileoverview.
   */
  declare category: EventCategory | undefined;
  /**
   * Ordered rows, or bars on a time axis.
   *
   * The table is the default because it is the lossless one: every event, its
   * payload, and its stack. The timeline drops all of that to answer one
   * question — where did the time go — and is the wrong thing to land on when
   * the reason for opening the page was to read an error.
   */
  declare view: HistoryView;

  constructor() {
    super();
    this.history = [];
    this.offset = 0;
    this.total = 0;
    this.category = undefined;
    this.view = DEFAULT_HISTORY_VIEW;
  }

  /**
   * Ask for a different reading of the same history.
   *
   * An event rather than a local assignment, for the same reason `history-page`
   * is one: these live in the URL, and the view that owns the route is the only
   * thing that can change them.
   */
  private requestOptions(patch: {
    view?: HistoryView;
    events?: EventCategory | undefined;
  }): void {
    this.dispatchEvent(
      new CustomEvent('history-options', {
        detail: patch,
        bubbles: true,
        composed: true,
      }),
    );
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
      .head {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }
      .head h2 {
        margin-bottom: 10px;
      }
      .export {
        margin-left: auto;
      }
      select {
        font: inherit;
        font-size: 12.5px;
        color: var(--text);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 3px 8px;
      }
      .scope {
        color: var(--muted);
        font-size: 12px;
        margin: 0 0 10px;
      }
      .views {
        display: flex;
        gap: 4px;
      }
      .views button {
        font-size: 12px;
        padding: 3px 9px;
        color: var(--muted);
      }
      .views button.on {
        color: var(--text);
        border-color: var(--dim);
      }
      .axis {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-size: 11px;
        color: var(--dim);
        font-family: var(--mono);
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border);
        margin-bottom: 8px;
      }
      .axis-span {
        color: var(--muted);
      }
      .bar-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 3px 0;
      }
      .bar-row:hover {
        background: var(--bg);
      }
      .bar-label {
        width: 190px;
        flex: none;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--muted);
      }
      .track {
        position: relative;
        flex: 1;
        height: 14px;
        background: var(--bg);
        border-radius: 3px;
        overflow: hidden;
      }
      .bar {
        position: absolute;
        top: 3px;
        height: 8px;
        border-radius: 2px;
        background: var(--accent);
        min-width: 2px;
      }
      .bar.failed {
        background: var(--danger);
      }
      /* Open work is striped: it has no end, so a flat bar would assert one. */
      .bar.open {
        background: repeating-linear-gradient(
          90deg,
          var(--warn) 0 5px,
          transparent 5px 10px
        );
      }
      .mark {
        position: absolute;
        top: 3px;
        width: 3px;
        height: 8px;
        border-radius: 1px;
        background: var(--accent);
        transform: translateX(-1px);
      }
      .mark.danger {
        background: var(--danger);
      }
      .mark.ok {
        background: var(--ok);
      }
      .bar-took {
        width: 62px;
        flex: none;
        text-align: right;
        font-size: 11.5px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
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

  /**
   * Ask the detail view to export the whole history.
   *
   * An event for the same reason `history-page` is one: this component holds a
   * page, and the export is of the execution — which only the view that owns the
   * client can read in full.
   */
  private requestExport(): void {
    this.dispatchEvent(
      new CustomEvent('history-export', {bubbles: true, composed: true}),
    );
  }

  override render(): TemplateResult {
    if (this.history.length === 0)
      return html`<h2>History</h2>
        <div class="muted">No events yet.</div>`;

    // Markers are built over the whole page rather than the filtered subset, so
    // a completion keeps its duration. Categories keep a dispatch and its
    // outcome together, which is what makes that hold under every filter.
    const markers = markerTimes(this.history);
    const now = Date.now();

    // Paired with their original positions before filtering: the `#` column is
    // an index into the history, not into what survived the filter.
    const rows = this.history
      .map((event, index) => ({event, index}))
      .filter(
        ({event}) =>
          this.category === undefined || eventCategory(event) === this.category,
      );

    return html`
      <div class="head">
        <h2>History</h2>
        ${this.viewToggle()} ${this.categoryFilter()}
        <button class="export" @click=${() => this.requestExport()}>
          export JSON
        </button>
      </div>
      ${this.scope(rows.length)}
      ${
        rows.length === 0
          ? html`<div class="muted">
            No ${this.category} events among the ones loaded.
          </div>`
          : this.view === 'table'
            ? this.tableView(rows, markers, now)
            : this.compactView(
                rows.map(({event}) => event),
                now,
              )
      }
      ${this.paging()}
    `;
  }

  /** Table or bars — the same events, answering "in what order" or "for how long". */
  private viewToggle(): TemplateResult {
    return html`
      <div class="views">
        <button
          class=${this.view === 'table' ? 'on' : ''}
          @click=${() => this.requestOptions({view: 'table'})}
        >
          table
        </button>
        <button
          class=${this.view === 'compact' ? 'on' : ''}
          @click=${() => this.requestOptions({view: 'compact'})}
        >
          timeline
        </button>
      </div>
    `;
  }

  private tableView(
    rows: {event: HistoryEvent; index: number}[],
    markers: Map<number, number>,
    now: number,
  ): TemplateResult {
    return html`
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
          ${rows.map(({event, index}) => this.row(event, index, markers, now))}
        </tbody>
      </table>
    `;
  }

  /**
   * The same events as overlapping bars on one axis.
   *
   * Filtering happens before the timeline is built rather than after, which is
   * safe for the same reason durations are: a category holds a dispatch and its
   * completion together, so no filter can orphan half a span.
   */
  private compactView(events: HistoryEvent[], now: number): TemplateResult {
    const timeline = buildTimeline(events, now);

    if (timeline.empty)
      return html`<div class="muted">
        Nothing here can be placed on a time axis — these events were recorded
        before timestamps were.
      </div>`;

    const total = timeline.end - timeline.start;
    return html`
      <div class="axis">
        <span>${absoluteTime(timeline.start)}</span>
        <span class="axis-span">${formatDuration(total)}</span>
        <span>${absoluteTime(timeline.end)}</span>
      </div>
      <div class="bars">
        ${timeline.spans.map((span) => this.spanRow(span, timeline, now))}
        ${timeline.marks.map((mark) => this.markRow(mark, timeline))}
      </div>
      ${
        timeline.unplaceable > 0
          ? html`<div class="scope">
            ${timeline.unplaceable} event${timeline.unplaceable === 1 ? '' : 's'}
            could not be placed — recorded before timestamps existed.
          </div>`
          : nothing
      }
    `;
  }

  private spanRow(
    span: HistorySpan,
    timeline: CompactTimeline,
    now: number,
  ): TemplateResult {
    const from = fractionOf(span.start, timeline);
    const to = fractionOf(span.end ?? now, timeline);
    const took = (span.end ?? now) - span.start;
    return html`
      <div class="bar-row">
        <div class="bar-label mono" title=${span.label}>
          ${
            span.childId === undefined
              ? span.label
              : html`<a href=${executionHref(span.childId)}>${span.label}</a>`
          }
        </div>
        <div class="track">
          <div
            class="bar ${span.outcome}"
            style="left:${(from * 100).toFixed(3)}%;width:${Math.max(
              (to - from) * 100,
              0.6,
            ).toFixed(3)}%"
          ></div>
        </div>
        <div class="bar-took">
          ${formatDuration(took)}${span.outcome === 'open' ? '…' : ''}
        </div>
      </div>
    `;
  }

  private markRow(
    mark: TimelineMark,
    timeline: CompactTimeline,
  ): TemplateResult {
    return html`
      <div class="bar-row">
        <div class="bar-label ${mark.tone}" title=${mark.label}>
          ${mark.label}
        </div>
        <div class="track">
          <div
            class="mark ${mark.tone}"
            style="left:${(fractionOf(mark.at, timeline) * 100).toFixed(3)}%"
          ></div>
        </div>
        <div class="bar-took"></div>
      </div>
    `;
  }

  /** The family selector. Single-choice: the question is "show me the X". */
  private categoryFilter(): TemplateResult {
    return html`
      <select
        @change=${(e: Event) => {
          const value = (e.target as HTMLSelectElement).value;
          this.requestOptions({
            events: value === '' ? undefined : (value as EventCategory),
          });
        }}
      >
        <option value="" ?selected=${this.category === undefined}>
          all events
        </option>
        ${EVENT_CATEGORIES.map(
          (category) => html`
            <option value=${category} ?selected=${this.category === category}>
              ${category}
            </option>
          `,
        )}
      </select>
    `;
  }

  /**
   * What the filter actually searched.
   *
   * Silent when nothing is filtered — the table speaks for itself. With a filter
   * on, it always reports the count, and when the page is not the whole history
   * it names the range too. That is the difference between "this execution has
   * no child workflows" and "the 500 events I looked at have none", which the
   * same empty table would otherwise represent.
   */
  private scope(shown: number): TemplateResult | typeof nothing {
    if (this.category === undefined) return nothing;
    const end = this.offset + this.history.length;
    const partial = this.offset > 0 || end < this.total;
    return html`
      <div class="scope">
        ${
          partial
            ? html`${shown} of the ${this.history.length} events loaded
              (${this.offset}–${end - 1} of ${this.total}) — a filter cannot see
              the rest`
            : html`${shown} of ${this.history.length} events`
        }
      </div>
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
