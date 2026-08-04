/**
 * @fileoverview
 * `<tempo-app>` — the shell: a header, and whichever view the route names.
 *
 * Deliberately thin. It owns the route and nothing else; the two views own
 * their own polling, their own errors, and their own paging. An earlier version
 * of this file *was* the executions list — the walking skeleton that proved the
 * serving chain worked (transpile on request, the generated import map, a
 * custom element, and the RPC answering same-origin). That chain is proven, so
 * the shell went back to being a shell.
 *
 * ## No decorators
 *
 * `static properties` and `customElements.define`, not `@customElement` and
 * `@property`. Decorators would need `experimentalDecorators` and a
 * transformation; without them the served JavaScript is a straight
 * transcription of this file with the types removed, which keeps the
 * on-request transpile trivial and leaves the door open to native type
 * stripping later. Every component here follows the same rule — see
 * `services/ui_server.ts`.
 *
 * ## Where the pieces are
 *
 * | module                | owns                                            |
 * | --------------------- | ----------------------------------------------- |
 * | `routes.ts`           | what a URL means; filters as shareable links    |
 * | `router.ts`           | binding those to `hashchange`                   |
 * | `poller.ts`           | every repeating read: backoff, pause, abort     |
 * | `client.ts`           | the RPC, typed from `protocol/`                 |
 * | `theme.ts`            | the palette and the shared element styles       |
 * | `execution_list.ts`   | the home view: filter bar and paged table       |
 * | `execution_detail.ts` | one execution, and the panels that explain it   |
 * | `history_view.ts`     | how an event reads, and how long it took        |
 * | `history_timeline.ts` | laying those out, and paging them               |
 * | `action_bar.ts`       | signal, cancel, terminate                       |
 * | `status_badge.ts`     | the one place `isStuck` becomes a pill          |
 * | `json_view.ts`        | any payload the user's own code produced        |
 *
 * `routes.ts` and `history_view.ts` are deliberately DOM-free, which is what
 * lets the suite cover them (`spec/ui/`) without a browser.
 */

import {LitElement, css, html, type TemplateResult} from 'lit';
import {RouteController} from './router.js';
import {executionsHref} from './routes.js';
import {heading, surface} from './theme.js';
import './execution_detail.js';
import './execution_list.js';

class TempoApp extends LitElement {
  private readonly router = new RouteController(this);

  static override styles = [
    surface,
    heading,
    css`
      :host {
        display: block;
        padding: 20px 28px 60px;
        max-width: 1180px;
      }
      header {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin: 0 0 22px;
      }
      .brand {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text);
      }
      .tagline {
        color: var(--dim);
        font-size: 12px;
      }
    `,
  ];

  override render(): TemplateResult {
    const route = this.router.route;
    return html`
      <header>
        <a class="brand" href=${executionsHref()}>tempo</a>
        <span class="tagline">what is running, what is broken, and why</span>
      </header>
      ${
        route.view === 'executions'
          ? html`<execution-list .filter=${route.filter}></execution-list>`
          : html`<execution-detail
            .workflowId=${route.workflowId}
          ></execution-detail>`
      }
    `;
  }
}

customElements.define('tempo-app', TempoApp);
