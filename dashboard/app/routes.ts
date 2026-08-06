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
 *
 * The time range is the one filter whose URL form is not the form the server
 * takes — `?since=1h`, resolved against the clock on each poll. `time_range.ts`
 * owns that decision and the reasoning behind it; `queryFilter` below is where
 * the two representations meet.
 *
 * ## So does the detail view's tab
 *
 * Same test, same answer: "the history of execution X" is a thing worth sending
 * someone, and a tab held in component state is not sendable. It is a query
 * parameter rather than a path segment (`?tab=state`, not `/state`) because it
 * describes *how* one execution is being looked at rather than naming a
 * different resource — the same reason the listing's filter is a query.
 *
 * `fromEvent` is not encoded, and is the detail view's equivalent of `cursor`:
 * which page of history is on screen is mechanics, and an index pasted into a
 * ticket would point at a different event once the history grew.
 */

import type {ExecutionFilter, ExecutionStatus} from 'workflow-engine/protocol';
import {EVENT_CATEGORIES, type EventCategory} from './history_view.js';
import {isTimeRange, rangeStart, type TimeRange} from './time_range.js';

/**
 * The filter fields the URL round-trips; the rest are paging mechanics.
 *
 * Not a plain `Pick` any more: `since` is a *duration*, and `ExecutionFilter`
 * carries instants. The two are one field apart and `queryFilter` is the
 * conversion — see `time_range.ts` for why the URL holds the duration.
 */
export type RouteFilter = Pick<
  ExecutionFilter,
  'status' | 'name' | 'taskQueue' | 'workflowIdPrefix' | 'stuck'
> & {
  /** How far back the listing reaches; absent means all of time. */
  since?: TimeRange;
};

/**
 * Which section of one execution is being read.
 *
 * Only the *bulk* of the detail view is tabbed. Everything diagnostic — the
 * failure, the replay failure, the result, what it is waiting on — stays
 * visible whichever tab is selected, so this never decides whether a reader can
 * see what went wrong. See `execution_detail.ts`.
 *
 * There is no `relationships` tab, and the run-chain half of what it was for is
 * not coming: rollover overwrites one record, so there is no earlier run to
 * navigate to (ticket 05, and `resetForContinueAsNew` owns the reasoning). The
 * parent half shipped instead as a link on the detail view, which is where a
 * single relationship belongs — a tab for one line would be a section pretending
 * to be a section.
 *
 * A URL naming an unknown tab still degrades to the default rather than
 * rendering blank, so adding one later stays a pure addition.
 */
export type DetailTab = 'history' | 'state';

/** Every tab, in the order the view offers them. */
export const DETAIL_TABS: readonly DetailTab[] = ['history', 'state'];

/**
 * History is the default: it is why the page is usually open, and it is the
 * only section whose absence would be noticed.
 */
export const DEFAULT_DETAIL_TAB: DetailTab = 'history';

/** Whether the history reads as an ordered table or as bars on a time axis. */
export type HistoryView = 'table' | 'compact';

/** Both, in the order the timeline offers them. */
export const HISTORY_VIEWS: readonly HistoryView[] = ['table', 'compact'];

/** The table is the default because it is the lossless one. */
export const DEFAULT_HISTORY_VIEW: HistoryView = 'table';

/**
 * How the history is being read, within the History tab.
 *
 * These are in the URL for the same reason the listing's filter is: "the failed
 * activities of execution X, as bars" is a thing worth sending someone. They
 * also have to outlive a tab switch, which tears the timeline element down —
 * holding them in that component made them vanish on a round trip through
 * another tab, and hoisting them into a parent purely to survive that would be
 * state with no reason to exist beyond the accident that created it.
 */
export interface HistoryOptions {
  view: HistoryView;
  /** Which event family is showing; absent means all of them. */
  events?: EventCategory;
}

/** Where the user is. Unrecognized hashes fall back to the listing. */
export type Route =
  | {view: 'executions'; filter: RouteFilter}
  | {
      view: 'execution';
      workflowId: string;
      tab: DetailTab;
      history: HistoryOptions;
    }
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

function isDetailTab(value: string | null): value is DetailTab {
  return value !== null && (DETAIL_TABS as readonly string[]).includes(value);
}

function isHistoryView(value: string | null): value is HistoryView {
  return value !== null && (HISTORY_VIEWS as readonly string[]).includes(value);
}

function isEventCategory(value: string | null): value is EventCategory {
  return (
    value !== null && (EVENT_CATEGORIES as readonly string[]).includes(value)
  );
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
  const params = new URLSearchParams(query);

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
    // An unknown tab falls back rather than rendering nothing — the same choice
    // an unknown `status` gets, and what lets a `?tab=relationships` link
    // written against a later version still open the execution.
    const tab = params.get('tab');
    const historyView = params.get('view');
    const events = params.get('events');
    const history: HistoryOptions = {
      view: isHistoryView(historyView) ? historyView : DEFAULT_HISTORY_VIEW,
    };
    if (isEventCategory(events)) history.events = events;
    return {
      view: 'execution',
      workflowId,
      tab: isDetailTab(tab) ? tab : DEFAULT_DETAIL_TAB,
      history,
    };
  }

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
  const since = params.get('since');
  if (isTimeRange(since)) filter.since = since;

  return {view: 'executions', filter};
}

/**
 * What to ask the server for, given what the URL says and the time now.
 *
 * The one place a `RouteFilter` becomes an `ExecutionFilter`. It exists because
 * the two differ by exactly one field and spreading the route filter into an
 * RPC call — which is what the listing used to do — would send `since` to a
 * server that has never heard of it while omitting the bound it stands for.
 *
 * `now` is a parameter rather than a `Date.now()` call so this stays a pure
 * function of its inputs, and so the spec can pin a window without a clock.
 */
export function queryFilter(filter: RouteFilter, now: number): ExecutionFilter {
  const {since, ...rest} = filter;
  if (since === undefined) return rest;
  return {...rest, createdAfter: rangeStart(since, now)};
}

/** What a link to a detail view can say. Everything omitted takes its default. */
export interface DetailLink {
  tab?: DetailTab;
  history?: Partial<HistoryOptions>;
}

/**
 * The link to one execution's detail view.
 *
 * Defaults are omitted rather than written out, so the plain link to an
 * execution stays `#/executions/id` and the link from a listing row compares
 * equal to the one from the History tab — the same rule `executionsHref`
 * follows for empty filter fields.
 */
export function executionHref(
  workflowId: string,
  link: DetailLink = {},
): string {
  const path = `#/executions/${encodeURIComponent(workflowId)}`;
  const params = new URLSearchParams();
  if (link.tab !== undefined && link.tab !== DEFAULT_DETAIL_TAB)
    params.set('tab', link.tab);
  if (
    link.history?.view !== undefined &&
    link.history.view !== DEFAULT_HISTORY_VIEW
  )
    params.set('view', link.history.view);
  if (link.history?.events !== undefined)
    params.set('events', link.history.events);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
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
  if (filter.since) params.set('since', filter.since);
  const query = params.toString();
  return query ? `#/?${query}` : '#/';
}
