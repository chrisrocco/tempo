/**
 * @fileoverview
 * Where a deployment lives on disk, and what its services are called.
 *
 * Every path here is a **constant rather than an option**, and that is a
 * decision rather than an omission. An option with one correct value is an
 * option that only ever gets passed wrong, and each of these is a value that
 * `up` writes into a unit file while something else — `down`, `status`, an
 * operator reading `systemctl cat` — assumes the same value independently. One
 * module holding all of them is what makes "they agree" true by construction
 * instead of by review.
 *
 * They become options the day a deployment needs them to differ. Nothing here
 * forecloses that; it just refuses to pay for it in advance.
 *
 * ## The split between `/opt` and `/var/lib`
 *
 * `/opt/tempo` is the software and `/var/lib/tempo` is the state it accumulates.
 * Separating them is what makes "replace the artifact, keep the history" a
 * non-event: `up` overwrites the first and never touches the second.
 *
 * ## `/usr/bin/node` is the weak point, and it is deliberate
 *
 * The units name their interpreter absolutely rather than resolving `node` from
 * a `PATH`, because a unit that inherits `PATH` runs a different interpreter
 * depending on who deployed it. The cost is that a host with node installed
 * elsewhere gets `203/EXEC` on the first start — which is **loud**: the
 * deployment does not come up and `systemctl status` names the missing file.
 * That is what makes a constant acceptable where a wrong guess would otherwise
 * be unacceptable.
 */

import type {WorkerRole} from '../tempo';

/** The software. Overwritten by every deploy. */
export const INSTALL_ROOT = '/opt/tempo';

/**
 * The name systemd is given as `StateDirectory=`, from which it derives
 * `/var/lib/tempo` — creating it and chowning it to the unit's user before every
 * `ExecStart`. That is why nothing here creates the state directory: letting
 * systemd own it means it also survives someone deleting it between deploys.
 */
export const STATE_DIRECTORY_NAME = 'tempo';

/** Where `STATE_DIRECTORY_NAME` resolves to, which is what the server is told. */
export const STATE_DIR = `/var/lib/${STATE_DIRECTORY_NAME}`;

/** The interpreter the units run. See the fileoverview on why it is absolute. */
export const NODE_BIN = '/usr/bin/node';

/** The unprivileged account the services run as. Created by `up` if absent. */
export const SERVICE_USER = 'tempo';

/** Where systemd reads unit files an administrator installed. */
export const UNIT_DIR = '/etc/systemd/system';

/** The installed server artifact — what `--server` was copied to. */
export const SERVER_ARTIFACT = `${INSTALL_ROOT}/server.js`;

/**
 * The installed worker artifact — what `--worker` was copied to.
 *
 * One file, run twice. The two worker services are the same bytes with a
 * different `--role`, which is the whole reason the roles can be deployed
 * separately without building anything twice.
 */
export const WORKER_ARTIFACT = `${INSTALL_ROOT}/worker.js`;

/** The service that hosts the engine and owns the durable state. */
export const SERVER_UNIT = 'tempo-server';

/**
 * One service per worker role.
 *
 * The split is the deployed shape: an activity is the only place I/O happens, so
 * an activity blocking the event loop in a process that also replays workflows
 * stalls that replay into a lease expiry. The two tiers also scale independently
 * against one server. A single process serving both roles is the *development*
 * shape — a hand-run binary with no `--role` — and must not be what a deployment
 * gets by accident. See `src/tempo.ts`.
 */
export const WORKER_UNITS: Readonly<Record<WorkerRole, string>> = {
  workflow: 'tempo-worker-workflow',
  activity: 'tempo-worker-activity',
};

/**
 * Every unit a deployment consists of, **server first**.
 *
 * The order is load-bearing for `up`: restarting the server before its workers
 * means the workers reconnect to a server that is already coming up, rather than
 * spending their first backoff on one that is going down.
 */
export const ALL_UNITS: readonly string[] = [
  SERVER_UNIT,
  WORKER_UNITS.workflow,
  WORKER_UNITS.activity,
];

/** Where a unit file goes. Takes the bare name; adds the `.service` suffix. */
export function unitPath(unit: string): string {
  return `${UNIT_DIR}/${unit}.service`;
}
