/**
 * @fileoverview
 * `<counts-strip>` — what needs attention, above the listing that answers it.
 *
 * Triage was previously only on the queues view, which is the second nav item.
 * The page a reader lands on is the executions list, which is newest-first
 * rather than worst-first — so the page they arrive at did not answer the
 * question they arrived with. This is the cheap version of fixing that: every
 * number is a link into a filter that already exists, so the count and the rows
 * behind it are one click apart.
 *
 * Deliberately *not* a dashboard view of its own. An overview page would
 * duplicate the queues view, and this is a developer's debugging tool rather
 * than a wall display — making the page that is already open do the job is
 * smaller and better.
 *
 * ## It polls slower than the list it sits above
 *
 * Two reads on the home view that were not there before, and `groupExecutions`
 * is a scan of every execution rather than a page of them. At the shared
 * two-second cadence that is the most expensive thing the dashboard does, in
 * service of four numbers that do not change meaningfully between ticks. A
 * separate, slower interval keeps the listing responsive without making the
 * home page the heaviest client the server has.
 *
 * What the numbers *mean* lives in `triage_counts.ts`, which is DOM-free and
 * specified; this file is layout.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {ExecutionGroups, QueueWorkers} from 'workflow-engine/protocol';
import {client} from './client.js';
import {Poller} from './poller.js';
import {QUEUES_HREF, executionsHref} from './routes.js';
import {surface} from './theme.js';
import {triageCounts} from './triage_counts.js';

/**
 * How often the counts refresh.
 *
 * Five times the listing's interval. These are a health summary rather than a
 * live feed, and the reader who needs a number *now* is one click from the rows
 * that produced it.
 */
const COUNTS_INTERVAL_MS = 10_000;

export class CountsStrip extends LitElement {
  private readonly groups = new Poller<ExecutionGroups>(
    this,
    (signal) => client.groupExecutions(signal),
    COUNTS_INTERVAL_MS,
  );

  private readonly queues = new Poller<QueueWorkers[]>(
    this,
    (signal) => client.listQueues(signal),
    COUNTS_INTERVAL_MS,
  );

  static override styles = [
    surface,
    css`
      :host {
        display: block;
        margin: 0 0 16px;
      }
      .strip {
        display: flex;
        flex-wrap: wrap;
        gap: 22px;
        align-items: baseline;
      }
      a.stat {
        display: flex;
        align-items: baseline;
        gap: 7px;
        text-decoration: none;
        color: inherit;
      }
      a.stat:hover .label {
        color: var(--text);
        text-decoration: underline;
      }
      .value {
        font-size: 19px;
        font-variant-numeric: tabular-nums;
      }
      .label {
        font-size: 12px;
        color: var(--muted);
      }
      .zero .value {
        color: var(--dim);
      }
      .bad .value {
        color: var(--danger);
      }
      .wedged .value {
        color: var(--warn);
      }
      .unknown .value {
        color: var(--dim);
      }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const counts = triageCounts(
      this.groups.value,
      this.queues.value,
      Date.now(),
    );
    // Nothing truthful to render before the first read. The listing below is
    // already showing its own loading state, so a second one is noise.
    if (counts === undefined) return nothing;

    return html`
      <div class="strip">
        ${this.stat('running', counts.running, executionsHref({status: 'running'}))}
        ${this.stat(
          'stuck',
          counts.stuck,
          executionsHref({stuck: true}),
          'wedged',
        )}
        ${this.stat(
          'failed',
          counts.failed,
          executionsHref({status: 'failed'}),
          'bad',
        )}
        ${this.unservedStat(counts.unservedQueues)}
      </div>
    `;
  }

  /** One number and its link. Dimmed at zero, so the eye lands on the rest. */
  private stat(
    label: string,
    value: number,
    href: string,
    tone?: 'bad' | 'wedged',
  ): TemplateResult {
    const classes = value === 0 ? 'stat zero' : `stat ${tone ?? ''}`;
    return html`
      <a class=${classes} href=${href}>
        <span class="value">${value}</span><span class="label">${label}</span>
      </a>
    `;
  }

  /**
   * The queue count, which has three states rather than two.
   *
   * Before the fleet has been read the honest answer is "not known", rendered as
   * a dash — the same choice `queues_view` makes for a worker pill it cannot yet
   * describe. It links to the queues view rather than to a filter, because there
   * is no execution filter that expresses "on a queue nobody is polling".
   */
  private unservedStat(value: number | undefined): TemplateResult {
    if (value === undefined)
      return html`
        <a class="stat unknown" href=${QUEUES_HREF}>
          <span class="value">—</span
          ><span class="label">unserved queues</span>
        </a>
      `;
    return this.stat('unserved queues', value, QUEUES_HREF, 'wedged');
  }
}

customElements.define('counts-strip', CountsStrip);
