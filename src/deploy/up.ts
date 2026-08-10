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
 * ## It needs no privilege, and refuses to have any
 *
 * These are systemd **user** units, installed under the invoking user's own
 * directories, so `up` runs as an ordinary user and so do the workflows. That is
 * the inversion of what this function used to be: it required root, wrote `/opt`
 * and `/etc/systemd/system`, and created a `tempo` system account.
 *
 * It now **refuses to run as root**, which is not symmetry for its own sake. Under
 * `sudo` every path here resolves against root's home, so a deploy would install a
 * deployment into `/root/.local/share/tempo` and start services owned by root that
 * the operator cannot see with their own `systemctl --user`. It would appear to
 * work and produce nothing the user asked for.
 *
 * ## The order is the design
 *
 * 1. **Refuse if root**, before touching anything.
 * 2. **Install the artifacts** — dereferenced, and atomically. See
 *    `ports/host.ts`.
 * 3. **Write the units.**
 * 4. **`daemon-reload`**, or systemd keeps serving the unit it last loaded and a
 *    changed `ExecStart` is silently ignored.
 * 5. **`enable`**, or the deployment is gone the first time this user logs out.
 * 6. **`restart`, server first.** Nothing rereads a `.js` in place, so the
 *    restart *is* the deployment.
 *
 * Steps 4–6 are the three whose omission looks exactly like success, which is
 * why each is a named call with a reason attached rather than a line in a script.
 *
 * ## What it does not do
 *
 * **It does not enable lingering**, because it cannot — that is privileged. It
 * checks and reports instead. See `UpResult.lingering`.
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
import {LINGER_PREREQUISITE, resolveLayout, unitPath} from './layout';
import type {Host} from './ports/host';
import {daemonReload, enable, isLingerEnabled, restart} from './systemctl';
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
  /**
   * Absolute path to the interpreter the units should run. Defaults to
   * `Host.interpreterPath()` — the node running this process.
   *
   * The default is right whenever `up` is invoked by the person whose services
   * these are, which is the normal case for a per-user deployment: their node
   * exists, and it is the version the artifacts were built against.
   *
   * Worth overriding when the deploying process is *not* running the interpreter
   * the services should use — a wrapper script under a different node, or a CLI
   * shipped as a single-file executable, where `process.execPath` is that
   * executable rather than node.
   */
  node?: string;
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
  /** Where the artifacts and units went, so a caller can say. */
  installRoot: string;
  /**
   * The interpreter the units were written to run.
   *
   * Reported because it is resolved rather than fixed, and because it is the field
   * most worth reading back: a deployment that will not start usually has a wrong
   * one here, and it is otherwise only visible by reading the unit file.
   */
  nodeBin: string;
  /**
   * Whether this user's services survive logging out.
   *
   * `false` means the deploy worked and **will not outlast the session**: user
   * units without lingering stop at logout and do not start at boot. It is not an
   * error — the deployment is running right now and correct — which is exactly why
   * it has to be reported rather than thrown or ignored. `lingerPrerequisite`
   * carries the one command that fixes it.
   */
  lingering: boolean;
  /** The privileged one-time command that enables lingering, when it is not on. */
  lingerPrerequisite?: string;
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
    nodeBin: options.node ?? host.interpreterPath(),
  };

  // Before the first write, not after the first surprise. Under sudo every path
  // below resolves against root's home, so this would deploy somewhere the
  // operator cannot see and start services they did not ask for.
  if (host.euid() === 0)
    throw new Error(
      'tempo up must not run as root: these are systemd user units, and under sudo they would install into root’s home and run as root. Run it as the user the workflows should run as.',
    );

  const layout = resolveLayout(host);

  await host.makeDirectory(layout.installRoot);
  // Created here rather than by a `StateDirectory=` in the units, so that the path
  // history lives at is stated exactly once — see `units.ts`. Belt and braces
  // either way: the store also creates it on open.
  await host.makeDirectory(layout.stateDir);
  await host.installFile(options.server, layout.serverArtifact);
  await host.installFile(options.worker, layout.workerArtifact);

  // The unit directory may not exist on a machine that has never had a user unit.
  await host.makeDirectory(layout.unitDir);
  const units = allUnits(layout, config);
  for (const [unit, text] of units)
    await host.writeFile(unitPath(layout, unit), text);

  const names = units.map(([unit]) => unit);
  await daemonReload(host);
  await enable(host, names);
  // Server first: the workers then reconnect to something coming up rather than
  // spending their first backoff on something going down.
  for (const unit of names) await restart(host, unit);

  // Asked last, because it describes what happens *after* this deploy rather than
  // whether the deploy worked, and because it must not be able to fail one.
  const lingering = await isLingerEnabled(host);

  return {
    port: config.port,
    host: config.host,
    installed: [layout.serverArtifact, layout.workerArtifact],
    units: names,
    installRoot: layout.installRoot,
    nodeBin: config.nodeBin,
    lingering,
    ...(lingering ? {} : {lingerPrerequisite: LINGER_PREREQUISITE}),
  };
}
