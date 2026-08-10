/**
 * @fileoverview
 * The systemd units a deployment consists of, as text.
 *
 * Pure functions: configuration in, unit file out, nothing touched. **This is
 * where a deployment's correctness lives** — a unit is the only lasting record of
 * how a process was launched and what happens when it dies — and being pure is
 * what makes all of it checkable without a Linux box or root.
 *
 * The flag names come from `process_flags.ts`, the same constants
 * `bin/server-main.ts` and `src/tempo.ts` read. That is not tidiness: a unit
 * emitting `--listen=7777` where the server reads `--port` produces a deployment
 * that starts, reports healthy, and serves nobody. Sharing the constant makes
 * that a compile error instead of something a spec has to remember to check.
 *
 * ## The two properties every unit here delivers
 *
 * **1. It is running at all times** — across crashes, restarts, and reboots.
 *
 * - `Restart=always` with a short `RestartSec`, so a crash comes back.
 * - `WantedBy=multi-user.target`, so `systemctl enable` makes a reboot come back.
 *   Without it a host reboot silently drops the whole deployment, having been
 *   green every day until then.
 * - `StartLimitIntervalSec=0`, so systemd **never gives up**. The default rate
 *   limit stops a unit after five restarts in ten seconds and leaves it `failed`,
 *   which turns "always running" into "gave up during the incident" — precisely
 *   when nobody is reading `systemctl status`. The cost is that a genuinely
 *   misconfigured process crash-loops forever instead of parking; both states are
 *   visible, and only this one recovers by itself once the cause is fixed.
 *
 * **2. A redeploy is a restart.** Nothing rereads a `.js` file in place, so
 * replacing the artifact does nothing until the service restarts — which is why
 * `up` restarts unconditionally rather than trying to detect a change.
 *
 * ## What the units deliberately do not carry
 *
 * **No `--queue`.** A queue name is a contract about which workflows and
 * activities a worker has registered, so it belongs with the code that registers
 * them — `Tempo.startWorker({taskQueue})` — and not with the thing that copies
 * the file. Writing it here as well would put one value in two places with
 * nothing keeping them in step, and the failure when they disagree is an
 * execution parked forever on a queue nothing serves.
 *
 * **No environment.** Every input is a flag on `ExecStart`, so `systemctl cat`
 * shows the whole configuration of a service in one place. See
 * `src/process_flags.ts` for why an inherited environment was worse.
 */

import {SERVER_FLAG, WORKER_FLAG, formatFlag} from '../process_flags';
import type {WorkerRole} from '../tempo';
import {
  INSTALL_ROOT,
  NODE_BIN,
  SERVER_ARTIFACT,
  SERVER_UNIT,
  SERVICE_USER,
  STATE_DIR,
  STATE_DIRECTORY_NAME,
  WORKER_ARTIFACT,
  WORKER_UNITS,
} from './layout';

/** What a deployment's units need to know that is not a constant of the layout. */
export interface UnitConfig {
  /** The port the server binds and the workers dial. Typically `DEFAULT_PORT`. */
  port: number;
  /** The interface the server binds. */
  host: string;
}

/**
 * How a worker reaches the server, given where the server was told to bind.
 *
 * A wildcard bind is not an address a client can dial: `0.0.0.0` means "every
 * IPv4 interface", and connecting to it is unspecified — it happens to reach
 * localhost on Linux and fails on some other stacks. So the wildcards map to
 * their loopback, every other host passes through, and an IPv6 literal is
 * bracketed because `http://::1:7777` has no unambiguous reading.
 *
 * Workers here are always co-located with their server, so loopback is right;
 * what this function exists for is to keep `--host=0.0.0.0` — which an operator
 * sets to let *other* machines connect — from also breaking the local workers.
 */
export function workerServerUrl(config: UnitConfig): string {
  const dialable =
    config.host === '0.0.0.0' || config.host === ''
      ? '127.0.0.1'
      : config.host === '::' || config.host === '::0'
        ? '::1'
        : config.host;
  const bracketed = dialable.includes(':') ? `[${dialable}]` : dialable;
  return `http://${bracketed}:${config.port}`;
}

/** The arguments the server process is launched with. */
export function serverArgs(config: UnitConfig): string[] {
  return [
    formatFlag(SERVER_FLAG.port, config.port),
    formatFlag(SERVER_FLAG.host, config.host),
    // Always passed, never omitted: an unset data directory means the server
    // keeps its history in memory and loses every execution on the next restart,
    // while looking perfectly healthy until then.
    formatFlag(SERVER_FLAG.dataDir, STATE_DIR),
  ];
}

/** The arguments one worker role is launched with. */
export function workerArgs(role: WorkerRole, config: UnitConfig): string[] {
  return [
    formatFlag(WORKER_FLAG.role, role),
    formatFlag(WORKER_FLAG.server, workerServerUrl(config)),
  ];
}

/**
 * The `[Unit]` directives every service shares.
 *
 * **`StartLimitIntervalSec` belongs here and not in `[Service]`**, and getting
 * that wrong is invisible in the worst way. systemd moved the start-rate-limit
 * directives from `[Service]` to `[Unit]` in v229; a modern systemd reading one in
 * `[Service]` logs `Unknown key name … ignoring` and **applies the default limit
 * anyway**. The unit then still gives up after five restarts in ten seconds — the
 * exact failure the line was written to prevent, in a file that looks like it
 * prevents it. The section is the whole of what makes the directive real.
 */
function unitSection(): string {
  return [
    // Never stop trying. The default rate limit leaves a unit `failed` after five
    // restarts in ten seconds — "always running" becoming "gave up mid-incident".
    'StartLimitIntervalSec=0',
  ].join('\n');
}

/**
 * The `[Service]` directives every service shares: who it runs as, where, and
 * what happens when it dies.
 *
 * `StateDirectory` is on all three rather than only the server. It is what creates
 * and chowns `/var/lib/tempo`, and a worker unit that omitted it would work until
 * the day it started first on a fresh host.
 */
function serviceSection(): string {
  return [
    `User=${SERVICE_USER}`,
    `Group=${SERVICE_USER}`,
    `WorkingDirectory=${INSTALL_ROOT}`,
    `StateDirectory=${STATE_DIRECTORY_NAME}`,
    'Restart=always',
    'RestartSec=1',
  ].join('\n');
}

/** The engine server: owns the durable state and the timers. */
export function serverUnit(config: UnitConfig): string {
  return `[Unit]
Description=tempo server
After=network-online.target
Wants=network-online.target
${unitSection()}

[Service]
ExecStart=${NODE_BIN} ${SERVER_ARTIFACT} ${serverArgs(config).join(' ')}
${serviceSection()}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * One worker role.
 *
 * `After=` the server orders a boot but promises nothing about readiness — the
 * server may still be binding when the worker's first poll goes out. That is
 * fine and is not worked around here: a worker whose poll fails backs off and
 * retries, and reports the failure while doing so (`worker/worker_loops.ts`).
 * Encoding readiness in the unit would mean a health check that has to stay
 * true, to buy something the retry loop already handles.
 */
export function workerUnit(role: WorkerRole, config: UnitConfig): string {
  return `[Unit]
Description=tempo ${role} worker
After=network-online.target ${SERVER_UNIT}.service
Wants=network-online.target
${unitSection()}

[Service]
ExecStart=${NODE_BIN} ${WORKER_ARTIFACT} ${workerArgs(role, config).join(' ')}
${serviceSection()}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Every unit of a deployment, keyed by unit name, **server first**.
 *
 * The order matters to `up`: restarting the server before its workers means the
 * workers reconnect to something coming up rather than spending their first
 * backoff on something going down.
 */
export function allUnits(config: UnitConfig): Array<[string, string]> {
  return [
    [SERVER_UNIT, serverUnit(config)],
    [WORKER_UNITS.workflow, workerUnit('workflow', config)],
    [WORKER_UNITS.activity, workerUnit('activity', config)],
  ];
}
