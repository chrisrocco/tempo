/**
 * @fileoverview
 * The live-certification registrations — one per operation, exactly what the
 * authoring guide's step 6 prescribes. In a consumer repo this file is your
 * `github.live.spec.ts`; here it exports a plan factory so tempo's own suite
 * can build the plan without a network (catalogue and coverage checks run in
 * CI) and execute it only when credentials are present.
 *
 * Note what is and is not certified: `createIssue` is `'unsafe'`, so it gets
 * **no** double-fire block — the harness would refuse one — and the coverage
 * case does not owe it. The natural commands are the ones fired twice.
 */

import {planLiveSuite, type LivePlan} from '../../index';
import {github} from './connector';
import {githubFixtures} from './fixtures';

export function githubLivePlan(env: {
  token: string;
  fixtureRepo: string;
  apiUrl?: string;
}): LivePlan {
  return planLiveSuite(github, githubFixtures(env), (s) => {
    s.query('getIssue', async ({direct, fx, uniqueId}) => {
      const made = await direct.command.createIssue({
        owner: fx.owner,
        repo: fx.repo,
        title: `[${fx.marker}] schema truth ${uniqueId('q')}`,
        labels: [fx.marker],
      });
      return {owner: fx.owner, repo: fx.repo, number: made.number};
    });

    s.query('listIssues', ({fx}) => ({
      owner: fx.owner,
      repo: fx.repo,
      label: fx.marker,
    }));

    s.command('closeIssue', {
      setup: ({direct, fx, uniqueId}) =>
        direct.command.createIssue({
          owner: fx.owner,
          repo: fx.repo,
          title: `[${fx.marker}] converge ${uniqueId('c')}`,
          labels: [fx.marker],
        }),
      // Fired twice: closing an already-closed issue must succeed.
      act: ({direct, fx}, issue) =>
        direct.command.closeIssue({
          owner: fx.owner,
          repo: fx.repo,
          number: issue.number,
        }),
      probe: async ({direct, fx}, issue) => ({
        effects:
          (
            await direct.query.getIssue({
              owner: fx.owner,
              repo: fx.repo,
              number: issue.number,
            })
          ).state === 'closed'
            ? 1
            : 0,
      }),
    });

    s.command('addLabels', {
      setup: ({direct, fx, uniqueId}) =>
        direct.command.createIssue({
          owner: fx.owner,
          repo: fx.repo,
          title: `[${fx.marker}] labels ${uniqueId('l')}`,
          labels: [fx.marker],
        }),
      // ctx.key is the label: added twice, it must appear exactly once.
      act: ({direct, fx, key}, issue) =>
        direct.command.addLabels({
          owner: fx.owner,
          repo: fx.repo,
          number: issue.number,
          labels: [key],
        }),
      probe: async ({direct, fx, key}, issue) => ({
        effects: (
          await direct.query.getIssue({
            owner: fx.owner,
            repo: fx.repo,
            number: issue.number,
          })
        ).labels.filter((label) => label === key).length,
      }),
    });

    s.trigger('issueClosed', {
      cause: async ({direct, fx, uniqueId}) => {
        const issue = await direct.command.createIssue({
          owner: fx.owner,
          repo: fx.repo,
          title: `[${fx.marker}] watch me ${uniqueId('ev')}`,
          labels: [fx.marker],
        });
        await direct.command.closeIssue({
          owner: fx.owner,
          repo: fx.repo,
          number: issue.number,
        });
        return issue;
      },
      filter: ({fx}) => ({owner: fx.owner, repo: fx.repo}),
      expect: (event, issue) => event.issueNumber === issue.number,
    });
  });
}
