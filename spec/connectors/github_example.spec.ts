/**
 * @fileoverview
 * The GitHub example connector, verified two ways.
 *
 * Without credentials (CI's normal state), everything that needs no network:
 * the catalogue renders every operation with descriptions, the unsafe command
 * carries its reason, and the live plan registers **full coverage** — the
 * generated coverage case is runnable without setup, so "every operation is
 * certified or exempt" is checked on every commit even though the
 * certifications themselves need GitHub.
 *
 * With `GITHUB_TOKEN` and `GITHUB_FIXTURE_REPO` set, the same plan runs for
 * real: fixtures provisioned in the fixture repository, natural commands
 * double-fired, the issue-events cursor replayed. That run is the example
 * being a *working* example rather than a plausible one.
 */

import {catalogue} from '../../src/connectors';
import {runLivePlan} from '../../src/connectors';
import {github} from '../../src/connectors/examples/github/connector';
import {githubLivePlan} from '../../src/connectors/examples/github/github.live';

describe('connectors — the github example', () => {
  it('renders a complete catalogue: descriptions everywhere, unsafe flagged', () => {
    const entries = catalogue([github]);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'addLabels',
      'closeIssue',
      'createIssue',
      'getIssue',
      'issueClosed',
      'listIssues',
    ]);
    for (const entry of entries) {
      expect(entry.description)
        .withContext(`${entry.name} has no description`)
        .toBeTruthy();
    }
    const create = entries.find((entry) => entry.name === 'createIssue');
    expect(create?.idempotency).toBe('unsafe');
    expect(create?.unsafeBecause).toContain('no dedupe identity');
    const trig = entries.find((entry) => entry.kind === 'trigger');
    expect(trig?.name).toBe('issueClosed');
    expect(trig?.event).toBeDefined();
    expect(trig?.filter).toBeDefined();
  });

  it('registers full live coverage — the generated case passes without a network', async () => {
    // Dummy credentials: building a plan touches nothing; only setup() would.
    const plan = githubLivePlan({token: 'unused', fixtureRepo: 'o/r'});
    const coverage = plan.cases[plan.cases.length - 1]!;
    expect(coverage.name).toContain('coverage');
    await coverage.run(); // throws if any operation were left uncertified
  });

  const token = process.env['GITHUB_TOKEN'];
  const fixtureRepo = process.env['GITHUB_FIXTURE_REPO'];
  if (token && fixtureRepo) {
    it('certifies against live GitHub', async () => {
      const failures = await runLivePlan(githubLivePlan({token, fixtureRepo}));
      expect(failures).toEqual([]);
    }, 120_000);
  } else {
    it('certifies against live GitHub (needs credentials)', () => {
      pending('set GITHUB_TOKEN and GITHUB_FIXTURE_REPO to run');
    });
  }
});
