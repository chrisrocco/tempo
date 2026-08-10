/**
 * @fileoverview
 * `down` — stop the services and stop them coming back on boot.
 *
 * **It deletes nothing.** Not `/opt/tempo`, and emphatically not
 * `/var/lib/tempo`. `down` is the inverse of `up`'s *supervision*, not of its
 * filesystem writes: it is the thing an operator reaches for to make a host quiet,
 * and a name that pairs with `up` in muscle memory is the worst possible home for
 * "destroy every execution's history". Removing data stays a separate, explicit
 * act with a name that says what it does.
 *
 * That also makes `down` followed by `up` a pause rather than a redeploy: history
 * survives, and running executions resume from it (`resume()` on boot, proved in
 * `spec/integration/resume.spec.ts`).
 *
 * ## Why it reports instead of throwing
 *
 * A unit that was never installed is already off, and so is one already stopped.
 * `down` means "make sure this is off", so an assembler should be able to call it
 * without a `catch` around it. Every unit gets its own attempt and its own line in
 * the result, so one absent unit does not decide the fate of the others.
 *
 * It does **not** try to distinguish "was not installed" from "could not be
 * stopped". Both come back from `systemctl disable --now` as a non-zero exit, the
 * codes are not stable across systemd versions, and guessing would mean sometimes
 * reporting a permissions failure as "already off" — the one wrong answer that
 * matters here. The exit and what systemd said are reported instead, and the
 * caller decides what to make of them.
 */

import {ALL_UNITS} from './layout';
import type {Host} from './ports/host';
import {disableNow} from './systemctl';

/** What happened to one unit. */
export interface UnitOutcome {
  unit: string;
  /** True when systemd reported success — the unit is stopped and disabled. */
  disabled: boolean;
  /**
   * What systemd said when it did not succeed. Usually "no such unit" for
   * something never deployed, but see the fileoverview: this is not interpreted.
   */
  detail?: string;
}

/** What a `down` did, unit by unit. */
export interface DownResult {
  units: readonly UnitOutcome[];
  /** True when every unit is now stopped and disabled. */
  allDisabled: boolean;
}

/**
 * Stop and disable every unit of a deployment.
 *
 * Needs no privilege: these are the calling user's own units.
 */
export async function down(host: Host): Promise<DownResult> {
  // Same reason as `up`: under sudo this would address root's units, report them
  // all absent, and leave the user's deployment running.
  if (host.euid() === 0)
    throw new Error(
      'tempo down must not run as root: these are systemd user units, and under sudo it would look for root’s and leave yours running',
    );

  const units: UnitOutcome[] = [];
  for (const unit of ALL_UNITS) {
    const {ok, detail} = await disableNow(host, unit);
    units.push({unit, disabled: ok, ...(ok || !detail ? {} : {detail})});
  }

  return {units, allDisabled: units.every((u) => u.disabled)};
}
