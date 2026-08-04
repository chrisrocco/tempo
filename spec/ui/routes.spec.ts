/**
 * @fileoverview
 * What the dashboard's URLs mean. A contributor-facing spec: these are the
 * cases where a hash and a route stop agreeing — encoding, unknown values, and
 * the empty filter — and each one is a link that would silently show the wrong
 * thing rather than fail.
 *
 * Runs without a browser because `ui/routes.ts` touches no DOM, which is why it
 * is a separate module from `ui/router.ts`.
 */

import {
  executionHref,
  executionsHref,
  parseRoute,
  type RouteFilter,
} from '../../ui/routes';

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
    });
  });

  it('decodes a workflow id containing characters a URL reserves', () => {
    const id = 'orders/2024#q1 draft';
    expect(parseRoute(executionHref(id))).toEqual({
      view: 'execution',
      workflowId: id,
    });
  });

  it('keeps a malformed escape as written instead of throwing', () => {
    // `%` is legal in a caller-chosen workflow id, and decodeURIComponent
    // throws on a lone one. A blank page is the wrong answer to a bad link.
    expect(parseRoute('#/executions/100%bad')).toEqual({
      view: 'execution',
      workflowId: '100%bad',
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
    const route = parseRoute(executionsHref(filter));
    expect(route).toEqual({view: 'executions', filter});
  });
});
