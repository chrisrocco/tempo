/**
 * @fileoverview
 * `<status-badge>` — an execution's state as one pill.
 *
 * A component rather than a shared template function because it owns a
 * *decision*, not just markup: stuck is not a status. `isStuck` is a derived
 * predicate over `status` and `taskFailures` (see `protocol/service.ts`), and
 * the listing and the detail view must not be free to disagree about how it
 * reads. Both render this.
 *
 * Stuck deliberately replaces the `running` pill rather than sitting beside it.
 * A wedged execution *is* still running and still retrying, and an earlier
 * version showed both — but in a column being scanned for problems, the second
 * pill was the only one that mattered and the first one diluted it. The `title`
 * keeps the underlying status available on hover.
 */

import {LitElement, html, type TemplateResult} from 'lit';
import {isStuck, type ExecutionSummary} from 'workflow-engine/protocol';
import {badge, surface} from './theme.js';

export class StatusBadge extends LitElement {
  static override properties = {
    execution: {attribute: false},
  };

  declare execution: ExecutionSummary | undefined;

  constructor() {
    super();
    this.execution = undefined;
  }

  static override styles = [surface, badge];

  override render(): TemplateResult {
    const execution = this.execution;
    if (!execution) return html``;
    if (isStuck(execution))
      return html`<span
        class="badge stuck"
        title="running, but the engine cannot replay it — ${execution.taskFailures} consecutive task failures"
        >stuck</span
      >`;
    return html`<span class="badge ${execution.status}"
      >${execution.status}</span
    >`;
  }
}

customElements.define('status-badge', StatusBadge);
