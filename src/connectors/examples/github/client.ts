/**
 * @fileoverview
 * Raw GitHub REST transport — the only file in this connector that knows the
 * wire. Base URL and token come from the config object (never `process.env`),
 * every function is one HTTP call returning parsed JSON, and the single
 * `mapError` below is the connector's whole error policy. No schemas, no
 * validation, no retry, no sleep: the engine owns retry, and validation
 * belongs to the definition.
 *
 * The raw response interfaces here are *types*, not schemas — the minimal
 * shape of what GitHub actually sends, so `connector.ts` can map to its
 * declared outputs with the compiler watching.
 */

import {ConnectorError} from '../../index';

export interface GithubConfig {
  readonly GITHUB_TOKEN: string;
  readonly GITHUB_API_URL: string;
}

/** An issue as the wire sends it — only the fields this connector reads. */
export interface RawIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  labels: {name: string}[];
  /** Present when the "issue" is actually a pull request — see listIssues. */
  pull_request?: unknown;
}

/** An issue event as the wire sends it. */
export interface RawIssueEvent {
  id: number;
  event: string;
  created_at: string;
  issue?: {number: number};
}

export interface RawLabel {
  name: string;
}

export function createGithubRest(cfg: GithubConfig) {
  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${cfg.GITHUB_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub rejects requests without one.
        'user-agent': 'tempo-connectors-example',
        ...(body !== undefined ? {'content-type': 'application/json'} : {}),
      },
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
    if (!response.ok) throw await mapError(response);
    // DELETE and some PATCHes answer 204 with no body.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    issues: {
      get: (owner: string, repo: string, number: number) =>
        call<RawIssue>('GET', `/repos/${owner}/${repo}/issues/${number}`),
      list: (
        owner: string,
        repo: string,
        q: {state: string; labels?: string; per_page: number},
      ) => {
        const params = new URLSearchParams({
          state: q.state,
          per_page: String(q.per_page),
        });
        if (q.labels !== undefined) params.set('labels', q.labels);
        return call<RawIssue[]>(
          'GET',
          `/repos/${owner}/${repo}/issues?${params}`,
        );
      },
      create: (
        owner: string,
        repo: string,
        props: {title: string; body?: string; labels?: readonly string[]},
      ) => call<RawIssue>('POST', `/repos/${owner}/${repo}/issues`, props),
      update: (
        owner: string,
        repo: string,
        number: number,
        patch: {state?: 'open' | 'closed'; state_reason?: string},
      ) =>
        call<RawIssue>(
          'PATCH',
          `/repos/${owner}/${repo}/issues/${number}`,
          patch,
        ),
      addLabels: (
        owner: string,
        repo: string,
        number: number,
        labels: readonly string[],
      ) =>
        call<RawLabel[]>(
          'POST',
          `/repos/${owner}/${repo}/issues/${number}/labels`,
          {labels},
        ),
    },
    events: {
      /** Issue events for the whole repository, one page. */
      listForRepo: (owner: string, repo: string) =>
        call<RawIssueEvent[]>(
          'GET',
          `/repos/${owner}/${repo}/issues/events?per_page=100`,
        ),
    },
    labels: {
      list: (owner: string, repo: string) =>
        call<RawLabel[]>('GET', `/repos/${owner}/${repo}/labels?per_page=100`),
      delete: (owner: string, repo: string, name: string) =>
        call<undefined>(
          'DELETE',
          `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
        ),
    },
  };
}

export type GithubRest = ReturnType<typeof createGithubRest>;

/**
 * The whole error policy of the connector, in one place:
 * 401 denied · 403 denied — except an exhausted rate limit, which is
 * `unavailable` because waiting fixes it · 404 notFound · 409 conflict ·
 * 422 invalid (GitHub's validation status) · 429 unavailable · 5xx upstream.
 */
async function mapError(response: Response): Promise<ConnectorError> {
  const detail = (await response.text()).slice(0, 200);
  const status = response.status;
  if (status === 401) return new ConnectorError('denied', detail);
  if (status === 403) {
    return response.headers.get('x-ratelimit-remaining') === '0'
      ? new ConnectorError('unavailable', 'rate limit exhausted')
      : new ConnectorError('denied', detail);
  }
  if (status === 404) return new ConnectorError('notFound', detail);
  if (status === 409) return new ConnectorError('conflict', detail);
  if (status === 400 || status === 422)
    return new ConnectorError('invalid', detail);
  if (status === 429) return new ConnectorError('unavailable', detail);
  if (status >= 500) return new ConnectorError('upstream', detail);
  return new ConnectorError('upstream', `unexpected status ${status}`);
}
