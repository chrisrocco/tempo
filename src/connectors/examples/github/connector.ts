/**
 * @fileoverview
 * The GitHub example connector — the reference to copy when authoring a new
 * one. A handful of operations, chosen because together they exercise every
 * decision the authoring guide describes:
 *
 * - `getIssue` / `listIssues` — queries, the bounded-list rule included.
 * - `closeIssue` — a `'natural'` command by *convergence-as-set*: PATCHing an
 *   already-closed issue to closed succeeds, so a retry after success is a
 *   no-op by the service's own semantics.
 * - `addLabels` — `'natural'` by *repeatability*: adding a label an issue
 *   already has changes nothing.
 * - `createIssue` — honestly **`'unsafe'`**: GitHub issue creation has no
 *   dedupe identity, so a retry could file a duplicate. One attempt, flagged,
 *   with the reason written down. This is what honesty looks like when a
 *   service lacks the capability — not a workaround.
 * - `issueClosed` — a trigger over the repository's issue-events feed, whose
 *   `id` is exactly what a cursor needs: stable and strictly increasing.
 *
 * Handlers are thin: one client call plus mapping to the declared shape. The
 * `toIssue` mapper is where "model what workflows read" happens — GitHub's
 * response is much larger, and `t.object` would strip the rest anyway, but
 * mapping explicitly keeps the declared schema and the produced value in one
 * obvious correspondence.
 */

import {defineConnector, ops, t} from '../../index';
import {createGithubRest, type GithubRest, type RawIssue} from './client';
import {Issue, IssueClosed, IssueState, repoRef, type IssueT} from './schemas';

const {query, command, trigger} = ops<{gh: GithubRest}>();

const toIssue = (raw: RawIssue): IssueT => ({
  number: raw.number,
  title: raw.title,
  state: raw.state,
  labels: raw.labels.map((label) => label.name),
  url: raw.html_url,
  createdAt: raw.created_at,
});

export const github = defineConnector({
  name: 'github',
  title: 'GitHub',
  description: 'Issues and issue events from the GitHub REST API.',

  config: t.object({
    GITHUB_TOKEN: t.string({description: 'A token with repo scope.'}),
    GITHUB_API_URL: t.defaulted(t.string(), 'https://api.github.com'),
  }),
  context: (cfg) => ({gh: createGithubRest(cfg)}),

  queries: {
    getIssue: query({
      description: 'Fetch one issue by number.',
      input: t.object({...repoRef, number: t.integer({min: 1})}),
      output: Issue,
      handler: async ({owner, repo, number}, {gh}) =>
        toIssue(await gh.issues.get(owner, repo, number)),
    }),

    listIssues: query({
      description:
        'List issues in a repository. Bounded: results ride workflow history.',
      input: t.object({
        ...repoRef,
        state: t.defaulted(IssueState, 'open'),
        label: t.optional(
          t.string({description: 'Only issues carrying this label.'}),
        ),
        limit: t.defaulted(t.integer({min: 1, max: 50}), 20),
      }),
      output: t.array(Issue),
      handler: async ({owner, repo, state, label, limit}, {gh}) => {
        const page = await gh.issues.list(owner, repo, {
          state,
          per_page: limit,
          ...(label !== undefined ? {labels: label} : {}),
        });
        // The classic gotcha: GitHub's issues list includes pull requests.
        return page
          .filter((raw) => raw.pull_request === undefined)
          .map(toIssue);
      },
    }),
  },

  commands: {
    createIssue: command({
      description: 'Open a new issue.',
      idempotency: 'unsafe',
      unsafeBecause:
        'GitHub issue creation has no dedupe identity, so a retry could file ' +
        'a duplicate. Revisit if GitHub adds an idempotency key, or when ' +
        'keyed idempotency lands.',
      input: t.object({
        ...repoRef,
        title: t.string({minLength: 1}),
        body: t.optional(t.string()),
        labels: t.defaulted(t.array(t.string()), []),
      }),
      output: Issue,
      handler: async ({owner, repo, title, body, labels}, {gh}) =>
        toIssue(
          await gh.issues.create(owner, repo, {
            title,
            labels,
            ...(body !== undefined ? {body} : {}),
          }),
        ),
    }),

    closeIssue: command({
      description: 'Close an issue. Closing an already-closed issue succeeds.',
      idempotency: 'natural',
      input: t.object({
        ...repoRef,
        number: t.integer({min: 1}),
        reason: t.defaulted(t.enum('completed', 'not_planned'), 'completed'),
      }),
      output: Issue,
      handler: async ({owner, repo, number, reason}, {gh}) =>
        toIssue(
          await gh.issues.update(owner, repo, number, {
            state: 'closed',
            state_reason: reason,
          }),
        ),
    }),

    addLabels: command({
      description:
        'Add labels to an issue. Adding a label it already has is a no-op.',
      idempotency: 'natural',
      input: t.object({
        ...repoRef,
        number: t.integer({min: 1}),
        labels: t.array(t.string({minLength: 1})),
      }),
      output: t.object({
        labels: t.array(t.string(), {
          description: 'All labels now on the issue.',
        }),
      }),
      handler: async ({owner, repo, number, labels}, {gh}) => ({
        labels: (await gh.issues.addLabels(owner, repo, number, labels)).map(
          (label) => label.name,
        ),
      }),
    }),
  },

  triggers: {
    issueClosed: trigger({
      description: 'An issue was closed.',
      event: IssueClosed,
      eventId: (e) => e.id,
      // owner/repo are REQUIRED here: a repository event feed has no default
      // repository, so every watch must say which one it polls.
      filter: t.object({
        ...repoRef,
        issueNumber: t.optional(t.integer({min: 1})),
      }),
      // One page per poll, filtered past the cursor and sorted ascending so
      // the strictly-increasing contract holds whatever order the wire used.
      // A production connector would paginate; see the folder README.
      poll: async ({cursor, filter}, {gh}) => {
        const [owner, repo] = filterRepo(filter);
        const events = await gh.events.listForRepo(owner, repo);
        return events
          .filter(
            (raw) =>
              raw.event === 'closed' &&
              raw.issue !== undefined &&
              (cursor === undefined || raw.id > (cursor as number)) &&
              (filter?.issueNumber === undefined ||
                raw.issue.number === filter.issueNumber),
          )
          .map((raw) => ({
            id: raw.id,
            issueNumber: raw.issue!.number,
            at: raw.created_at,
          }))
          .sort((a, b) => a.id - b.id);
      },
    }),
  },
});

/**
 * The trigger's filter carries the repository (required in its schema), but a
 * watch opened with no `where` at all reaches poll as `undefined` — fail that
 * loudly rather than polling nowhere.
 */
function filterRepo(
  filter: {owner: string; repo: string} | undefined,
): [string, string] {
  if (!filter) {
    throw new Error(
      'the issueClosed watcher needs where: {owner, repo} — a repository event feed has no default repository',
    );
  }
  return [filter.owner, filter.repo];
}
