/**
 * @fileoverview
 * How a deployed process reads its own configuration out of its argv.
 *
 * Two callers: `bin/server-main.ts` and `src/tempo.ts`. They have to agree on
 * the spelling, because `tempo up` writes both of their command lines into
 * systemd units from one set of values — a server reading `--port` while the
 * unit writes `--listen` is a deployment that starts and serves nobody.
 *
 * This reads a handful of named values from a command line a machine wrote — the
 * unit files `deploy/` renders. It is not a command-line parser: no positionals,
 * no `--` separator, no notion of a command. Whoever assembles a CLI on top of
 * this repo brings their own argv conventions, and a deployed artifact has no
 * business carrying them.
 *
 * ## Why flags and not environment variables
 *
 * These values used to be `HOST`, `PORT`, `DATA_DIR`, `TEMPO_SERVER_URL`,
 * `TEMPO_TASK_QUEUE`, and `TEMPO_ROLE`. **An environment variable is inherited
 * and a flag is not**, and every failure that mattered here came from the
 * inheritance: a `TEMPO_SERVER_URL` exported in a shell, or picked up by a worker
 * spawned from a test, points a process at the wrong server while it still prints
 * its readiness line and looks healthy to its supervisor.
 *
 * The second reason is that the unit file becomes the deployment's configuration
 * — `systemctl cat tempo-server` shows what it was started with, in one place,
 * written by one command. An environment file shared between the server and the
 * workers had two sources of truth for the port and no way to keep them in step.
 *
 * The cost, recorded because it is the reason someone might come back here: a
 * container orchestrator configures processes through the environment, so a
 * Kubernetes deployment of these artifacts has to build an argv rather than set
 * variables.
 *
 * ## Unknown flags are ignored, and that is not laziness
 *
 * A typo'd flag is silently ignored, exactly as a typo'd environment variable
 * was. Rejecting unknown flags would be better, and it is not available: these
 * functions read `process.argv` of whatever process is running, and
 * `startWorker` is called in-process by specs under a test runner whose own argv
 * carries `--config=` and `--filter=`. A worker that refused an argv it did not
 * recognize would refuse to start inside every spec that constructs one.
 *
 * What *is* checked is the value of a flag that was given: a bare `--role` or a
 * `--port=nonsense` fails at startup rather than being read as absent. That
 * covers the realistic deployment mistake — a flag written wrong — while leaving
 * the flag written *elsewhere* alone.
 */

/**
 * The port the server binds and workers dial when nothing says otherwise.
 *
 * Lives here rather than beside either of them because both have to agree: this
 * is the one number that, if the two sides disagree, produces a deployment where
 * every process is healthy and no work ever moves. `DEFAULT_SERVER_URL` in
 * `tempo.ts` is built from it for that reason.
 */
export const DEFAULT_PORT = 7777;

/**
 * The flags `bin/server-main.ts` reads.
 *
 * Named constants rather than string literals at each site, because
 * `deploy/units.ts` writes these same flags into the systemd unit that launches
 * that process. A unit emitting `--listen=7777` where the server reads `--port`
 * produces a deployment that starts, reports healthy, and serves nobody — the
 * expensive kind of wrong, because nothing fails.
 *
 * Sharing the constant makes that disagreement a **compile error rather than a
 * spec's job**: there is one spelling, and both sides read it from here.
 */
export const SERVER_FLAG = {
  host: 'host',
  port: 'port',
  dataDir: 'data-dir',
  activityLeaseMs: 'activity-lease-ms',
} as const;

/** The flags `src/tempo.ts` reads, shared with `deploy/units.ts` for the same reason. */
export const WORKER_FLAG = {
  server: 'server',
  queue: 'queue',
  role: 'role',
} as const;

/** `--name=value`, the only spelling anything here writes or reads. */
export function formatFlag(name: string, value: string | number): string {
  return `--${name}=${value}`;
}

/**
 * The value of `--name=…`, or `undefined` if it was not given.
 *
 * Throws when the flag is present without a value. `--data-dir` alone is someone
 * who meant to say where the history goes; reading it as "unset" would start a
 * server that keeps its history in memory and loses it on the next restart,
 * which is the single most expensive thing this file can get wrong.
 */
export function flagValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}`;
  const found = argv.find(
    (arg) => arg === prefix || arg.startsWith(`${prefix}=`),
  );
  if (found === undefined) return undefined;

  const value = found.slice(prefix.length + 1);
  if (value === '') throw new Error(`${prefix} needs a value, as ${prefix}=…`);
  return value;
}

/**
 * The value of `--name=…` as a number, or `undefined` if it was not given.
 *
 * A non-numeric value throws rather than becoming `NaN`. `--port=localhost` is a
 * mistake worth failing on: `NaN` reaches `listen()` as "pick any port", so the
 * process would come up healthy on a port nothing was told about.
 */
export function numericFlagValue(
  argv: readonly string[],
  name: string,
): number | undefined {
  const raw = flagValue(argv, name);
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`--${name} must be a number (got "${raw}")`);
  return value;
}
