/**
 * @fileoverview
 * The two things an operator does to a running deployment that are neither
 * installing it nor tearing it down: read its logs, and bounce it.
 *
 * Both were missing, and their absence is the kind that only shows up when you
 * try to assemble a real tool: `status` says a unit is `failed` and restarting 40
 * times, and the next question is always "why" — which is a log — followed by
 * "make it stop" — which is a restart. Sending someone to `journalctl` by hand at
 * that point means the deployment's own names, units, and layout are knowledge the
 * tool has and the operator has to retype.
 *
 * Separate from `up.ts` because these change nothing about what is installed.
 * That distinction is the whole point of `restart` existing: `up` is a deploy and
 * takes artifact paths, and reaching for it to bounce a service would reinstall
 * from whatever paths happened to be lying around.
 */

import {ALL_UNITS, SERVER_UNIT, WORKER_UNITS} from './layout';
import type {Host} from './ports/host';
import {restart as restartUnit} from './systemctl';

/**
 * Which service to act on.
 *
 * Named roles rather than raw unit strings, so a caller cannot ask for a unit this
 * deployment does not have and so the unit names stay this module's business. See
 * `unitsFor`.
 */
export type Target = 'all' | 'server' | 'workflow' | 'activity';

/** The units a target names, **server first** where it includes the server. */
export function unitsFor(target: Target): readonly string[] {
  switch (target) {
    case 'all':
      return ALL_UNITS;
    case 'server':
      return [SERVER_UNIT];
    case 'workflow':
      return [WORKER_UNITS.workflow];
    case 'activity':
      return [WORKER_UNITS.activity];
    default:
      return assertNever(target);
  }
}

/** An exhaustiveness check: a new `Target` becomes a compile error here. */
function assertNever(value: never): never {
  throw new Error(`unhandled target: ${String(value)}`);
}

/** What a restart touched. */
export interface RestartResult {
  units: readonly string[];
}

/**
 * Bounce services without touching what is installed.
 *
 * Distinct from `up`, which is a deploy: this reinstalls nothing, so it is the
 * safe thing to reach for when a worker is wedged or a config change was made by
 * hand. Server first when the target includes it, for the same reason `up`
 * restarts in that order — the workers then reconnect to something coming up
 * rather than spending their first backoff on something going down.
 *
 * Needs no privilege: these are the calling user's own units, which is the whole
 * point of the deployment model. What it refuses is running *as* root.
 */
export async function restart(
  target: Target,
  host: Host,
): Promise<RestartResult> {
  // See `up`: under sudo this addresses root's units, not the user's.
  if (host.euid() === 0)
    throw new Error(
      'restarting tempo services must not run as root: these are systemd user units, and under sudo it would restart root’s rather than yours',
    );

  const units = unitsFor(target);
  for (const unit of units) await restartUnit(host, unit);
  return {units: [...units]};
}

/** What to read, and how much. */
export interface LogOptions {
  /** Which service's log. Defaults to every unit, interleaved by time. */
  target?: Target;
  /** How many of the most recent lines. Defaults to 100. */
  lines?: number;
  /**
   * Only entries at or after this, in any form `journalctl --since` accepts —
   * `"10 min ago"`, `"2026-08-09 14:00"`. Passed through rather than parsed: the
   * grammar is journald's, and reimplementing it here would only be able to
   * accept less.
   */
  since?: string;
}

/** One service's log, as journald returned it. */
export interface UnitLog {
  unit: string;
  /** The lines, oldest first — reading order. */
  lines: readonly string[];
}

/**
 * Read the logs of one service or all of them.
 *
 * Per unit rather than one interleaved stream, because the question is almost
 * always about one tier: an activity worker's stack trace and the server's lease
 * bookkeeping are different subjects, and merging them by timestamp buries the
 * one you came for. A caller that wants them merged has the timestamps to do it.
 *
 * Needs no root — journald grants the `systemd-journal` group and unit logs for a
 * `User=` service are readable — so this is the one operation here an operator can
 * run before reaching for `sudo`. If a host is configured otherwise the lines come
 * back empty rather than throwing, which is journald's own behaviour and not worth
 * second-guessing from here.
 *
 * **Not a follow.** Streaming would mean holding a child process open and handing
 * back something to cancel, which is a different shape from every other function
 * here and belongs to whoever is rendering it — an assembler that wants `--follow`
 * should spawn `journalctl -f` itself rather than have this invent a stream API.
 */
export async function logs(
  options: LogOptions,
  host: Host,
): Promise<UnitLog[]> {
  const units = unitsFor(options.target ?? 'all');
  const lines = options.lines ?? 100;

  const out: UnitLog[] = [];
  for (const unit of units) {
    const args = [
      // The user journal, matching where the units live. Without it journalctl
      // reads the system journal, where these services have never written, and
      // reports an empty log — an answer-shaped wrong answer.
      '--user',
      '--unit',
      `${unit}.service`,
      '--lines',
      String(lines),
      // Never page and never colour: this output is being returned to a caller,
      // and journald pages by default when it thinks it is talking to a terminal.
      '--no-pager',
      '--output',
      'short-iso',
    ];
    if (options.since) args.push('--since', options.since);

    const result = await host.run('journalctl', args);
    out.push({
      unit,
      // A unit journald has never heard of yields a header line and nothing else,
      // which reads as an empty log — the correct answer for a service that has
      // never run.
      lines: result.stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== '' && !line.startsWith('-- No entries')),
    });
  }
  return out;
}
