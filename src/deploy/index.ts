/**
 * @fileoverview
 * ★ DEPLOYMENT ENTRYPOINT — install, stop, and inspect a tempo deployment.
 *
 * Five functions over one seam:
 *
 *   up(options, host)       copy two artifacts in, install three units, start them
 *   down(host)              stop those units and stop them coming back on boot
 *   status(options, host)   what the deployment is doing, from systemd and the server
 *   restart(target, host)   bounce services without touching what is installed
 *   logs(options, host)     what a service has been saying
 *
 * `up` and `down` are the deployment's lifecycle; `status`, `restart`, and `logs`
 * are what you do to one that already exists. The split matters most for
 * `restart`: reaching for `up` to bounce a wedged worker would reinstall from
 * whatever artifact paths happened to be at hand.
 *
 * **This is a library, not a command-line tool.** Typed options in, typed values
 * out, nothing printed: no `process.stdout`, no exit codes, no `process.argv`.
 * Assembling a CLI on top — parsing arguments, formatting output, choosing exit
 * codes — is the consumer's job, and every argv convention baked in here would be
 * one they had to work around.
 *
 * `host` is the machine, passed in rather than reached for, because every one of
 * these functions exists to run `systemctl` and write `/opt` and neither is
 * available in a spec. Pass `systemHost()` for the real thing.
 *
 * ```ts
 * import {up, systemHost} from './src/deploy';
 *
 * await up({server: 'out/server.js', worker: 'out/worker.js'}, systemHost());
 * ```
 *
 * **Driving workflows is not here.** Starting one and awaiting its result is
 * `src/client/` over a `WorkflowService`, which already is the library form of
 * both; a wrapper adding nothing but a different name would be worse than none.
 * `status` is the exception only because "is anything listening" is a value it
 * has to return rather than an exception it can throw.
 */

export {down, type DownResult, type UnitOutcome} from './down';
export {
  ALL_UNITS,
  INSTALL_ROOT,
  NODE_BIN,
  SERVER_ARTIFACT,
  SERVER_UNIT,
  SERVICE_USER,
  STATE_DIR,
  WORKER_ARTIFACT,
  WORKER_UNITS,
  unitPath,
} from './layout';
export {
  logs,
  restart,
  unitsFor,
  type LogOptions,
  type RestartResult,
  type Target,
  type UnitLog,
} from './operate';
export type {CommandResult, Host} from './ports/host';
export {
  status,
  type DeploymentStatus,
  type QueueReport,
  type ServerReport,
  type ServerUnreachable,
  type StatusOptions,
  type UnitsReport,
  type UnitsUnavailable,
} from './status';
export {systemHost} from './system_host';
export {type UnitState} from './systemctl';
export {
  allUnits,
  serverArgs,
  serverUnit,
  workerArgs,
  workerServerUrl,
  workerUnit,
  type UnitConfig,
} from './units';
export {up, type UpOptions, type UpResult} from './up';
