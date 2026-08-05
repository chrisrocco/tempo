/**
 * @fileoverview
 * What the dashboard's URLs mean. A contributor-facing spec: these are the
 * cases where a hash and a route stop agreeing — encoding, unknown values, and
 * the empty filter — and each one is a link that would silently show the wrong
 * thing rather than fail.
 *
 * Runs without a browser because `routes.ts` touches no DOM, which is why it is
 * a separate module from `router.ts`.
 */

import {
  DETAIL_TABS,
  HISTORY_VIEWS,
  executionHref,
  executionsHref,
  parseRoute,
  type HistoryOptions,
  type RouteFilter,
} from '../../dashboard/app/routes';

/** What the History tab looks like when nothing has been chosen. */
const PLAIN: HistoryOptions = {view: 'table'};

describe('dashboard routes — parsing', () => {
  it('reads a bare hash as the unfiltered executions listing', () => {
    expect(parseRoute('#/')).toEqual({view: 'executions', filter: {}});
  });

  it('reads an empty hash as the listing, which is what a fresh load has', () => {
    expect(parseRoute('')).toEqual({view: 'executions', filter: {}});
  });

  it('reads an unrecognized path as the listing rather than a dead end', () => {
    expect(parseRoute('#/nonsense')).toEqual({view: 'executions', filter: {}});
  });

  it('reads the queues path as the queues view', () => {
    expect(parseRoute('#/queues')).toEqual({view: 'queues'});
  });

  it('reads an execution path as the detail view for that id', () => {
    expect(parseRoute('#/executions/order-42')).toEqual({
      view: 'execution',
      workflowId: 'order-42',
      tab: 'history',
      history: PLAIN,
    });
  });

  it('decodes a workflow id containing characters a URL reserves', () => {
    const id = 'orders/2024#q1 draft';
    expect(parseRoute(executionHref(id))).toEqual({
      view: 'execution',
      workflowId: id,
      tab: 'history',
      history: PLAIN,
    });
  });

  it('keeps a malformed escape as written instead of throwing', () => {
    // `%` is legal in a caller-chosen workflow id, and decodeURIComponent
    // throws on a lone one. A blank page is the wrong answer to a bad link.
    expect(parseRoute('#/executions/100%bad')).toEqual({
      view: 'execution',
      workflowId: '100%bad',
      tab: 'history',
      history: PLAIN,
    });
  });

  it('reads each filter field from the query string', () => {
    expect(
      parseRoute('#/?status=failed&name=greet&taskQueue=email&id=ord&stuck=1'),
    ).toEqual({
      view: 'executions',
      filter: {
        status: 'failed',
        name: 'greet',
        taskQueue: 'email',
        workflowIdPrefix: 'ord',
        stuck: true,
      },
    });
  });

  it('drops a status it does not recognize rather than filtering on nothing', () => {
    expect(parseRoute('#/?status=exploded')).toEqual({
      view: 'executions',
      filter: {},
    });
  });

  it('treats any stuck value other than 1 as unset', () => {
    expect(parseRoute('#/?stuck=false')).toEqual({
      view: 'executions',
      filter: {},
    });
  });
});

describe('dashboard routes — how one execution is being read', () => {
  it('reads the tab from the query string', () => {
    expect(parseRoute('#/executions/order-42?tab=state')).toEqual({
      view: 'execution',
      workflowId: 'order-42',
      tab: 'state',
      history: PLAIN,
    });
  });

  it('falls back to the default tab for one it does not recognize', () => {
    // What lets a `?tab=relationships` link written against a later version
    // still open the execution rather than rendering an empty section.
    expect(parseRoute('#/executions/order-42?tab=relationships')).toEqual(
      jasmine.objectContaining({tab: 'history'}),
    );
  });

  it('reads how the history is displayed and which events it shows', () => {
    expect(
      parseRoute('#/executions/order-42?view=compact&events=activity'),
    ).toEqual({
      view: 'execution',
      workflowId: 'order-42',
      tab: 'history',
      history: {view: 'compact', events: 'activity'},
    });
  });

  it('falls back to the table for a display mode it does not recognize', () => {
    const route = parseRoute('#/executions/order-42?view=gantt');
    expect(route).toEqual(jasmine.objectContaining({history: PLAIN}));
  });

  it('drops an event family it does not recognize rather than showing none', () => {
    // Same rule as an unknown status: everything is a better answer than
    // nothing, and the filter renders as "all events", which says so.
    const route = parseRoute('#/executions/order-42?events=exploded');
    expect(route).toEqual(jasmine.objectContaining({history: PLAIN}));
  });

  it('reads options on an id that itself contains a query character', () => {
    // The pathname is split on the first `?`, so an id has to survive being
    // encoded past one — otherwise a link truncates the execution it names.
    const id = 'orders?draft=1';
    expect(parseRoute(executionHref(id, {tab: 'state'}))).toEqual({
      view: 'execution',
      workflowId: id,
      tab: 'state',
      history: PLAIN,
    });
  });
});

describe('dashboard routes — building links', () => {
  it('writes the unfiltered listing as a bare hash', () => {
    expect(executionsHref()).toBe('#/');
    expect(executionsHref({})).toBe('#/');
  });

  it('omits an empty field rather than writing it as a blank', () => {
    expect(executionsHref({name: '', stuck: false})).toBe('#/');
  });

  it('round-trips every filter field through a link', () => {
    const filter: RouteFilter = {
      status: 'running',
      name: 'poll forever',
      taskQueue: 'email/high',
      workflowIdPrefix: 'ord-',
      stuck: true,
    };
    expect(parseRoute(executionsHref(filter))).toEqual({
      view: 'executions',
      filter,
    });
  });

  it('writes a plain execution link with nothing on it', () => {
    // The link from a listing row and the link from the History tab of an
    // unfiltered table are the same string, so they compare equal.
    expect(executionHref('order-42')).toBe('#/executions/order-42');
    expect(
      executionHref('order-42', {tab: 'history', history: {view: 'table'}}),
    ).toBe('#/executions/order-42');
  });

  it('writes only what differs from the default', () => {
    expect(executionHref('order-42', {tab: 'state'})).toBe(
      '#/executions/order-42?tab=state',
    );
    expect(executionHref('order-42', {history: {view: 'compact'}})).toBe(
      '#/executions/order-42?view=compact',
    );
    expect(executionHref('order-42', {history: {events: 'child'}})).toBe(
      '#/executions/order-42?events=child',
    );
  });

  it('round-trips every tab through a link', () => {
    for (const tab of DETAIL_TABS)
      expect(parseRoute(executionHref('order-42', {tab}))).toEqual({
        view: 'execution',
        workflowId: 'order-42',
        tab,
        history: PLAIN,
      });
  });

  it('round-trips every way of reading a history through a link', () => {
    for (const view of HISTORY_VIEWS) {
      const history: HistoryOptions = {view, events: 'timer'};
      expect(parseRoute(executionHref('order-42', {history}))).toEqual({
        view: 'execution',
        workflowId: 'order-42',
        tab: 'history',
        history,
      });
    }
  });
});
