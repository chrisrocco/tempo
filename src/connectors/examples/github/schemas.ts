/**
 * @fileoverview
 * The shapes this connector's operations and tests share. Everything is `t`,
 * every field carries a `description` (the dashboard renders it as field
 * help), timestamps are ISO strings, and the shapes model what workflows
 * read — not everything GitHub returns.
 *
 * `repoRef` is a plain record of schemas, spread into each input shape —
 * the pattern for sharing a group of fields without inventing a merge
 * operator.
 */

import {t, type InferOutput} from '../../index';

/** Spread into every input: which repository the operation addresses. */
export const repoRef = {
  owner: t.string({description: 'The repository owner (user or org).'}),
  repo: t.string({description: 'The repository name.'}),
};

export const IssueState = t.enum('open', 'closed');

export const Issue = t.object({
  number: t.integer({min: 1, description: 'The issue number.'}),
  title: t.string({description: 'The issue title.'}),
  state: IssueState,
  labels: t.array(t.string(), {description: 'Label names on the issue.'}),
  url: t.string({format: 'uri', description: 'The issue on github.com.'}),
  createdAt: t.string({
    format: 'date-time',
    description: 'When the issue was opened.',
  }),
});
export type IssueT = InferOutput<typeof Issue>;

export const IssueClosed = t.object({
  id: t.integer({
    description: "The event id — stable and ordered; the watcher's cursor.",
  }),
  issueNumber: t.integer({description: 'The issue that was closed.'}),
  at: t.string({format: 'date-time', description: 'When it closed.'}),
});
export type IssueClosedT = InferOutput<typeof IssueClosed>;
