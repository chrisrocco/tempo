/**
 * @fileoverview
 * `<json-view>` — the one place the dashboard renders an arbitrary payload.
 *
 * Workflow args, activity results, signal payloads, carryover, and failure
 * values are all "some JSON the user's own code produced", and there is nothing
 * useful to say about their shape in advance. Rendering them in one component
 * means the truncation rule, the empty case, and the treatment of values JSON
 * cannot express are decided once.
 *
 * **Collapsed by default when large.** These payloads sit inline in a table of
 * history events, and one 400-line activity result would push everything after
 * it off the screen. Anything longer than `COLLAPSED_LINES` renders truncated
 * with a toggle, so the *shape* of a big value is still visible without it
 * taking over the page.
 *
 * **`undefined` is not `null`.** An activity that returned nothing and one that
 * returned `null` are different outcomes, and `JSON.stringify(undefined)`
 * erases the distinction by producing no output at all. Both are rendered as
 * their own dim literal.
 */

import {LitElement, css, html, type TemplateResult} from 'lit';
import {surface} from './theme.js';

/** How many lines show before the value is truncated behind a toggle. */
const COLLAPSED_LINES = 12;

export class JsonView extends LitElement {
  static override properties = {
    value: {attribute: false},
    expanded: {state: true},
  };

  declare value: unknown;
  declare expanded: boolean;

  constructor() {
    super();
    this.value = undefined;
    this.expanded = false;
  }

  static override styles = [
    surface,
    css`
      :host {
        display: block;
      }
      pre {
        margin: 0;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
      }
      .literal {
        color: var(--dim);
        font-family: var(--mono);
        font-size: 12px;
      }
      .toggle {
        background: none;
        border: none;
        padding: 4px 0 0;
        margin: 0;
        font: inherit;
        font-size: 11.5px;
        color: var(--accent);
        cursor: pointer;
      }
      .toggle:hover {
        text-decoration: underline;
      }
    `,
  ];

  override render(): TemplateResult {
    if (this.value === undefined)
      return html`<span class="literal">undefined</span>`;

    // A value with a cycle or a BigInt in it is the workflow author's problem,
    // but throwing here would blank the whole view rather than the one cell.
    let text: string;
    try {
      text = JSON.stringify(this.value, null, 2) ?? 'undefined';
    } catch (e) {
      return html`<span class="literal"
        >unserializable — ${e instanceof Error ? e.message : String(e)}</span
      >`;
    }

    const lines = text.split('\n');
    if (lines.length <= COLLAPSED_LINES) return html`<pre>${text}</pre>`;

    const shown = this.expanded
      ? text
      : lines.slice(0, COLLAPSED_LINES).join('\n');
    return html`
      <pre>${shown}${this.expanded ? '' : '\n  …'}</pre>
      <button
        class="toggle"
        @click=${() => {
          this.expanded = !this.expanded;
        }}
      >
        ${this.expanded ? 'collapse' : `show all ${lines.length} lines`}
      </button>
    `;
  }
}

customElements.define('json-view', JsonView);
