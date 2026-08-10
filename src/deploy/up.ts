/**
 * @fileoverview
 * `up` — install two built artifacts as three supervised services, and start
 * them. Calling it again is how a new version is deployed.
 *
 * **Both paths are to final `.js` files. The caller builds; this copies.** That
 * is the whole contract, and it is what keeps a build system out of this library:
 * with Blaze, deploying is `blaze build` followed by this call, with no adapter
 * anywhere. Two earlier designs lost that property — one had a run verb deploying
 * on demand, the other resolved build *targets* through a toolchain — so it is
 * stated as a goal rather than left to be noticed.
 *
 * ## The order is the design
 *
 * 1. **Refuse without root**, before touching anything. A permission error found
 *    halfway through is a partial deploy; a refusal is not.
 * 2. **Ensure the service user**, because the units name it and systemd will not
 *    invent it.
 * 3. **Install the artifacts** — dereferenced, and atomically. See
 *    `ports/host.ts`.
 * 4. **Write the units.**
 * 5. **`daemon-reload`**, or systemd keeps serving the unit it last loaded and a
 *    changed `ExecStart` is silently ignored.
 * 6. **`enable`**, or the deployment is gone the first time the host reboots.
 * 7. **`restart`, server first.** Nothing rereads a `.js` in place, so the
 *    restart *is* the deployment.
 *
 * Steps 5–7 are the three whose omission looks exactly like success, which is
 * why each is a named call with a reason attached rather than a line in a script.
 *
 * ## What it does not do
 *
 * **It does not create `/var/lib/tempo`.** The units declare
 * `StateDirectory=tempo` and systemd creates and chowns it before every
 * `ExecStart`, which also holds when someone deletes it between deploys.
 *
 * **It does not write `VERSION`.** The layout has a place for artifact
 * fingerprints and nothing reads them yet; what they are *for* — catching a
 * worker replaying history written by different code — needs the fingerprint to
 * travel on the worker's poll, not to sit in a file. Writing one now would be a
 * file that rots. See `README.md`, question 2.
 *
 * **It does not stop in-flight work first.** Activity attempts die with the
 * restart. That is acceptable rather than ignored: activities are at-least-once
 * and expected to be idempotent, so the engine recovers by redelivering them.
 * It is a real consequence and this is where it is written down.
 */

import {DEFAULT_PORT} from '../process_flags';
import {
  INSTALL_ROOT,
  SERVER_ARTIFACT,
  SERVICE_USER,
  WORKER_ARTIFACT,
  unitPath,
} from './layout';
import type {Host} from './ports/host';
import {daemonReload, enable, restart} from './systemctl';
import {allUnits, type UnitConfig} from './units';

/** What to deploy, and the little a deployment varies. */
export interface UpOptions {
  /** Path to a built server artifact — a final `.js` file. */
  server: string;
  /** Path to a built worker artifact — a final `.js` file, run twice. */
  worker: string;
  /** What the server binds and the workers dial. Default `DEFAULT_PORT`. */
  port?: number;
  /**
   * The interface the server binds. Default `127.0.0.1`, which is the only
   * default that is safe without further thought — the RPC has no auth and no
   * TLS. `0.0.0.0` lets other machines connect; keep it on a private network.
   */
  host?: string;
}

/** What a deploy did, so a caller can report it without guessing. */
export interface UpResult {
  /** The port the units were written with. */
  port: number;
  /** The interface the server unit binds. */
  host: string;
  /** Absolute paths the artifacts were installed to. */
  installed: readonly string[];
  /** Unit names written, enabled, and restarted — server first. */
  units: readonly string[];
  /** True when the service user did not exist and was created. */
  createdUser: boolean;
}

/**
 * Does this account exist?
 *
 * `id` exits non-zero for an unknown user, which is an answer rather than a
 * failure — hence `run` rather than a throwing helper.
 */
async function userExists(host: Host, user: string): Promise<boolean> {
  const result = await host.run('id', ['-u', user]);
  return result.code === 0;
}

/**
 * Create the unprivileged account the services run as.
 *
 * `--system` keeps it out of the human uid range and gives it no expiry;
 * no home directory and no login shell because nothing ever logs in as it. The
 * account exists to own `/var/lib/tempo` and to be something other than root.
 */
async function createUser(host: Host, user: string): Promise<void> {
  const result = await host.run('useradd', [
    '--system',
    '--no-create-home',
    '--shell',
    '/usr/sbin/nologin',
    user,
  ]);
  if (result.code !== 0)
    throw new Error(
      `could not create the ${user} user (exit ${result.code})` +
        `${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
    );
}

/**
 * Install and start a deployment. See the fileoverview for why the order is what
 * it is.
 *
 * Throws rather than reporting failure in the result: a deploy that did not
 * finish is not a state a caller should have to inspect for, and the exception
 * carries what systemd said. `UpResult` describes a deploy that happened.
 */
export async function up(options: UpOptions, host: Host): Promise<UpResult> {
  const config: UnitConfig = {
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? '127.0.0.1',
  };

  // Before the first write, not after the first failure.
  const euid = host.euid();
  if (euid !== 0)
    throw new Error(
      `tempo up must run as root: it writes ${INSTALL_ROOT} and installs systemd units (effective uid ${euid})`,
    );

  const createdUser = !(await userExists(host, SERVICE_USER));
  if (createdUser) await createUser(host, SERVICE_USER);

  await host.makeDirectory(INSTALL_ROOT);
  await host.installFile(options.server, SERVER_ARTIFACT);
  await host.installFile(options.worker, WORKER_ARTIFACT);

  const units = allUnits(config);
  for (const [unit, text] of units) await host.writeFile(unitPath(unit), text);

  const names = units.map(([unit]) => unit);
  await daemonReload(host);
  await enable(host, names);
  // Server first: the workers then reconnect to something coming up rather than
  // spending their first backoff on something going down.
  for (const unit of names) await restart(host, unit);

  return {
    port: config.port,
    host: config.host,
    installed: [SERVER_ARTIFACT, WORKER_ARTIFACT],
    units: names,
    createdUser,
  };
}
