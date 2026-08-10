/**
 * @fileoverview
 * `up` against a recording `Host`.
 *
 * What is pinned here is the **order and completeness of the sequence**, because
 * every way of getting it wrong produces a deployment that reports success:
 *
 * - no `daemon-reload` — systemd keeps serving the unit it last loaded, so a
 *   changed `ExecStart` is silently ignored;
 * - no `enable` — everything is green until the first reboot, and then gone;
 * - no `restart` — the old artifact keeps serving after a "successful" deploy;
 * - a root check after the first write — a partial deploy instead of a refusal.
 *
 * None of these can be caught by running `up` and seeing whether it threw, which
 * is why the sequence itself is the assertion.
 */

import 'jasmine';
import {
  ALL_UNITS,
  SERVER_ARTIFACT,
  WORKER_ARTIFACT,
  unitPath,
  up,
} from '../../src/deploy';
import {DEFAULT_PORT} from '../../src/process_flags';
import {fakeHost, type FakeHost} from '../support/fake_host';

const artifacts = {server: 'out/server.js', worker: 'out/worker.js'};

/** Index of the first recorded command containing `fragment`. */
function commandIndex(host: FakeHost, fragment: string): number {
  return host.commands().findIndex((c) => c.includes(fragment));
}

describe('up — the deploy sequence', () => {
  it('installs both artifacts and writes all three units', async () => {
    const host = fakeHost();
    const result = await up(artifacts, host);

    expect(result.installed).toEqual([SERVER_ARTIFACT, WORKER_ARTIFACT]);
    expect(result.units).toEqual([...ALL_UNITS]);
    for (const unit of ALL_UNITS)
      expect(host.written.has(unitPath(unit))).toBe(true);
  });

  it('copies the artifacts through the install seam, not by writing them', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    // `installFile` is what dereferences a symlink and renames atomically; a
    // `writeFile` of the artifact would quietly lose both properties.
    expect(host.callsOf('installFile')).toEqual([
      {kind: 'installFile', target: 'out/server.js', detail: SERVER_ARTIFACT},
      {kind: 'installFile', target: 'out/worker.js', detail: WORKER_ARTIFACT},
    ]);
  });

  it('creates the install root before installing into it', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const kinds = host.calls.map((c) => c.kind);
    expect(kinds.indexOf('makeDirectory')).toBeLessThan(
      kinds.indexOf('installFile'),
    );
  });

  /**
   * The failure this ordering prevents is the quietest one available: systemd
   * serves the unit it last loaded, so restarting before reloading restarts the
   * *old* command line and every check afterwards passes.
   */
  it('reloads systemd before enabling or restarting anything', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const reload = commandIndex(host, 'daemon-reload');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(reload).toBeLessThan(commandIndex(host, 'enable'));
    expect(reload).toBeLessThan(commandIndex(host, 'restart'));
  });

  it('writes every unit file before reloading systemd', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const lastWrite = host.calls.reduce(
      (last, call, i) => (call.kind === 'writeFile' ? i : last),
      -1,
    );
    const reload = host.calls.findIndex(
      (c) => c.kind === 'run' && c.detail === 'daemon-reload',
    );
    expect(lastWrite).toBeGreaterThanOrEqual(0);
    expect(lastWrite).toBeLessThan(reload);
  });

  // Invisible for exactly as long as nobody reboots.
  it('enables all three units, so a reboot brings the deployment back', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const enable = host.commands().find((c) => c.includes('enable'));
    for (const unit of ALL_UNITS) expect(enable).toContain(`${unit}.service`);
  });

  /**
   * Nothing rereads a `.js` file in place, so the restart *is* the deployment.
   * Server first, so the workers reconnect to something coming up rather than
   * spending their first backoff on something going down.
   */
  it('restarts every unit, server first', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const restarts = host
      .commands()
      .filter((c) => c.includes('restart'))
      .map((c) => c.replace(/.*restart /, '').replace('.service', ''));
    expect(restarts).toEqual([...ALL_UNITS]);
  });
});

describe('up — the service user', () => {
  it('creates the service user when it does not exist', async () => {
    const host = fakeHost({
      responses: [{match: 'id -u tempo', result: {code: 1}}],
    });
    const result = await up(artifacts, host);

    expect(result.createdUser).toBe(true);
    expect(host.commands().some((c) => c.startsWith('useradd'))).toBe(true);
  });

  it('leaves an existing service user alone', async () => {
    const host = fakeHost({
      responses: [{match: 'id -u tempo', result: {code: 0, stdout: '999\n'}}],
    });
    const result = await up(artifacts, host);

    expect(result.createdUser).toBe(false);
    expect(host.commands().some((c) => c.startsWith('useradd'))).toBe(false);
  });

  it('creates the user before the units that name it are started', async () => {
    const host = fakeHost({
      responses: [{match: 'id -u tempo', result: {code: 1}}],
    });
    await up(artifacts, host);

    expect(commandIndex(host, 'useradd')).toBeLessThan(
      commandIndex(host, 'restart'),
    );
  });
});

describe('up — what it refuses', () => {
  /**
   * Before the first write, not after the first failure: a permission error found
   * halfway through leaves an install root with one artifact in it and no units,
   * which is harder to reason about than a deployment that never started.
   */
  it('refuses without root, before touching anything', async () => {
    const host = fakeHost({euid: 1000});

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /must run as root.*effective uid 1000/s,
    );
    expect(host.callsOf('installFile')).toEqual([]);
    expect(host.callsOf('writeFile')).toEqual([]);
    expect(host.commands()).toEqual([]);
  });

  it('fails loudly when an artifact is not where it was said to be', async () => {
    const host = fakeHost({failInstall: ['out/server.js']});

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /out\/server\.js/,
    );
    // Nothing was told to start, so nothing restarted into a missing file.
    expect(host.commands().some((c) => c.includes('restart'))).toBe(false);
  });

  it('fails when systemd rejects the reload, rather than restarting anyway', async () => {
    const host = fakeHost({
      responses: [
        {match: 'daemon-reload', result: {code: 1, stderr: 'Access denied'}},
      ],
    });

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /daemon-reload failed \(exit 1\): Access denied/,
    );
    expect(host.commands().some((c) => c.includes('restart'))).toBe(false);
  });

  it('reports which user it could not create', async () => {
    const host = fakeHost({
      responses: [
        {match: 'id -u tempo', result: {code: 1}},
        {match: 'useradd', result: {code: 4, stderr: 'UID already in use'}},
      ],
    });

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /could not create the tempo user \(exit 4\): UID already in use/,
    );
  });
});

describe('up — configuration', () => {
  it('defaults to the port both sides of the deployment agree on', async () => {
    const host = fakeHost();
    const result = await up(artifacts, host);

    expect(result.port).toBe(DEFAULT_PORT);
    expect(result.host).toBe('127.0.0.1');
  });

  it('writes an overridden port into both the server and the workers', async () => {
    const host = fakeHost();
    await up({...artifacts, port: 9001}, host);

    for (const [, text] of host.written) expect(text).toContain('9001');
  });

  /**
   * The whole point of the loopback default: the RPC has no auth and no TLS, so
   * binding every interface has to be something an operator asked for.
   */
  it('binds loopback unless told otherwise', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    const server = host.written.get(unitPath('tempo-server'));
    expect(server).toContain('--host=127.0.0.1');
  });

  // The fingerprint file has a place in the layout and nothing reads it yet;
  // writing one now would be a file that rots. See deploy/README.md, question 2.
  it('writes no VERSION file, because nothing reads one yet', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    for (const path of host.written.keys())
      expect(path).not.toContain('VERSION');
  });
});
