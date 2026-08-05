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
 * `@property`. Decorators need `experimentalDecorators` and a transformation to
 * emit; without them every component is a straight transcription of its source
 * with the types removed.
 *
 * That rule was originally load-bearing: the server transpiled each module on
 * request, and anything needing a real transformation would have broken it. That
 * server is gone — esbuild bundles the app now, and would handle decorators
 * without complaint. The rule stays because the output remains readable against
 * the source and native type stripping stays available, which is a preference
 * rather than a constraint. Every component here follows it.
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
 * | `queues_view.ts`      | which pools and types are in trouble            |
 * | `history_view.ts`     | how an event reads, its family, how long it took|
 * | `history_spans.ts`    | those events as intervals on a time axis        |
 * | `history_export.ts`   | a whole history, across the pages it arrives in |
 * | `history_timeline.ts` | laying all that out, and paging it              |
 * | `action_bar.ts`       | signal, cancel, terminate                       |
 * | `start_form.ts`       | starting a workflow                             |
 * | `start_args.ts`       | what the arguments box accepts                  |
 * | `status_badge.ts`     | the one place `isStuck` becomes a pill          |
 * | `json_view.ts`        | any payload the user's own code produced        |
 *
 * `routes.ts`, `history_view.ts`, `history_spans.ts`, `history_export.ts`, and
 * `start_args.ts` are deliberately DOM-free, which is what lets the suite cover
 * them (`spec/dashboard/`) without a browser. Everything with a decision in it
 * belongs on that side of the line.
 */

import {LitElement, css, html, type TemplateResult} from 'lit';
import {RouteController} from './router.js';
import {QUEUES_HREF, executionsHref, type Route} from './routes.js';
import {heading, surface} from './theme.js';
import './execution_detail.js';
import './execution_list.js';
import './queues_view.js';

/**
 * Adding a route becomes a compile error here rather than a blank page — the
 * same reason `rpc_server.ts` ends its dispatch this way (see AGENTS.md).
 */
function assertNever(route: never): never {
  throw new Error(`unhandled route: ${JSON.stringify(route)}`);
}

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
      nav {
        margin-left: auto;
        display: flex;
        gap: 16px;
        font-size: 12.5px;
      }
      nav a.here {
        color: var(--text);
        font-weight: 600;
      }
    `,
  ];

  override render(): TemplateResult {
    const route = this.router.route;
    // The detail view belongs to the executions section, so its tab stays lit
    // while reading one — a nav that goes blank on a sub-page loses the reader's
    // sense of where they are.
    const onQueues = route.view === 'queues';
    return html`
      <header>
        <a class="brand" href=${executionsHref()}>tempo</a>
        <span class="tagline">what is running, what is broken, and why</span>
        <nav>
          <a class=${onQueues ? '' : 'here'} href=${executionsHref()}
            >executions</a
          >
          <a class=${onQueues ? 'here' : ''} href=${QUEUES_HREF}
            >queues &amp; types</a
          >
        </nav>
      </header>
      ${this.view(route)}
    `;
  }

  private view(route: Route): TemplateResult {
    switch (route.view) {
      case 'executions':
        return html`<execution-list .filter=${route.filter}></execution-list>`;
      case 'execution':
        return html`<execution-detail
          .workflowId=${route.workflowId}
        ></execution-detail>`;
      case 'queues':
        return html`<queues-view></queues-view>`;
      default:
        return assertNever(route);
    }
  }
}

customElements.define('tempo-app', TempoApp);
