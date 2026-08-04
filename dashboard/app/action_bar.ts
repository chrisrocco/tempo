/**
 * @fileoverview
 * `<action-bar>` — signal, cancel, and terminate, from the detail view.
 *
 * These are the three write operations the dashboard exposes, and they are most
 * of its value: the alternative is switching to a terminal and retyping a
 * workflow id that is already on screen.
 *
 * **There is no auth behind this.** Anyone who can reach the port can terminate
 * any execution, which is a pre-existing property of the RPC rather than
 * something the UI introduces — but a button makes it easier to forget than a
 * CLI flag does. See planning/sprints/06-dashboard.md, decision 2.
 *
 * ## Why each action opens a form
 *
 * Not decoration: two of the three need an argument, and the third is
 * irreversible.
 *
 * - **Signal** needs a name, and a payload that has to parse as JSON. Parsing
 *   in the browser means a typo is a message under the field rather than a
 *   `SyntaxError` on the server or, worse, the string `"{name:"` delivered as a
 *   payload.
 * - **Terminate** needs a reason, and it is the one action that cannot be
 *   undone or retried into — it ends the execution without replaying it. The
 *   reason field doubles as the confirmation step.
 * - **Cancel** is cooperative and recoverable, but it is still a write, and
 *   having one of three buttons fire on a single click is how the wrong one
 *   gets pressed.
 *
 * A settled execution can still be inspected, so the bar renders — but the
 * actions are disabled, since signalling something that has completed is a
 * no-op the user would be entitled to read as success.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {ExecutionSummary} from 'workflow-engine/protocol';
import {client} from './client.js';
import {controls, heading, panel, surface} from './theme.js';

type Mode = 'idle' | 'signal' | 'cancel' | 'terminate';

export class ActionBar extends LitElement {
  static override properties = {
    execution: {attribute: false},
    mode: {state: true},
    busy: {state: true},
    error: {state: true},
    signalName: {state: true},
    signalPayload: {state: true},
    reason: {state: true},
  };

  declare execution: ExecutionSummary | undefined;
  declare mode: Mode;
  declare busy: boolean;
  declare error: string | undefined;
  declare signalName: string;
  declare signalPayload: string;
  declare reason: string;

  constructor() {
    super();
    this.execution = undefined;
    this.mode = 'idle';
    this.busy = false;
    this.error = undefined;
    this.signalName = '';
    this.signalPayload = '';
    this.reason = '';
  }

  static override styles = [
    surface,
    heading,
    panel,
    controls,
    css`
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .form {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-top: 12px;
      }
      input {
        width: 190px;
      }
      input.wide {
        width: 280px;
      }
      .note {
        color: var(--muted);
        font-size: 12px;
        margin-top: 8px;
      }
      .error {
        margin-top: 8px;
        font-size: 12.5px;
      }
    `,
  ];

  /**
   * Run one write, then tell the detail view to re-read.
   *
   * The result of a control action is visible only in the execution's own
   * state, and the poller's next tick is up to two seconds away — long enough
   * that a user reasonably concludes the button did nothing and presses it
   * again.
   */
  private async perform(action: () => Promise<unknown>): Promise<void> {
    this.busy = true;
    this.error = undefined;
    try {
      await action();
      this.mode = 'idle';
      this.signalName = '';
      this.signalPayload = '';
      this.reason = '';
      this.dispatchEvent(
        new CustomEvent('acted', {bubbles: true, composed: true}),
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private sendSignal(): void {
    const execution = this.execution;
    if (!execution) return;
    let payload: unknown;
    if (this.signalPayload.trim() !== '') {
      try {
        payload = JSON.parse(this.signalPayload);
      } catch {
        this.error = 'payload is not valid JSON';
        return;
      }
    }
    // Fire-and-forget: `perform` reports its own failure through `error`.
    void this.perform(() =>
      client.signal(execution.workflowId, this.signalName, payload),
    );
  }

  private open(mode: Mode): void {
    this.mode = this.mode === mode ? 'idle' : mode;
    this.error = undefined;
  }

  override render(): TemplateResult {
    const execution = this.execution;
    if (!execution) return html``;
    const live = execution.status === 'running';
    return html`
      <div class="panel">
        <h2>Actions</h2>
        <div class="row">
          <button ?disabled=${!live} @click=${() => this.open('signal')}>
            signal
          </button>
          <button ?disabled=${!live} @click=${() => this.open('cancel')}>
            cancel
          </button>
          <button
            class="danger"
            ?disabled=${!live}
            @click=${() => this.open('terminate')}
          >
            terminate
          </button>
        </div>
        ${
          live
            ? nothing
            : html`<div class="note">
              This execution is ${execution.status}; there is nothing to act on.
            </div>`
        }
        ${this.form()}
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      </div>
    `;
  }

  private form(): TemplateResult | typeof nothing {
    const execution = this.execution;
    if (!execution || this.mode === 'idle') return nothing;

    if (this.mode === 'signal')
      return html`
        <div class="form">
          <input
            placeholder="signal name"
            .value=${this.signalName}
            @input=${(e: Event) => {
              this.signalName = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            class="wide"
            placeholder="payload (JSON, optional)"
            .value=${this.signalPayload}
            @input=${(e: Event) => {
              this.signalPayload = (e.target as HTMLInputElement).value;
            }}
          />
          <button
            ?disabled=${this.busy || this.signalName.trim() === ''}
            @click=${() => this.sendSignal()}
          >
            send
          </button>
        </div>
      `;

    if (this.mode === 'cancel')
      return html`
        <div class="form">
          <span class="muted"
            >Request cancellation of ${execution.workflowId}?</span
          >
          <button
            ?disabled=${this.busy}
            @click=${() =>
              void this.perform(() => client.cancel(execution.workflowId))}
          >
            confirm cancel
          </button>
          <button @click=${() => this.open('idle')}>back</button>
        </div>
        <div class="note">
          Cooperative: the workflow observes it and unwinds. An execution whose
          replay is itself failing will not see it — that is what terminate is
          for.
        </div>
      `;

    return html`
      <div class="form">
        <input
          class="wide"
          placeholder="reason"
          .value=${this.reason}
          @input=${(e: Event) => {
            this.reason = (e.target as HTMLInputElement).value;
          }}
        />
        <button
          class="danger"
          ?disabled=${this.busy || this.reason.trim() === ''}
          @click=${() =>
            void this.perform(() =>
              client.terminate(execution.workflowId, this.reason.trim()),
            )}
        >
          terminate ${execution.workflowId}
        </button>
        <button @click=${() => this.open('idle')}>back</button>
      </div>
      <div class="note">
        Ends the execution without replaying it. This cannot be undone, and the
        reason is recorded as the failure.
      </div>
    `;
  }
}

customElements.define('action-bar', ActionBar);
