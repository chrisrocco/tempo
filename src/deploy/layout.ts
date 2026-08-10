/**
 * @fileoverview
 * Where a deployment lives, and what its services are called.
 *
 * **This is a per-user deployment.** Artifacts, unit files, and history all live
 * under the invoking user's own directories, and the services are systemd *user*
 * units. Nothing here touches `/opt`, `/etc`, or `/var`, and nothing needs root.
 *
 * ## Why user units rather than a system daemon
 *
 * The workflows have to run as the user — with that user's files and credentials —
 * and an operator should not need `sudo` to deploy. A system daemon can be made to
 * satisfy the first (`User=`) but not the second: installing into
 * `/etc/systemd/system` is privileged every single time.
 *
 * A user unit runs as its owner by construction, so the identity question
 * disappears rather than being configured, and `systemctl --user` needs no
 * privilege at all. That is the whole trade, and what it costs is in
 * `LINGER_PREREQUISITE` below.
 *
 * An earlier design installed to `/opt/tempo` with a `tempo` system account and
 * required root for `up`, `down`, and `restart`. It is worth knowing that existed,
 * because a shared machine-wide daemon is the thing this cannot do: two users each
 * get their own server, their own workers, and their own history — which is the
 * point, but it also means they cannot share a port. See `unitsFor` and the port
 * note in `up`.
 *
 * ## Paths are resolved, not constant
 *
 * They used to be constants, deliberately, on the grounds that a value with one
 * correct answer is one that only ever gets passed wrong. Per-user deployment is
 * what changed: there is no longer one correct answer, because the answer contains
 * a home directory. `deploy/README.md` predicted this trigger as "two deployments
 * on one machine" — with user units, every user is a deployment.
 *
 * So a `Layout` is resolved from a `Host` once and threaded through. What did not
 * become variable is the *shape*: one install root, one state directory, three
 * units, whatever the prefix.
 *
 * The paths follow the XDG base directory specification, which is also the one
 * place a deployment reads the environment — see `UserPaths` for why that is not a
 * contradiction of the flags-not-environment rule.
 */

import type {Host} from './ports/host';
import type {WorkerRole} from '../tempo';

/**
 * The interpreter the units run.
 *
 * Named absolutely rather than resolved from a `PATH`, because a unit that
 * inherits `PATH` runs a different interpreter depending on how it was started.
 * The honest weak point: a host with node installed elsewhere gets `203/EXEC` on
 * the first start — loud rather than silent, the deployment does not come up, and
 * `systemctl --user status` names the missing file.
 */
export const NODE_BIN = '/usr/bin/node';

/**
 * The directory name this deployment uses under each of the user's base
 * directories, so the install root, the state directory, and the units all sit
 * under one recognisable name.
 *
 * Not handed to systemd as `StateDirectory=` — see `units.ts` for why naming the
 * state directory twice is the risk, and `up` for what creates it instead.
 */
export const DEPLOYMENT_NAME = 'tempo';

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
 * The order is load-bearing for `up` and `restart`: bringing the server up before
 * its workers means the workers reconnect to something coming up, rather than
 * spending their first backoff on something going down.
 */
export const ALL_UNITS: readonly string[] = [
  SERVER_UNIT,
  WORKER_UNITS.workflow,
  WORKER_UNITS.activity,
];

/**
 * The one thing about this model that needs privilege, once.
 *
 * Without lingering enabled, a user's services are tied to their login sessions:
 * they stop when the user logs out and do not start at boot. For a workflow engine
 * that is fatal and silent — everything deploys, everything runs, and the whole
 * deployment vanishes the next time the operator closes their laptop.
 *
 * It cannot be fixed from here: `loginctl enable-linger` is privileged. What `up`
 * does instead is *check* it and report, because a prerequisite that is checked and
 * named is a different thing from one buried in a README.
 */
export const LINGER_PREREQUISITE =
  'sudo loginctl enable-linger $USER — without it these services stop at logout and do not start at boot';

/** Where one deployment's files live, resolved for one user. */
export interface Layout {
  /** The install root: `$XDG_DATA_HOME/tempo`. Overwritten by every deploy. */
  installRoot: string;
  /** The installed server artifact. */
  serverArtifact: string;
  /**
   * The installed worker artifact — one file, run twice.
   *
   * The two worker services are the same bytes with a different `--role`, which is
   * why the roles deploy separately without building anything twice.
   */
  workerArtifact: string;
  /**
   * Where history goes: `$XDG_STATE_HOME/tempo`. The server is told this as
   * `--data-dir` and `up` creates it.
   *
   * **The single source of truth for it**, deliberately not also declared as
   * `StateDirectory=` in the units — see `units.ts` for why naming it twice is the
   * risk.
   */
  stateDir: string;
  /** Where systemd reads this user's unit files: `$XDG_CONFIG_HOME/systemd/user`. */
  unitDir: string;
}

/**
 * Resolve a layout for the user this process is running as.
 *
 * Takes the `Host` rather than reading the environment directly, so a spec can
 * describe a user without one existing — the same reason every other function here
 * takes it.
 */
export function resolveLayout(host: Host): Layout {
  const paths = host.userPaths();
  const installRoot = `${paths.data}/${DEPLOYMENT_NAME}`;
  return {
    installRoot,
    serverArtifact: `${installRoot}/server.js`,
    workerArtifact: `${installRoot}/worker.js`,
    stateDir: `${paths.state}/${DEPLOYMENT_NAME}`,
    unitDir: `${paths.config}/systemd/user`,
  };
}

/** Where a unit file goes. Takes the bare name; adds the `.service` suffix. */
export function unitPath(layout: Layout, unit: string): string {
  return `${layout.unitDir}/${unit}.service`;
}
