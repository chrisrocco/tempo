/**
 * @fileoverview
 * Binding the routes in `routes.ts` to the browser — the whole router, against
 * the platform.
 *
 * A router library was considered and rejected (see
 * planning/sprints/06-dashboard.md): `@lit-labs/router` is pre-release, this app
 * has three routes, and the platform already fires an event when the hash
 * changes.
 *
 * **The hash, not the path.** Path routing needs the server to answer every URL
 * with the shell, which would mean `server/static_server.ts` deciding whether
 * `/foo` is a route or a missing file. The hash never reaches the server, so
 * deep links work with no server-side routing table at all.
 *
 * What a URL *means* lives in `routes.ts`, which touches no DOM and is covered
 * by the suite. This module is only the wiring.
 */

import type {ReactiveController, ReactiveControllerHost} from 'lit';
import {type Route, parseRoute} from './routes.js';

/** Navigate, which is just a hash assignment — the event does the rest. */
export function navigate(href: string): void {
  location.hash = href;
}

/**
 * Re-renders its host whenever the route changes.
 *
 * `hashchange` rather than `popstate`: both fire for a hash change, but
 * `hashchange` is the one that means *only* that, and it also fires for the
 * programmatic `location.hash =` assignment that `navigate` performs.
 */
export class RouteController implements ReactiveController {
  route: Route;

  constructor(private readonly host: ReactiveControllerHost) {
    this.route = parseRoute(location.hash);
    host.addController(this);
  }

  hostConnected(): void {
    window.addEventListener('hashchange', this.onHashChange);
    // The hash may have changed between construction and connection.
    this.onHashChange();
  }

  hostDisconnected(): void {
    window.removeEventListener('hashchange', this.onHashChange);
  }

  /** An arrow so it keeps `this` and stays identical across add/remove. */
  private readonly onHashChange = (): void => {
    this.route = parseRoute(location.hash);
    this.host.requestUpdate();
  };
}
