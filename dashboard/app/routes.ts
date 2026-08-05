/**
 * @fileoverview
 * What the dashboard's URLs mean: the route shapes, and the total functions
 * that convert between a hash and a route.
 *
 * Separate from `router.ts` — which binds this to the browser — because this
 * half touches no DOM and therefore runs, and is specified, in the suite
 * (`spec/dashboard/routes.spec.ts`). URL parsing is where the fiddly cases live
 * (encoding, unknown values, empty filters), and those are exactly the cases a
 * browser-driven test would be the most expensive way to cover.
 *
 * ## Filters live in the URL
 *
 * The executions route carries its filter, so "the stuck ones on the `email`
 * queue" is a link that can be pasted into a ticket and survives a reload. The
 * alternative — filter state held inside the list component — makes the most
 * useful thing an operator produces (a URL pointing at the problem)
 * unshareable.
 *
 * Only the fields worth linking to are encoded. `limit` and `cursor` are paging
 * mechanics rather than a description of what is being looked at, and a stale
 * cursor in a pasted link would resolve to a page that no longer means
 * anything.
 */

import type {ExecutionFilter, ExecutionStatus} from 'workflow-engine/protocol';

/** The filter fields the URL round-trips; the rest are paging mechanics. */
export type RouteFilter = Pick<
  ExecutionFilter,
  'status' | 'name' | 'taskQueue' | 'workflowIdPrefix' | 'stuck'
>;

/** Where the user is. Unrecognized hashes fall back to the listing. */
export type Route =
  | {view: 'executions'; filter: RouteFilter}
  | {view: 'execution'; workflowId: string}
  | {view: 'queues'};

const STATUSES: readonly ExecutionStatus[] = [
  'running',
  'completed',
  'failed',
  'terminated',
];

function isStatus(value: string): value is ExecutionStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * Parse a `location.hash` into a route.
 *
 * Total by construction: anything unrecognized is the unfiltered listing. A
 * dashboard that rendered "404" for a typo in a hash would be choosing to be
 * useless in the one case where the user is already lost. An unknown `status`
 * is dropped for the same reason — showing everything is a better answer than
 * showing nothing, and the filter bar will render as "any status", which says
 * so.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathname = '/', query = ''] = raw.split('?');

  if (pathname === '/queues') return {view: 'queues'};

  const detail = /^\/executions\/(.+)$/.exec(pathname);
  if (detail) {
    // A workflow id is caller-chosen and may contain anything, including the
    // `%` that makes decoding throw. An id that cannot be decoded is not a
    // reason to blank the page.
    let workflowId: string;
    try {
      workflowId = decodeURIComponent(detail[1]!);
    } catch {
      workflowId = detail[1]!;
    }
    return {view: 'execution', workflowId};
  }

  const params = new URLSearchParams(query);
  const filter: RouteFilter = {};
  const status = params.get('status');
  if (status && isStatus(status)) filter.status = status;
  const name = params.get('name');
  if (name) filter.name = name;
  const taskQueue = params.get('taskQueue');
  if (taskQueue) filter.taskQueue = taskQueue;
  const prefix = params.get('id');
  if (prefix) filter.workflowIdPrefix = prefix;
  if (params.get('stuck') === '1') filter.stuck = true;

  return {view: 'executions', filter};
}

/** The link to one execution's detail view. */
export function executionHref(workflowId: string): string {
  return `#/executions/${encodeURIComponent(workflowId)}`;
}

/** The link to the queues and workflow-types view. */
export const QUEUES_HREF = '#/queues';

/**
 * The link to the listing under `filter`. Empty fields are dropped rather than
 * written as blanks, so the unfiltered listing is plain `#/` and two links to
 * the same view compare equal.
 */
export function executionsHref(filter: RouteFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.name) params.set('name', filter.name);
  if (filter.taskQueue) params.set('taskQueue', filter.taskQueue);
  if (filter.workflowIdPrefix) params.set('id', filter.workflowIdPrefix);
  if (filter.stuck) params.set('stuck', '1');
  const query = params.toString();
  return query ? `#/?${query}` : '#/';
}
