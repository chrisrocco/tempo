/**
 * @fileoverview
 * The live-certification harness, both directions.
 *
 * Positive: the tracker fixture connector certifies clean — every operation
 * covered, the fixture project provisioned under the plan's namespace and
 * archived after, a planted stale project swept by the janitor, and recordings
 * captured for goldens. The "live service" is the in-memory fake, which is the
 * point of this spec: it proves the *harness machinery* in CI; proving a real
 * service is what the harness exists to do from a consumer's repo.
 *
 * Negative, in the same style as `spec/architecture.spec.ts`: each
 * certification is shown to catch the failure it exists for, on deliberately
 * broken connectors — a query leaking an undeclared key (schema truth), a
 * command that is not idempotent under double delivery (retry safety), a
 * trigger whose poll ignores its cursor (delivery truth), an unsafe command
 * offered a double-fire (refused at registration), and an uncovered operation
 * (the generated coverage case). A checker only tested against a codebase that
 * already passes checks nothing.
 *
 * Everything here builds and runs plans freely, with none of the registry
 * hygiene `connectors.spec.ts` needs: certification drives raw handlers, never
 * `use()`/`direct()`, so no plan touches the process-global registries.
 */

import {
  defineConnector,
  ops,
  planLiveSuite,
  runLivePlan,
  type LiveFixtures,
} from '../../src/connectors';
import {num, obj, str} from '../support/mini_schema';
import {fakeTracker, tracker} from './support/tracker';
import {
  FIXTURE_LABEL,
  trackerFixtures,
  type TrackerFx,
} from './support/tracker_fixtures';

/** For planted connectors that certify no real service state. */
const noFixtures: LiveFixtures<Record<string, never>> = {
  provision: () => ({}),
  destroy: () => undefined,
  sweep: () => 0,
};

describe('connectors live harness — certifying the tracker connector', () => {
  it('certifies every operation, provisions and destroys its fixture, and sweeps leaks', async () => {
    // A leak from a "crashed run": old enough that the janitor must take it.
    fakeTracker.createProject({
      key: 'CXSTALE',
      name: `${FIXTURE_LABEL} stale`,
      labels: [FIXTURE_LABEL],
    });
    fakeTracker.projects.get('CXSTALE')!.createdAtMs -= 48 * 60 * 60 * 1_000;

    const plan = planLiveSuite(tracker, trackerFixtures, (t) => {
      t.query('getIssue', async ({direct, fx, uniqueId}) => {
        const made = await direct.command.createIssue({
          projectKey: fx.projectKey,
          summary: 'schema truth',
          externalId: uniqueId('schema'),
        });
        return {issueKey: made.key};
      });

      t.query('searchIssues', ({fx}: {fx: TrackerFx}) => ({
        projectKey: fx.projectKey,
      }));

      t.command('createIssue', {
        act: ({direct, fx, key}) =>
          direct.command.createIssue({
            projectKey: fx.projectKey,
            summary: 'exactly one of me',
            externalId: key,
          }),
        probe: async ({direct, fx, key}) => ({
          effects: (
            await direct.query.searchIssues({projectKey: fx.projectKey})
          ).filter((issue) => issue.externalId === key).length,
        }),
      });

      t.command('transitionIssue', {
        setup: ({direct, fx, uniqueId}) =>
          direct.command.createIssue({
            projectKey: fx.projectKey,
            summary: 'converge on me',
            externalId: uniqueId('tr'),
          }),
        act: ({direct}, issue) =>
          direct.command.transitionIssue({issueKey: issue.key, to: 'resolved'}),
        probe: async ({direct}, issue) => ({
          effects:
            (await direct.query.getIssue({issueKey: issue.key})).status ===
            'resolved'
              ? 1
              : 0,
        }),
      });

      t.trigger('issueTransitioned', {
        cause: async ({direct, fx, uniqueId}) => {
          const issue = await direct.command.createIssue({
            projectKey: fx.projectKey,
            summary: 'watch me',
            externalId: uniqueId('ev'),
          });
          await direct.command.transitionIssue({
            issueKey: issue.key,
            to: 'resolved',
          });
          return issue;
        },
        filter: () => ({to: 'resolved'}),
        expect: (event, issue) => event.issueKey === issue.key,
      });
    });

    const failures = await runLivePlan(plan);
    expect(failures).toEqual([]);

    // Six cases ran: five certifications plus the generated coverage case.
    expect(plan.cases.length).toBe(6);

    // Goldens captured for stubs and catalogue samples.
    const recorded = plan.recordings();
    expect(recorded['getIssue']).toBeDefined();
    expect(recorded['searchIssues']).toBeDefined();
    expect(recorded['issueTransitioned']).toBeDefined();

    // The fixture lifecycle: this run's project archived, the leak swept.
    const open = fakeTracker.listProjects({label: FIXTURE_LABEL});
    expect(open).toEqual([]);
  });

  it('refuses a double-fire block for an unsafe command, at registration', () => {
    expect(() =>
      planLiveSuite(tracker, trackerFixtures, (t) => {
        t.command('addComment', {
          act: ({direct, key}) =>
            direct.command.addComment({issueKey: 'OPS-1', body: key}),
          probe: () => ({effects: 1}),
        });
      }),
    ).toThrowError(/unsafe.*refuses the double-fire/);
  });

  it('refuses an operation name the connector does not have', () => {
    expect(() =>
      planLiveSuite(tracker, trackerFixtures, (t) => {
        t.query('getInvoice' as never, () => ({}) as never);
      }),
    ).toThrowError(/no query 'getInvoice'.*getIssue/);
  });

  it('fails the generated coverage case naming every uncertified operation', async () => {
    const plan = planLiveSuite(tracker, trackerFixtures, () => {});
    const failures = await runLivePlan(plan);
    expect(failures.length).toBe(1);
    expect(failures[0]!.name).toContain('coverage');
    for (const owed of [
      'getIssue',
      'searchIssues',
      'createIssue',
      'transitionIssue',
      'issueTransitioned',
    ]) {
      expect(failures[0]!.message).toContain(owed);
    }
    // addComment is unsafe: exempt, so certifying nothing does not owe it.
    expect(failures[0]!.message).not.toContain('addComment');
  });
});

describe('connectors live harness — each certification catches its failure', () => {
  it('schema truth: a response carrying an undeclared key fails, by path', async () => {
    const {query} = ops<Record<string, never>>();
    const leaky = defineConnector({
      name: 'leaky',
      description: 'Declares {id}; returns more.',
      config: obj({}),
      context: () => ({}),
      queries: {
        getThing: query({
          description: 'Fetch the thing.',
          input: obj({}),
          output: obj({id: str()}),
          handler: () => ({id: 'thing-1', debug: 'oops'}) as never,
        }),
      },
    });

    const plan = planLiveSuite(leaky, noFixtures, (t) => {
      t.query('getThing', () => ({}));
    });
    const failures = await runLivePlan(plan);
    expect(failures.length).toBe(1);
    expect(failures[0]!.message).toContain('schema truth');
    expect(failures[0]!.message).toContain('undeclared keys: $.debug');
  });

  it('retry safety: a command that is not idempotent fails the double-fire', async () => {
    const pings: string[] = [];
    const {command} = ops<Record<string, never>>();
    const pinger = defineConnector({
      name: 'pinger',
      description: 'Claims natural; is not.',
      config: obj({}),
      context: () => ({}),
      commands: {
        sendPing: command({
          description: 'Send a ping.',
          idempotency: 'natural', // the lie the harness exists to catch
          input: obj({key: str()}),
          output: obj({sent: num()}),
          handler: ({key}) => {
            pings.push(key);
            return {sent: pings.length};
          },
        }),
      },
    });

    const plan = planLiveSuite(pinger, noFixtures, (t) => {
      t.command('sendPing', {
        act: ({direct, key}) => direct.command.sendPing({key}),
        probe: ({key}) => ({
          effects: pings.filter((ping) => ping === key).length,
        }),
      });
    });
    const failures = await runLivePlan(plan);
    expect(failures.length).toBe(1);
    expect(failures[0]!.message).toContain('retry safety');
    expect(failures[0]!.message).toContain('2 effects');
  });

  it('delivery truth: a poll that ignores its cursor fails once the cursor advances', async () => {
    const events: {seq: number; what: string}[] = [];
    const {command, trigger} = ops<Record<string, never>>();
    const noisy = defineConnector({
      name: 'noisy',
      description: 'An event feed that ignores cursors.',
      config: obj({}),
      context: () => ({}),
      commands: {
        emit: command({
          description: 'Emit an event.',
          idempotency: 'natural',
          input: obj({what: str()}),
          output: obj({seq: num()}),
          handler: ({what}) => {
            const seq = events.length + 1;
            events.push({seq, what});
            return {seq};
          },
        }),
      },
      triggers: {
        thingHappened: trigger({
          description: 'Something happened.',
          event: obj({seq: num(), what: str()}),
          eventId: (event) => event.seq,
          poll: () => [...events], // the bug: `cursor` is never read
        }),
      },
    });

    const plan = planLiveSuite(noisy, noFixtures, (t) => {
      t.trigger('thingHappened', {
        cause: async ({direct}) => direct.command.emit({what: 'boom'}),
        expect: (event, caused) => event.seq === caused.seq,
      });
    });
    const failures = await runLivePlan(plan);
    const delivery = failures.find((f) => f.name.includes('thingHappened'));
    expect(delivery).toBeDefined();
    expect(delivery!.message).toContain('delivery truth');
    expect(delivery!.message).toContain('cursor');
  });
});
