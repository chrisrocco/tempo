/**
 * @fileoverview
 * The systemd units a deployment installs.
 *
 * These are the highest-value specs in `deploy/`, because a unit file is the only
 * lasting record of how a process was launched and what happens when it dies, and
 * because every mistake available here is the silent kind — a deployment that
 * starts, reports healthy, and does not work.
 *
 * The first block is the one that matters most: **the flags the units write are
 * fed to the parsers that read them.** Nothing else in the repo connects the two
 * sides, and a unit saying `--listen=7777` where the server reads `--port` would
 * otherwise produce a deployment nothing complains about.
 */

import 'jasmine';
import {
  resolveLayout,
  serverArgs,
  serverUnit,
  workerArgs,
  workerServerUrl,
  workerUnit,
  type UnitConfig,
} from '../../src/deploy';
import {fakeHost} from '../support/fake_host';
import {
  DEFAULT_PORT,
  SERVER_FLAG,
  WORKER_FLAG,
  flagValue,
  numericFlagValue,
} from '../../src/process_flags';
import {
  DEFAULT_SERVER_URL,
  requestedRole,
  resolveServerUrl,
  resolveTaskQueue,
} from '../../src/tempo';

const config: UnitConfig = {port: DEFAULT_PORT, host: '127.0.0.1'};

/** A layout for a fixed fake user, so paths are assertable. */
const layout = resolveLayout(fakeHost());

/**
 * Split a unit file into its sections.
 *
 * Necessary rather than fussy: several systemd directives are only honoured in
 * one particular section and are *silently ignored* in another, so a spec that
 * searched the whole file would pass for a unit that does nothing it claims. See
 * the start-limit case below.
 */
function sectionsOf(unit: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '';
  for (const line of unit.split('\n')) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header?.[1]) {
      current = header[1];
      sections.set(current, []);
      continue;
    }
    if (line.trim()) sections.get(current)?.push(line.trim());
  }
  return sections;
}

describe('deploy units — what is written is what is read', () => {
  /**
   * The server's own reading of its command line, applied to the command line the
   * unit gives it. If these two ever disagree the deployment starts and serves
   * nobody, and this is the only place that would notice.
   */
  it('gives the server flags the server itself parses', () => {
    const args = serverArgs(layout, config);

    expect(numericFlagValue(args, SERVER_FLAG.port)).toBe(DEFAULT_PORT);
    expect(flagValue(args, SERVER_FLAG.host)).toBe('127.0.0.1');
    expect(flagValue(args, SERVER_FLAG.dataDir)).toBe(layout.stateDir);
  });

  it('gives each worker flags the worker entrypoint itself resolves', () => {
    const args = workerArgs('workflow', config);

    expect(resolveServerUrl(args, undefined)).toBe(DEFAULT_SERVER_URL);
    expect(requestedRole(args, undefined)).toEqual({
      value: 'workflow',
      source: '--role',
    });
  });

  /**
   * The queue is declared once, in `Tempo.startWorker`. A unit that also named one
   * would put a single value in two places with nothing keeping them in step, and
   * the failure when they disagree is an execution parked forever on a queue
   * nothing serves.
   */
  it('says nothing about the queue, leaving the artifact to declare it', () => {
    const args = workerArgs('activity', config);

    expect(flagValue(args, WORKER_FLAG.queue)).toBeUndefined();
    expect(resolveTaskQueue(args, 'declared-in-code')).toBe('declared-in-code');
  });

  // An unset data directory means the server keeps history in memory and loses
  // every execution on the next restart, while looking healthy until then. It is
  // the one flag that must never be omitted.
  it('always tells the server where its history goes', () => {
    for (const port of [DEFAULT_PORT, 1234])
      expect(
        flagValue(
          serverArgs(layout, {port, host: '0.0.0.0'}),
          SERVER_FLAG.dataDir,
        ),
      ).toBe(layout.stateDir);
  });
});

describe('deploy units — the address a worker dials', () => {
  it('dials the host the server binds', () => {
    expect(workerServerUrl({port: 7777, host: '10.0.0.4'})).toBe(
      'http://10.0.0.4:7777',
    );
  });

  /**
   * A wildcard bind is not an address. `0.0.0.0` means "every IPv4 interface", and
   * connecting to it is unspecified — it reaches localhost on Linux and fails on
   * some other stacks. An operator sets `--host=0.0.0.0` to let *other* machines
   * connect, and it must not break the workers on this one.
   */
  it('turns a wildcard bind into a loopback a worker can actually reach', () => {
    expect(workerServerUrl({port: 7777, host: '0.0.0.0'})).toBe(
      'http://127.0.0.1:7777',
    );
    expect(workerServerUrl({port: 7777, host: '::'})).toBe('http://[::1]:7777');
  });

  it('brackets an IPv6 literal, which has no unambiguous reading otherwise', () => {
    expect(workerServerUrl({port: 7777, host: 'fd00::1'})).toBe(
      'http://[fd00::1]:7777',
    );
  });
});

describe('deploy units — staying running', () => {
  const units = [
    serverUnit(layout, config),
    workerUnit(layout, 'workflow', config),
  ];

  it('comes back from a crash', () => {
    for (const unit of units) {
      expect(unit).toContain('Restart=always');
      expect(unit).toContain('RestartSec=1');
    }
  });

  /**
   * systemd's default rate limit stops a unit after five restarts in ten seconds
   * and leaves it `failed` — "always running" turning into "gave up during the
   * incident", at exactly the moment nobody is watching.
   *
   * **The section is asserted, not just the presence of the line.** systemd moved
   * the start-limit directives from `[Service]` to `[Unit]` in v229; one written
   * under `[Service]` today is logged as an unknown key, ignored, and the default
   * limit applies anyway. A unit carrying the line in the wrong section is a unit
   * that still gives up, in a file that reads as though it does not — so a spec
   * that only checked `toContain` would pass for exactly the bug it exists to
   * prevent. This caught that bug.
   */
  it('never gives up restarting, with the directive in the section systemd reads', () => {
    for (const unit of units) {
      const sections = sectionsOf(unit);
      expect(sections.get('Unit')).toContain('StartLimitIntervalSec=0');
      expect(sections.get('Service')).not.toContain('StartLimitIntervalSec=0');
    }
  });

  // The counterpart: `Restart=` really is a `[Service]` directive, and moving it
  // to `[Unit]` in a tidy-up would break it just as quietly.
  it('keeps the restart directives in [Service], where those belong', () => {
    for (const unit of units) {
      const sections = sectionsOf(unit);
      expect(sections.get('Service')).toContain('Restart=always');
      expect(sections.get('Unit')).not.toContain('Restart=always');
    }
  });

  // Without this, `systemctl enable` has nothing to hook onto and a host reboot
  // silently drops the deployment after weeks of everything being green.
  it('is wanted by the boot target, so enabling it survives a reboot', () => {
    for (const unit of units) {
      expect(unit).toContain('[Install]');
      expect(unit).toContain('WantedBy=default.target');
    }
  });

  /**
   * A user unit runs as whoever owns it, so naming a user would either be a no-op
   * or an error — and would read as though the service could run as someone else.
   * The identity question is answered by *where the unit lives*, which is the whole
   * reason this deployment model was chosen.
   */
  it('names no user, because a user unit already runs as the user', () => {
    for (const unit of units) {
      expect(unit).not.toContain('User=');
      expect(unit).not.toContain('Group=');
    }
  });

  /**
   * A system unit would order itself after `network-online.target`; a user unit
   * cannot — that target belongs to the system manager, and a user unit's `Wants=`
   * cannot pull it in, so writing it is ineffective at best. Nothing is lost: a
   * worker whose first poll fails backs off and retries.
   */
  it('does not pretend to depend on system targets it cannot reach', () => {
    for (const unit of units) expect(unit).not.toContain('network-online');
  });

  /**
   * `StateDirectory=` would make the unit name the state directory **twice** — once
   * for systemd to create, once as the `--data-dir` the server is launched with —
   * and in a user unit the first resolves beneath an XDG base directory it would be
   * unwise to assume. If they ever differed the server would write history to its
   * path while systemd maintained an empty directory at the other, with everything
   * looking healthy, and the bite would come when a backup or a restore trusted the
   * unit file and copied the empty one.
   *
   * Nothing is given up: `server/file` calls `mkdir -p` on open, so the directory
   * gets created on every start anyway.
   */
  it('does not name the state directory twice', () => {
    for (const unit of units) expect(unit).not.toContain('StateDirectory');
  });

  // The one place it is named, and the path the server actually writes to.
  it('tells the server the state directory the layout resolved', () => {
    expect(serverUnit(layout, config)).toContain(
      `--data-dir=${layout.stateDir}`,
    );
  });
});

describe('deploy units — the three services', () => {
  it('names the interpreter absolutely rather than resolving it from PATH', () => {
    // A unit that inherited PATH would run whichever node the deploying operator
    // happened to have.
    expect(serverUnit(layout, config)).toContain(
      `ExecStart=/usr/bin/node ${layout.installRoot}/`,
    );
  });

  it('runs one artifact twice, once per role', () => {
    const workflow = workerUnit(layout, 'workflow', config);
    const activity = workerUnit(layout, 'activity', config);

    expect(workflow).toContain(layout.workerArtifact);
    expect(activity).toContain(layout.workerArtifact);
    expect(workflow).toContain(`--${WORKER_FLAG.role}=workflow`);
    expect(activity).toContain(`--${WORKER_FLAG.role}=activity`);
  });

  it('orders workers after the server without depending on its readiness', () => {
    // `After=` orders a boot and promises nothing about listening; the worker's
    // own poll backoff is what handles a server still binding.
    expect(workerUnit(layout, 'workflow', config)).toContain(
      'tempo-server.service',
    );
  });

  it('carries no environment, so systemctl cat shows the whole configuration', () => {
    for (const unit of [
      serverUnit(layout, config),
      workerUnit(layout, 'activity', config),
    ]) {
      expect(unit).not.toContain('Environment=');
      expect(unit).not.toContain('EnvironmentFile=');
    }
  });
});
