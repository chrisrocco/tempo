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
 *
 * ## Copy takes the whole value, not what is on screen
 *
 * The copy button appears on every payload, short or truncated, and always
 * writes the full serialization. Copying the collapsed form — twelve lines and
 * an ellipsis — would produce something that looks like JSON, does not parse,
 * and gives no hint why.
 *
 * It can fail: `navigator.clipboard` is undefined outside a secure context, and
 * `127.0.0.1` qualifies but a LAN address served over plain HTTP does not. That
 * is reported in the button rather than swallowed, since the alternative is an
 * operator pasting whatever was in the clipboard beforehand.
 */

import {LitElement, css, html, nothing, type TemplateResult} from 'lit';
import {surface} from './theme.js';

/** How many lines show before the value is truncated behind a toggle. */
const COLLAPSED_LINES = 12;

/** How long the copy button reports its outcome before reverting. */
const COPY_FEEDBACK_MS = 1500;

export class JsonView extends LitElement {
  static override properties = {
    value: {attribute: false},
    expanded: {state: true},
    copied: {state: true},
  };

  declare value: unknown;
  declare expanded: boolean;
  /** What the copy button should say right now. */
  declare copied: 'idle' | 'ok' | 'failed';

  /** Clears the copy feedback; cancelled on disconnect so it cannot outlive us. */
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.value = undefined;
    this.expanded = false;
    this.copied = 'idle';
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
  }

  /**
   * Write `text` to the clipboard and report the outcome in the button.
   *
   * The feedback reverts on a timer rather than staying: a button reading
   * "copied" ten minutes later says nothing about the copy the reader is about
   * to make.
   */
  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = 'ok';
    } catch {
      // Either no clipboard API (insecure context) or permission refused.
      // Which one it was does not change what the reader can do about it.
      this.copied = 'failed';
    }
    if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copied = 'idle';
    }, COPY_FEEDBACK_MS);
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
      .actions {
        display: flex;
        gap: 14px;
        align-items: center;
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
    const long = lines.length > COLLAPSED_LINES;
    const shown =
      !long || this.expanded
        ? text
        : `${lines.slice(0, COLLAPSED_LINES).join('\n')}\n  …`;

    return html`
      <pre>${shown}</pre>
      <div class="actions">
        ${
          long
            ? html`<button
              class="toggle"
              @click=${() => {
                this.expanded = !this.expanded;
              }}
            >
              ${this.expanded ? 'collapse' : `show all ${lines.length} lines`}
            </button>`
            : nothing
        }
        <button class="toggle" @click=${() => void this.copy(text)}>
          ${this.copyLabel()}
        </button>
      </div>
    `;
  }

  /** What the copy button says, given the last attempt's outcome. */
  private copyLabel(): string {
    switch (this.copied) {
      case 'ok':
        return 'copied';
      case 'failed':
        return 'copy failed';
      default:
        return 'copy';
    }
  }
}

customElements.define('json-view', JsonView);
