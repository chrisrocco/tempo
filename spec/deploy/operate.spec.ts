/**
 * @fileoverview
 * `restart` and `logs` — what an operator does to a deployment that already
 * exists.
 *
 * Both exist because of the question `status` provokes. It says a unit is `failed`
 * and has restarted forty times; the next question is always "why", which is a
 * log, and then "make it stop", which is a restart. Without these, an assembled
 * tool has to hand the operator back to `journalctl` and retype the unit names it
 * already knows.
 */

import 'jasmine';
import {ALL_UNITS, logs, restart, unitsFor} from '../../src/deploy';
import {fakeHost} from '../support/fake_host';

describe('restart — bouncing without redeploying', () => {
  /**
   * The distinction that makes this worth its own function: `up` is a deploy and
   * takes artifact paths, so reaching for it to bounce a wedged worker would
   * reinstall from whatever paths happened to be at hand.
   */
  it('touches nothing that is installed', async () => {
    const host = fakeHost();
    await restart('all', host);

    expect(host.callsOf('installFile')).toEqual([]);
    expect(host.callsOf('writeFile')).toEqual([]);
    expect(host.callsOf('makeDirectory')).toEqual([]);
    expect(host.commands().some((c) => c.includes('daemon-reload'))).toBe(
      false,
    );
  });

  it('restarts every unit, server first', async () => {
    const host = fakeHost();
    const result = await restart('all', host);

    expect(result.units).toEqual([...ALL_UNITS]);
    expect(host.commands()).toEqual(
      ALL_UNITS.map((u) => `systemctl restart ${u}.service`),
    );
  });

  it('restarts one tier when asked for one', async () => {
    const host = fakeHost();
    const result = await restart('activity', host);

    expect(result.units).toEqual(['tempo-worker-activity']);
    expect(host.commands()).toEqual([
      'systemctl restart tempo-worker-activity.service',
    ]);
  });

  it('fails loudly when systemd refuses', async () => {
    const host = fakeHost({
      responses: [
        {match: 'restart', result: {code: 1, stderr: 'Unit not found'}},
      ],
    });

    await expectAsync(restart('server', host)).toBeRejectedWithError(
      /restart tempo-server\.service failed \(exit 1\): Unit not found/,
    );
  });

  // Restarting the server and then failing on the workers leaves a deployment
  // half-bounced, so the refusal comes first.
  it('refuses without root before restarting anything', async () => {
    const host = fakeHost({euid: 1000});

    await expectAsync(restart('all', host)).toBeRejectedWithError(
      /must run as root.*effective uid 1000/s,
    );
    expect(host.commands()).toEqual([]);
  });
});

describe('restart — which units a target names', () => {
  it('names the server first when it names the server at all', () => {
    expect(unitsFor('all')[0]).toBe('tempo-server');
  });

  it('maps each role to its own unit', () => {
    expect(unitsFor('server')).toEqual(['tempo-server']);
    expect(unitsFor('workflow')).toEqual(['tempo-worker-workflow']);
    expect(unitsFor('activity')).toEqual(['tempo-worker-activity']);
  });
});

describe('logs — reading what a service said', () => {
  const journal = {
    match: 'journalctl',
    result: {
      stdout:
        '2026-08-09T14:00:01+0000 host tempo[1]: WORKER_READY greeter activity default\n' +
        '2026-08-09T14:00:02+0000 host tempo[1]: {"event":"worker.poll_failed"}\n',
    },
  };

  it('returns the lines oldest first, which is reading order', async () => {
    const host = fakeHost({responses: [journal]});
    const [log] = await logs({target: 'activity'}, host);

    expect(log?.unit).toBe('tempo-worker-activity');
    expect(log?.lines[0]).toContain('WORKER_READY');
    expect(log?.lines[1]).toContain('poll_failed');
  });

  /**
   * Per unit rather than one interleaved stream: an activity worker's stack trace
   * and the server's lease bookkeeping are different subjects, and merging them by
   * timestamp buries the one you came for.
   */
  it('keeps each unit’s log separate, and covers all of them by default', async () => {
    const host = fakeHost({responses: [journal]});
    const all = await logs({}, host);

    expect(all.map((l) => l.unit)).toEqual([...ALL_UNITS]);
  });

  it('asks journald not to page or colour, since nobody is at a terminal', async () => {
    const host = fakeHost({responses: [journal]});
    await logs({target: 'server'}, host);

    expect(host.commands()[0]).toContain('--no-pager');
    expect(host.commands()[0]).toContain('--unit tempo-server.service');
  });

  it('defaults to a bounded number of lines rather than the whole journal', async () => {
    const host = fakeHost({responses: [journal]});
    await logs({target: 'server'}, host);

    expect(host.commands()[0]).toContain('--lines 100');
  });

  it('passes a since expression through in journald’s own grammar', async () => {
    const host = fakeHost({responses: [journal]});
    await logs({target: 'server', since: '10 min ago', lines: 5}, host);

    expect(host.commands()[0]).toContain('--since 10 min ago');
    expect(host.commands()[0]).toContain('--lines 5');
  });

  // A service that has never run is an empty log, not an error.
  it('reads a journal with no entries as an empty log', async () => {
    const host = fakeHost({
      responses: [
        {match: 'journalctl', result: {stdout: '-- No entries --\n'}},
      ],
    });
    const [log] = await logs({target: 'server'}, host);

    expect(log?.lines).toEqual([]);
  });

  // The one operation here that an operator can run before reaching for sudo.
  it('needs no root', async () => {
    const host = fakeHost({euid: 1000, responses: [journal]});

    await expectAsync(logs({target: 'server'}, host)).toBeResolved();
  });
});
