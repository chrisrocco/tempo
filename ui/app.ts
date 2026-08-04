/**
 * @fileoverview
 * The dashboard shell — for now, the executions list, which is the view that
 * earns its keep first.
 *
 * This is the walking skeleton for Phase 0 item 2: it exists to prove the whole
 * chain works end to end — TypeScript transpiled on request, bare `lit`
 * specifiers resolved by the generated import map, a custom element rendering,
 * and the RPC answering from the same origin. The remaining views land on top of
 * it (planning/sprints/06-dashboard.md).
 *
 * ## No decorators
 *
 * `static properties` and `customElements.define`, not `@customElement` and
 * `@property`. Decorators would need `experimentalDecorators` and a
 * transformation; without them the served JavaScript is a straight transcription
 * of this file with the types removed, which keeps the on-request transpile
 * trivial and leaves the door open to native type stripping later.
 */

import {LitElement, css, html, type TemplateResult} from 'lit';
import {client} from './client.js';
import type {ExecutionSummary} from '../src/protocol/service';
import {isStuck} from '../src/protocol/service.js';

/** How often the list re-reads the server while the tab is visible. */
const POLL_MS = 2000;

class TempoApp extends LitElement {
  static override properties = {
    executions: {state: true},
    error: {state: true},
  };

  declare executions: ExecutionSummary[];
  declare error: string | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    super();
    this.executions = [];
    this.error = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /**
   * A failed poll is shown, not swallowed and not fatal: the server restarting
   * under a dashboard left open is the common case, and the list should recover
   * on the next tick rather than need a reload.
   */
  private async refresh(): Promise<void> {
    try {
      // A page, not everything: the server caps it, and a dashboard polling
      // every couple of seconds is exactly the caller that cap exists for.
      this.executions = (await client.listExecutions({limit: 50})).executions;
      this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  static override styles = css`
    :host {
      display: block;
      padding: 24px 28px;
      color: #e6e6e6;
    }
    h1 {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #8b93a7;
      margin: 0 0 18px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th {
      text-align: left;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7280;
      padding: 0 14px 8px 0;
      border-bottom: 1px solid #232733;
    }
    td {
      padding: 9px 14px 9px 0;
      border-bottom: 1px solid #1a1e27;
      font-variant-numeric: tabular-nums;
    }
    .id {
      font-family: ui-monospace, monospace;
      font-size: 12.5px;
    }
    .badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    .running {
      background: #17324d;
      color: #7cc4ff;
    }
    .completed {
      background: #12331f;
      color: #6ee7a0;
    }
    .failed {
      background: #3d1a1d;
      color: #ff9aa2;
    }
    .terminated {
      background: #2a2a2f;
      color: #b0b4bd;
    }
    .stuck {
      background: #4a2f0a;
      color: #ffc46b;
    }
    .reason {
      color: #8b93a7;
      font-size: 12px;
    }
    .empty,
    .error {
      color: #8b93a7;
      padding: 14px 0;
    }
    .error {
      color: #ff9aa2;
    }
  `;

  /**
   * Stuck is not a status — it is a running execution the engine cannot replay
   * — so it reads as its own badge rather than replacing `running`. Hiding that
   * it is still live and still retrying would be the wrong simplification.
   */
  private badge(execution: ExecutionSummary): TemplateResult {
    if (isStuck(execution)) return html`<span class="badge stuck">stuck</span>`;
    return html`<span class="badge ${execution.status}"
      >${execution.status}</span
    >`;
  }

  override render(): TemplateResult {
    return html`
      <h1>Executions</h1>
      ${
        this.error
          ? html`<div class="error">cannot reach the server — ${this.error}</div>`
          : ''
      }
      ${
        this.executions.length === 0 && !this.error
          ? html`<div class="empty">Nothing has run yet.</div>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>Workflow ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Events</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                ${this.executions.map(
                  (execution) => html`
                    <tr>
                      <td class="id">${execution.workflowId}</td>
                      <td>${execution.name}</td>
                      <td>${this.badge(execution)}</td>
                      <td>${execution.historyLength}</td>
                      <td class="reason">
                        ${isStuck(execution) ? execution.lastTaskFailure : ''}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `
      }
    `;
  }
}

customElements.define('tempo-app', TempoApp);
