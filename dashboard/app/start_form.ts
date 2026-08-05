/**
 * @fileoverview
 * `<start-form>` — start a workflow from the browser.
 *
 * The fourth write operation the dashboard exposes, and the only one that does
 * not begin with an execution already on screen. `client.start` has been in
 * `client.ts` since the RPC was typed; this is the thing that calls it.
 *
 * ## Collapsed until asked for
 *
 * It sits above the executions list, which is a *reading* view — the reason
 * someone opens the dashboard is nearly always to find out what is wrong, not
 * to launch something. A button that expands into a form keeps the affordance
 * discoverable without a four-field panel occupying the top of the page on
 * every visit. Same open/close shape as `action_bar.ts`, for the same reason.
 *
 * ## Straight to the new execution
 *
 * On success it navigates to the execution it just created rather than
 * returning to the list. Starting a workflow from a dashboard is an act of
 * watching it — the alternative is a list where the new row is one of fifty and
 * the operator's next move is to find and click it.
 *
 * ## A reused id opens what is already there, and says so
 *
 * A caller-chosen id is a claim on a name rather than a demand for a new
 * execution (see `StartWorkflowOptions.workflowId`), so typing one that already
 * exists returns that execution instead of starting a second — with the
 * arguments it was originally started with, not the ones just typed.
 *
 * That is deduplication working, and it is the reason to type an id at all. But
 * it is indistinguishable from a successful start unless something says which
 * happened, so this reports it: `StartResult.created` decides whether the form
 * says it started something or opened something. Without that the operator
 * concludes their arguments took effect, which is the one way this can mislead.
 *
 * **There is no auth behind this** — the caveat on `action_bar.ts` applies
 * unchanged, and this button creates work rather than ending it.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import type {StartWorkflowOptions} from 'workflow-engine/protocol';
import {client} from './client.js';
import {navigate} from './router.js';
import {executionHref} from './routes.js';
import {parseArgs} from './start_args.js';
import {controls, heading, panel, surface} from './theme.js';

export class StartForm extends LitElement {
  static override properties = {
    open: {state: true},
    busy: {state: true},
    error: {state: true},
    outcome: {state: true},
    name: {state: true},
    args: {state: true},
    workflowId: {state: true},
    taskQueue: {state: true},
  };

  declare open: boolean;
  declare busy: boolean;
  declare error: string | undefined;
  /** What the last start actually did, when that was not starting something. */
  declare outcome: string | undefined;
  declare name: string;
  declare args: string;
  declare workflowId: string;
  declare taskQueue: string;

  constructor() {
    super();
    this.open = false;
    this.busy = false;
    this.error = undefined;
    this.outcome = undefined;
    this.name = '';
    this.args = '';
    this.workflowId = '';
    this.taskQueue = '';
  }

  static override styles = [
    surface,
    heading,
    panel,
    controls,
    css`
      :host {
        display: block;
      }
      .form {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      input {
        width: 170px;
      }
      input.wide {
        width: 300px;
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
      /* Not an error — the id did its job — but it is not what was asked for
         either, so it reads as a caution rather than as a failure. */
      .reused {
        color: var(--warn);
      }
    `,
  ];

  /**
   * Parse, send, and go to the result.
   *
   * The argument text is parsed before anything is sent, so a typo is a message
   * under the field rather than a workflow that starts with the string `"{a:"`
   * as its first parameter — the same reasoning as the signal payload in
   * `action_bar.ts`.
   */
  private async submit(): Promise<void> {
    const parsed = parseArgs(this.args);
    if ('error' in parsed) {
      this.error = parsed.error;
      return;
    }

    const options: StartWorkflowOptions = {};
    if (this.workflowId.trim() !== '')
      options.workflowId = this.workflowId.trim();
    if (this.taskQueue.trim() !== '') options.taskQueue = this.taskQueue.trim();

    this.busy = true;
    this.error = undefined;
    try {
      const {workflowId, created} = await client.start(
        this.name.trim(),
        parsed.args,
        options,
      );
      // Said on the way out rather than on the page being navigated to: the
      // detail view has no idea a start just happened, and the difference
      // between "started" and "this already existed" is only meaningful to the
      // person who pressed the button.
      this.outcome = created
        ? undefined
        : `${workflowId} already existed — opened it instead of starting a second. Its arguments are the ones it was started with.`;
      this.open = false;
      this.name = '';
      this.args = '';
      this.workflowId = '';
      this.taskQueue = '';
      navigate(executionHref(workflowId));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="panel">
        <div class="form">
          <button
            @click=${() => {
              this.open = !this.open;
              this.error = undefined;
            }}
          >
            ${this.open ? 'cancel' : 'start a workflow'}
          </button>
          ${this.open ? this.fields() : nothing}
        </div>
        ${
          this.open
            ? html`<div class="note">
              Arguments are a JSON array — <code>["world"]</code> passes one
              string. An id is optional; the server generates one. An id you
              choose is a claim on a name: reusing one opens the execution that
              already holds it rather than starting a second.
            </div>`
            : nothing
        }
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${
          this.outcome === undefined
            ? nothing
            : html`<div class="note reused">${this.outcome}</div>`
        }
      </div>
    `;
  }

  private fields(): TemplateResult {
    return html`
      <input
        placeholder="workflow name"
        .value=${this.name}
        @input=${(e: Event) => {
          this.name = (e.target as HTMLInputElement).value;
        }}
      />
      <input
        class="wide"
        placeholder="arguments (JSON array, optional)"
        .value=${this.args}
        @input=${(e: Event) => {
          this.args = (e.target as HTMLInputElement).value;
        }}
      />
      <input
        placeholder="workflow id (optional)"
        .value=${this.workflowId}
        @input=${(e: Event) => {
          this.workflowId = (e.target as HTMLInputElement).value;
        }}
      />
      <input
        placeholder="task queue (optional)"
        .value=${this.taskQueue}
        @input=${(e: Event) => {
          this.taskQueue = (e.target as HTMLInputElement).value;
        }}
      />
      <button
        ?disabled=${this.busy || this.name.trim() === ''}
        @click=${() => void this.submit()}
      >
        start
      </button>
    `;
  }
}

customElements.define('start-form', StartForm);
