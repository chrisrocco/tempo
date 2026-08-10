/**
 * @fileoverview
 * `down` against a recording `Host`.
 *
 * Two properties carry the weight. It **deletes nothing** — the failure it must
 * never have is an operator quieting a host and losing every execution's history
 * along with it. And it **reports rather than throws**, because "make sure this is
 * off" should be callable against a host where nothing was ever deployed.
 */

import 'jasmine';
import {ALL_UNITS, down} from '../../src/deploy';
import {fakeHost} from '../support/fake_host';

describe('down — stopping a deployment', () => {
  it('disables and stops every unit in one go', async () => {
    const host = fakeHost();
    const result = await down(host);

    expect(result.allDisabled).toBe(true);
    expect(result.units.map((u) => u.unit)).toEqual([...ALL_UNITS]);
    // `--now` is what makes disable mean "off" rather than "off next boot".
    for (const unit of ALL_UNITS)
      expect(
        host
          .commands()
          .some((c) => c.includes(`disable --now ${unit}.service`)),
      ).toBe(true);
  });

  /**
   * The reason this function is not called `remove`, and the reason it never grows
   * a `--purge`: `/var/lib/tempo` is every execution's history, and a verb that
   * pairs with `up` in muscle memory is the worst possible place to put "destroy
   * it". `down` then `up` is a pause, and running executions resume.
   */
  it('touches no files at all — not the artifacts, not the history', async () => {
    const host = fakeHost();
    await down(host);

    expect(host.callsOf('installFile')).toEqual([]);
    expect(host.callsOf('writeFile')).toEqual([]);
    expect(host.callsOf('makeDirectory')).toEqual([]);
    expect(host.commands().some((c) => c.includes('rm'))).toBe(false);
  });
});

describe('down — a host where nothing is deployed', () => {
  /**
   * An assembler should be able to offer "make sure this is off" without a `catch`
   * around it. A unit that was never installed is already off, which is the
   * outcome asked for.
   */
  it('reports an absent unit instead of throwing', async () => {
    const host = fakeHost({
      responses: [
        {
          match: 'disable --now tempo-worker-activity',
          result: {
            code: 1,
            stderr: 'Unit tempo-worker-activity.service not loaded.',
          },
        },
      ],
    });

    const result = await down(host);

    expect(result.allDisabled).toBe(false);
    const activity = result.units.find((u) =>
      u.unit.includes('worker-activity'),
    );
    expect(activity?.disabled).toBe(false);
    expect(activity?.detail).toContain('not loaded');
  });

  // One absent unit must not decide the fate of the others: a half-deployed host
  // is exactly where "turn everything off" needs to work.
  it('still stops the units that are there', async () => {
    const host = fakeHost({
      responses: [
        {
          match: 'disable --now tempo-server',
          result: {code: 1, stderr: 'not loaded'},
        },
      ],
    });

    const result = await down(host);

    expect(result.units.filter((u) => u.disabled).length).toBe(
      ALL_UNITS.length - 1,
    );
  });

  /**
   * It does not try to tell "was not installed" from "could not be stopped".
   * Both are a non-zero exit, the codes are not stable across systemd versions,
   * and guessing would eventually report a permissions failure as "already off" —
   * the one wrong answer that matters here. So the detail is passed through
   * uninterpreted.
   */
  it('passes systemd’s reason through without interpreting it', async () => {
    const host = fakeHost({
      responses: [
        {
          match: 'disable --now',
          result: {code: 1, stderr: 'Interactive authentication required.'},
        },
      ],
    });

    const result = await down(host);

    for (const unit of result.units) {
      expect(unit.disabled).toBe(false);
      expect(unit.detail).toBe('Interactive authentication required.');
    }
  });
});

describe('down — what it refuses', () => {
  it('refuses to run as root, which would address root’s units', async () => {
    const host = fakeHost({euid: 0});

    await expectAsync(down(host)).toBeRejectedWithError(/must not run as root/);
    expect(host.commands()).toEqual([]);
  });
});
