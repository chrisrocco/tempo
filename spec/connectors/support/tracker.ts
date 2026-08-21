/**
 * @fileoverview
 * The tracker connector from the worked example, defined against the framework
 * — with an in-memory fake of the Tracker service standing in for the real RPC
 * so the smoke test can run the full engine path without a network.
 *
 * Note what this file does NOT import: no Zod, nothing from the engine. The
 * schemas are `mini_schema` (any Standard Schema vendor would do), and the
 * engine only enters via the framework when a workflow calls `tracker.use()`.
 */

import {defineConnector, ops, ConnectorError} from '../../../src/connectors';
import {arr, lit, nul, num, obj, opt, str, type Infer} from './mini_schema';

/* ---------------------------- shapes ------------------------------------- */

const Status = lit('open', 'in_progress', 'resolved', 'closed');
export const Issue = obj({
  key: str(),
  projectKey: str(),
  summary: str(),
  status: Status,
  labels: arr(str()),
  externalId: nul(str()),
});
export type IssueT = Infer<typeof Issue>;

export const IssueTransitioned = obj({
  seq: num(),
  issueKey: str(),
  from: Status,
  to: Status,
});
export type IssueTransitionedT = Infer<typeof IssueTransitioned>;

/* ----------------------- the fake Tracker service ------------------------ */

export interface FakeTracker {
  issues: Map<string, IssueT>;
  events: IssueTransitionedT[];
  nextIssue: number;
  nextSeq: number;
  byExternalId(externalId: string): IssueT | undefined;
  /** Test hook: transition from "outside" (a human resolving the ticket). */
  forceTransition(issueKey: string, to: IssueT['status']): void;
}

export function createFakeTracker(): FakeTracker {
  const svc: FakeTracker = {
    issues: new Map(),
    events: [],
    nextIssue: 1,
    nextSeq: 1,
    byExternalId(externalId) {
      for (const issue of svc.issues.values()) {
        if (issue.externalId === externalId) return issue;
      }
      return undefined;
    },
    forceTransition(issueKey, to) {
      const issue = svc.issues.get(issueKey);
      if (!issue) throw new Error(`no issue ${issueKey}`);
      const from = issue.status;
      issue.status = to;
      svc.events.push({seq: svc.nextSeq++, issueKey, from, to});
    },
  };
  return svc;
}

/** Module-level singleton so the smoke test can reach in from the host side. */
export const fakeTracker = createFakeTracker();

/* ----------------------------- the connector ----------------------------- */

interface TrackerCtx {
  svc: FakeTracker;
}
const {query, command, trigger} = ops<TrackerCtx>();

export const tracker = defineConnector({
  name: 'tracker',
  title: 'Tracker',
  description:
    'Issues, transitions, and comments from the internal Tracker service.',
  config: obj({}), // the fake needs no credentials; a real one declares env keys here
  context: () => ({svc: fakeTracker}),

  queries: {
    getIssue: query({
      description: 'Fetch one issue by key.',
      input: obj({issueKey: str()}),
      output: Issue,
      handler: ({issueKey}, {svc}) => {
        const issue = svc.issues.get(issueKey);
        if (!issue)
          throw new ConnectorError('notFound', `no issue ${issueKey}`);
        return issue;
      },
    }),

    searchIssues: query({
      description: 'List issues in a project.',
      input: obj({projectKey: str(), status: opt(Status)}),
      output: arr(Issue),
      handler: ({projectKey, status}, {svc}) =>
        [...svc.issues.values()].filter(
          (i) =>
            i.projectKey === projectKey &&
            (status === undefined || i.status === status),
        ),
    }),
  },

  commands: {
    createIssue: command({
      description:
        'Create an issue. Upserts on externalId: same id, same issue.',
      idempotency: 'natural',
      input: obj({
        projectKey: str(),
        summary: str(),
        labels: opt(arr(str())),
        externalId: str(), // required: the caller names the business identity
      }),
      output: Issue,
      handler: (input, {svc}) => {
        const existing = svc.byExternalId(input.externalId);
        if (existing) return existing; // the upsert that makes this 'natural'
        const issue: IssueT = {
          key: `${input.projectKey}-${svc.nextIssue++}`,
          projectKey: input.projectKey,
          summary: input.summary,
          status: 'open',
          labels: input.labels ?? [],
          externalId: input.externalId,
        };
        svc.issues.set(issue.key, issue);
        return issue;
      },
    }),

    transitionIssue: command({
      description:
        'Move an issue to a status. Converges: already there is success.',
      idempotency: 'natural',
      input: obj({issueKey: str(), to: Status}),
      output: Issue,
      handler: ({issueKey, to}, {svc}) => {
        const issue = svc.issues.get(issueKey);
        if (!issue)
          throw new ConnectorError('notFound', `no issue ${issueKey}`);
        if (issue.status === to) return issue; // convergence: retry after success
        svc.forceTransition(issueKey, to);
        return issue;
      },
    }),

    addComment: command({
      description: 'Add a comment to an issue.',
      idempotency: 'unsafe',
      unsafeBecause:
        'Comments have no identity; a retry would post a duplicate. ' +
        'Revisit when keyed idempotency lands.',
      input: obj({issueKey: str(), body: str()}),
      output: obj({commentId: str()}),
      handler: ({issueKey}, {svc}) => {
        if (!svc.issues.has(issueKey)) {
          throw new ConnectorError('notFound', `no issue ${issueKey}`);
        }
        return {commentId: `c-${svc.nextSeq++}`};
      },
    }),
  },

  triggers: {
    issueTransitioned: trigger({
      description: 'An issue changed status.',
      event: IssueTransitioned,
      eventId: (e) => e.seq,
      filter: obj({issueKey: opt(str()), to: opt(Status)}),
      poll: ({cursor, filter}, {svc}) =>
        svc.events.filter(
          (e) =>
            (cursor === undefined || e.seq > (cursor as number)) &&
            (filter?.issueKey === undefined ||
              e.issueKey === filter.issueKey) &&
            (filter?.to === undefined || e.to === filter.to),
        ),
    }),
  },
});
