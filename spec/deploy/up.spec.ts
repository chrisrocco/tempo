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
import {ALL_UNITS, resolveLayout, unitPath, up} from '../../src/deploy';
import {DEFAULT_PORT} from '../../src/process_flags';
import {FAKE_NODE, fakeHost, type FakeHost} from '../support/fake_host';

const artifacts = {server: 'out/server.js', worker: 'out/worker.js'};

/** The layout the fake user's deployment resolves to. */
const layout = resolveLayout(fakeHost());

/** Index of the first recorded command containing `fragment`. */
function commandIndex(host: FakeHost, fragment: string): number {
  return host.commands().findIndex((c) => c.includes(fragment));
}

describe('up — the deploy sequence', () => {
  it('installs both artifacts and writes all three units', async () => {
    const host = fakeHost();
    const result = await up(artifacts, host);

    expect(result.installed).toEqual([
      layout.serverArtifact,
      layout.workerArtifact,
    ]);
    expect(result.units).toEqual([...ALL_UNITS]);
    for (const unit of ALL_UNITS)
      expect(host.written.has(unitPath(layout, unit))).toBe(true);
  });

  it('copies the artifacts through the install seam, not by writing them', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    // `installFile` is what dereferences a symlink and renames atomically; a
    // `writeFile` of the artifact would quietly lose both properties.
    expect(host.callsOf('installFile')).toEqual([
      {
        kind: 'installFile',
        target: 'out/server.js',
        detail: layout.serverArtifact,
      },
      {
        kind: 'installFile',
        target: 'out/worker.js',
        detail: layout.workerArtifact,
      },
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
      (c) => c.kind === 'run' && c.detail?.includes('daemon-reload') === true,
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

describe('up — a per-user deployment', () => {
  it('installs under the user’s own directories and creates no accounts', async () => {
    const host = fakeHost();
    const result = await up(artifacts, host);

    expect(result.installRoot).toBe('/fake/home/.local/share/tempo');
    expect(
      host.written.has('/fake/home/.config/systemd/user/tempo-server.service'),
    ).toBe(true);
    // No system account: a user unit runs as the user who owns it.
    expect(host.commands().some((c) => c.startsWith('useradd'))).toBe(false);
    expect(host.commands().some((c) => c.startsWith('id '))).toBe(false);
  });

  it('addresses the user manager on every systemctl call', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    for (const command of host
      .commands()
      .filter((c) => c.startsWith('systemctl')))
      expect(command).toContain('--user');
  });

  // The unit directory does not exist on a machine that has never had a user unit,
  // and systemd will not create it.
  it('creates the unit directory as well as the install root', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    expect(host.callsOf('makeDirectory').map((c) => c.target)).toEqual([
      '/fake/home/.local/share/tempo',
      // The state directory too: systemd is not asked to own it, because
      // `StateDirectory=` in a user unit could resolve elsewhere. See units.ts.
      '/fake/home/.local/state/tempo',
      '/fake/home/.config/systemd/user',
    ]);
  });
});

/**
 * The interpreter the units run. `ExecStart=` must be an absolute path, so one has
 * to be chosen; what changed is that it is no longer the constant `/usr/bin/node`,
 * which is absent on any machine where node came from nvm, fnm, volta, asdf, or
 * Homebrew — which is most machines that would want a per-user deployment.
 */
describe('up — which node the units run', () => {
  it('defaults to the interpreter running this process', async () => {
    const host = fakeHost();
    const result = await up(artifacts, host);

    expect(result.nodeBin).toBe(FAKE_NODE);
    expect(host.written.get(unitPath(layout, 'tempo-server'))).toContain(
      `ExecStart=${FAKE_NODE} `,
    );
  });

  it('never writes the path it used to hardcode', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    for (const [, text] of host.written)
      expect(text).not.toContain('/usr/bin/node');
  });

  // For a deploying process that is not itself running the interpreter the services
  // should use — a wrapper under a different node, or a single-file executable where
  // `process.execPath` is that executable rather than node.
  it('takes an explicit interpreter when the default is wrong', async () => {
    const host = fakeHost();
    const result = await up({...artifacts, node: '/opt/node22/bin/node'}, host);

    expect(result.nodeBin).toBe('/opt/node22/bin/node');
    expect(
      host.written.get(unitPath(layout, 'tempo-worker-activity')),
    ).toContain('ExecStart=/opt/node22/bin/node ');
  });
});

/**
 * The one prerequisite this model has, and the one thing about it that fails
 * silently: without lingering, these services stop at logout and do not start at
 * boot. Every deploy succeeds and the deployment vanishes when the operator closes
 * their laptop.
 */
describe('up — lingering', () => {
  it('reports lingering as on when loginctl says it is', async () => {
    const host = fakeHost({
      responses: [{match: 'loginctl', result: {stdout: 'Linger=yes\n'}}],
    });
    const result = await up(artifacts, host);

    expect(result.lingering).toBe(true);
    expect(result.lingerPrerequisite).toBeUndefined();
  });

  // Reported, not thrown: the deployment is running right now and is correct.
  // What is wrong is what happens later, and only the operator can fix it.
  it('reports the fix when lingering is off, without failing the deploy', async () => {
    const host = fakeHost({
      responses: [{match: 'loginctl', result: {stdout: 'Linger=no\n'}}],
    });
    const result = await up(artifacts, host);

    expect(result.units).toEqual([...ALL_UNITS]);
    expect(result.lingering).toBe(false);
    expect(result.lingerPrerequisite).toContain('enable-linger');
  });

  // A user with no session makes loginctl exit non-zero. Reading that as "not
  // lingering" prompts a check rather than suppressing one.
  it('treats an unreadable answer as not lingering', async () => {
    const host = fakeHost({
      responses: [
        {match: 'loginctl', result: {code: 1, stderr: 'no such user'}},
      ],
    });

    expect((await up(artifacts, host)).lingering).toBe(false);
  });

  it('asks only after the deployment is up, so it can never fail one', async () => {
    const host = fakeHost();
    await up(artifacts, host);

    expect(commandIndex(host, 'loginctl')).toBeGreaterThan(
      commandIndex(host, 'restart'),
    );
  });
});

describe('up — what it refuses', () => {
  /**
   * The inversion of what a system-wide installer would check, and not symmetry for
   * its own sake: under `sudo` every path resolves against root's home, so this
   * would install a deployment into `/root/.local/share/tempo` and start services
   * owned by root that the operator cannot see with their own `systemctl --user`.
   * It would appear to work and produce nothing they asked for.
   */
  it('refuses to run as root, before touching anything', async () => {
    const host = fakeHost({euid: 0});

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /must not run as root.*user units/s,
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

  it('fails when systemd will not enable the units', async () => {
    const host = fakeHost({
      responses: [
        {match: 'enable', result: {code: 1, stderr: 'Failed to enable unit'}},
      ],
    });

    await expectAsync(up(artifacts, host)).toBeRejectedWithError(
      /enable .*failed \(exit 1\): Failed to enable unit/,
    );
    // Nothing was restarted into a deployment that will not survive a logout.
    expect(host.commands().some((c) => c.includes('restart'))).toBe(false);
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

    const server = host.written.get(unitPath(layout, 'tempo-server'));
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
