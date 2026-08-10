/**
 * @fileoverview
 * Talking to systemd through a `Host`: the handful of `systemctl` calls a
 * deployment makes, and the distinction between one whose failure is fatal and
 * one whose exit code is the answer.
 *
 * Separate from `up`/`down`/`status` because all three make these calls and they
 * must agree on the spelling; separate from `ports/host.ts` because that is about
 * the machine in general and this is about one program on it.
 */

import type {Host} from './ports/host';

/** systemd's own name for a unit file — what every subcommand actually takes. */
function serviceOf(unit: string): string {
  return `${unit}.service`;
}

/**
 * Run a `systemctl` subcommand whose failure means the deployment did not happen.
 *
 * Throws with what systemd said, because these are the calls where continuing
 * produces a deployment that is half-applied and reads as fine: a failed
 * `daemon-reload` leaves the old unit running under a new file, and a failed
 * `restart` leaves the previous artifact serving after a "successful" deploy.
 */
export async function systemctl(
  host: Host,
  ...args: readonly string[]
): Promise<void> {
  const result = await host.run('systemctl', args);
  if (result.code !== 0)
    throw new Error(
      `systemctl ${args.join(' ')} failed (exit ${result.code})` +
        `${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
    );
}

/**
 * Re-read unit files from disk.
 *
 * Skipping this is the mistake that looks most like success: systemd keeps
 * serving the unit it last loaded, so a redeploy whose `ExecStart` changed
 * restarts the *old* command line and every check passes.
 */
export function daemonReload(host: Host): Promise<void> {
  return systemctl(host, 'daemon-reload');
}

/**
 * Start these units on boot from now on.
 *
 * The step whose absence is invisible for exactly as long as nobody reboots.
 * Everything is green, `systemctl status` is green, and the deployment is gone
 * the first time the host comes back up.
 */
export function enable(host: Host, units: readonly string[]): Promise<void> {
  return systemctl(host, 'enable', ...units.map(serviceOf));
}

/**
 * Stop these units and stop starting them on boot.
 *
 * `--now` is what makes `disable` mean "off" rather than "off next time".
 * Per-unit rather than one call, so one absent unit does not decide the fate of
 * the others.
 */
export function disableNow(
  host: Host,
  unit: string,
): Promise<{
  ok: boolean;
  detail: string;
}> {
  return host
    .run('systemctl', ['disable', '--now', serviceOf(unit)])
    .then((result) => ({
      ok: result.code === 0,
      detail:
        (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '',
    }));
}

/** Restart a unit, so it picks up the artifact that was just installed. */
export function restart(host: Host, unit: string): Promise<void> {
  return systemctl(host, 'restart', serviceOf(unit));
}

/** One unit's state, as systemd reports it. */
export interface UnitState {
  unit: string;
  /** `active`, `inactive`, `failed`, `activating`, … — or `unknown` if unreadable. */
  activeState: string;
  /** `enabled`, `disabled`, `not-found`, … — whether a reboot brings it back. */
  fileState: string;
  /** How many times systemd has restarted it since it was started. */
  restarts: number;
}

/**
 * Read one unit's state.
 *
 * `show` rather than `status`: it prints `Property=value` lines meant to be
 * parsed, exits 0 even for a unit that does not exist (reporting
 * `LoadState=not-found`), and does not page. `status` is shaped for a human and
 * changes between systemd versions.
 *
 * A unit systemd has never heard of comes back as `not-found` rather than an
 * error, because "you have not deployed this" is a perfectly good answer to
 * "what is the state of this deployment".
 */
export async function unitState(host: Host, unit: string): Promise<UnitState> {
  const result = await host.run('systemctl', [
    'show',
    serviceOf(unit),
    '--property=ActiveState',
    '--property=UnitFileState',
    '--property=LoadState',
    '--property=NRestarts',
  ]);

  const properties = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) properties.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }

  // `UnitFileState` is empty for a unit with no file on disk, where `LoadState`
  // is the property that says so. Reporting the empty string would read as "it
  // exists and I could not tell", which is a different and worse answer.
  const fileState =
    properties.get('UnitFileState') ||
    properties.get('LoadState') ||
    'not-found';

  return {
    unit,
    activeState: properties.get('ActiveState') || 'unknown',
    fileState,
    restarts: Number(properties.get('NRestarts') ?? 0) || 0,
  };
}
