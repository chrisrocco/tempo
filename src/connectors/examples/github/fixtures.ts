/**
 * @fileoverview
 * The GitHub example's fixture protocol. The connector's one testing question
 * — *what is your disposable container?* — answered: **marked issues in a
 * dedicated fixture repository.** Certification never creates repositories;
 * it creates issues inside a repo you designate, every one carrying two
 * sweepable markers: a `cnx-test-{ns}` label and a `[cnx-test-{ns}]` title
 * prefix (two, because labels can be deleted out from under an issue and a
 * title cannot).
 *
 * A factory rather than a constant: fixtures are test-side code, but even
 * here `process.env` stays out of connector folders — the live spec resolves
 * the environment once and passes it in.
 */

import type {LiveFixtures} from '../../index';
import {createGithubRest, type GithubRest} from './client';

export interface GithubFx {
  readonly owner: string;
  readonly repo: string;
  /** The label + title marker every fixture issue carries. */
  readonly marker: string;
}

const MARKER_PREFIX = 'cnx-test-';

export function githubFixtures(env: {
  token: string;
  apiUrl?: string;
  /** `owner/repo` of the dedicated fixture repository. */
  fixtureRepo: string;
}): LiveFixtures<GithubFx> {
  const [owner, repo] = splitRepo(env.fixtureRepo);
  const gh: GithubRest = createGithubRest({
    GITHUB_TOKEN: env.token,
    GITHUB_API_URL: env.apiUrl ?? 'https://api.github.com',
  });

  async function closeMarked(marker: string): Promise<void> {
    const open = await gh.issues.list(owner, repo, {
      state: 'open',
      labels: marker,
      per_page: 100,
    });
    for (const issue of open) {
      await gh.issues.update(owner, repo, issue.number, {state: 'closed'});
    }
  }

  return {
    // The label is created implicitly by the first issue that carries it;
    // provisioning only names the namespace this run owns.
    provision: (ns) => ({owner, repo, marker: `${MARKER_PREFIX}${ns}`}),

    async destroy(ns) {
      const marker = `${MARKER_PREFIX}${ns}`;
      await closeMarked(marker);
      // Best effort — the sweep covers a failure here.
      await gh.labels.delete(owner, repo, marker).catch(() => undefined);
    },

    async sweep(olderThanMs) {
      // Issues: the title marker survives label deletion, so sweep by it.
      const cutoff = Date.now() - olderThanMs;
      const open = await gh.issues.list(owner, repo, {
        state: 'open',
        per_page: 100,
      });
      let swept = 0;
      for (const issue of open) {
        if (!issue.title.startsWith(`[${MARKER_PREFIX}`)) continue;
        if (new Date(issue.created_at).getTime() >= cutoff) continue;
        await gh.issues.update(owner, repo, issue.number, {state: 'closed'});
        swept++;
      }
      // Leaked labels have no timestamp; any cnx-test-* label whose issues
      // are gone is safe to drop, and dropping one still in use only unlabels.
      for (const label of await gh.labels.list(owner, repo)) {
        if (label.name.startsWith(MARKER_PREFIX)) {
          await gh.labels
            .delete(owner, repo, label.name)
            .catch(() => undefined);
        }
      }
      return swept;
    },
  };
}

function splitRepo(fixtureRepo: string): [string, string] {
  const parts = fixtureRepo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`fixtureRepo must be 'owner/repo', got '${fixtureRepo}'`);
  }
  return [parts[0], parts[1]];
}
