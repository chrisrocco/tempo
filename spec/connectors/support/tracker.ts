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

import {
  defineConnector,
  ops,
  t,
  ConnectorError,
  type InferOutput,
} from '../../../src/connectors';

/* ---------------------------- shapes ------------------------------------- */

const Status = t.enum('open', 'in_progress', 'resolved', 'closed');
export const Issue = t.object({
  key: t.string({description: 'The issue key, e.g. OPS-1.'}),
  projectKey: t.string(),
  summary: t.string(),
  status: Status,
  labels: t.array(t.string()),
  externalId: t.nullable(t.string()),
});
export type IssueT = InferOutput<typeof Issue>;

export const IssueTransitioned = t.object({
  seq: t.integer({description: "Monotonic — the watcher's cursor."}),
  issueKey: t.string(),
  from: Status,
  to: Status,
});
export type IssueTransitionedT = InferOutput<typeof IssueTransitioned>;

/* ----------------------- the fake Tracker service ------------------------ */

export interface FakeProject {
  key: string;
  name: string;
  labels: string[];
  createdAtMs: number;
  archived: boolean;
}

export interface FakeTracker {
  issues: Map<string, IssueT>;
  events: IssueTransitionedT[];
  projects: Map<string, FakeProject>;
  nextIssue: number;
  nextSeq: number;
  byExternalId(externalId: string): IssueT | undefined;
  /** Test hook: transition from "outside" (a human resolving the ticket). */
  forceTransition(issueKey: string, to: IssueT['status']): void;
  /** The fixture unit: projects are cheap, contain everything, and archive in one call. */
  createProject(props: {key: string; name: string; labels: string[]}): void;
  archiveProject(key: string): void;
  listProjects(q: {label?: string; createdBeforeMs?: number}): FakeProject[];
}

export function createFakeTracker(): FakeTracker {
  const svc: FakeTracker = {
    issues: new Map(),
    events: [],
    projects: new Map(),
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
    createProject({key, name, labels}) {
      svc.projects.set(key, {
        key,
        name,
        labels,
        createdAtMs: Date.now(),
        archived: false,
      });
    },
    archiveProject(key) {
      const project = svc.projects.get(key);
      if (!project) throw new Error(`no project ${key}`);
      project.archived = true;
    },
    listProjects({label, createdBeforeMs}) {
      return [...svc.projects.values()].filter(
        (p) =>
          !p.archived &&
          (label === undefined || p.labels.includes(label)) &&
          (createdBeforeMs === undefined || p.createdAtMs < createdBeforeMs),
      );
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
  config: t.object({}), // the fake needs no credentials; a real one declares env keys here
  context: () => ({svc: fakeTracker}),

  queries: {
    getIssue: query({
      description: 'Fetch one issue by key.',
      input: t.object({issueKey: t.string()}),
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
      input: t.object({projectKey: t.string(), status: t.optional(Status)}),
      output: t.array(Issue),
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
      input: t.object({
        projectKey: t.string(),
        summary: t.string(),
        // Optional for callers, present for handlers: In !== Out, carried by
        // the port and filled by the builder.
        labels: t.defaulted(t.array(t.string()), []),
        externalId: t.string(), // required: the caller names the business identity
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
          labels: input.labels,
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
      input: t.object({issueKey: t.string(), to: Status}),
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
        'Comments have no identity; a retry would post a duplicate. The ' +
        "service accepts no idempotency key either, so 'keyed' cannot help.",
      input: t.object({issueKey: t.string(), body: t.string()}),
      output: t.object({commentId: t.string()}),
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
      filter: t.object({
        issueKey: t.optional(t.string()),
        to: t.optional(Status),
      }),
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
