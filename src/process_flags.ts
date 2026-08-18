/**
 * @fileoverview
 * How a deployed process reads its own configuration out of its argv.
 *
 * Two callers: `src/server_main.ts` and `src/tempo.ts`. They have to agree on
 * the spelling with **whoever writes the command line that launches them**, and
 * that someone is now always outside this repo — a systemd unit, a container
 * spec, a supervisor config, a shell script. A server reading `--port` while its
 * launcher writes `--listen` is a deployment that starts and serves nobody.
 *
 * That is why `SERVER_FLAG`, `WORKER_FLAG`, and `formatFlag` are exported from
 * `src/index.ts` rather than kept internal. They used to be shared with a
 * deployment module in this tree that rendered the unit files itself; with that
 * module gone (see `README.md`), the only way the two sides can still share one
 * spelling is for the vocabulary to be part of the published surface. A launcher
 * that imports these constants cannot drift from the processes that read them.
 *
 * This reads a handful of named values from a command line something else wrote.
 * It is not a command-line parser: no positionals, no `--` separator, no notion
 * of a command. Whoever assembles a CLI on top of this repo brings their own argv
 * conventions, and a deployed artifact has no business carrying them.
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
 * The second reason is that the launch site becomes the deployment's
 * configuration — whatever shows a service's command line (`systemctl cat`, a pod
 * spec, a process listing) shows what it was started with, in one place. An
 * environment file shared between the server and the workers had two sources of
 * truth for the port and no way to keep them in step.
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
 * The flags `startServer` reads.
 *
 * Named constants rather than string literals at each site, because something
 * outside this repo writes these same flags into whatever launches the process. A
 * launcher emitting `--listen=7777` where the server reads `--port` produces a
 * deployment that starts, reports healthy, and serves nobody — the expensive kind
 * of wrong, because nothing fails.
 *
 * Sharing the constant makes that disagreement a **compile error rather than a
 * spec's job**: there is one spelling, and both sides read it from here.
 */
export const SERVER_FLAG = {
  host: 'host',
  port: 'port',
  dataDir: 'data-dir',
  activityLeaseMs: 'activity-lease-ms',
  retainClosedForMs: 'retain-closed-for-ms',
} as const;

/**
 * The flags `startWorker` reads, shared with a launcher for the same reason.
 *
 * `local` and `args` are the odd pair out: they are not deployment overrides at
 * all — nothing that supervises a worker should ever set them — but a way to run
 * the built artifact once, by hand, with no server. They live here because they
 * are read from the same argv by the same helpers, and because a launcher needs
 * to be able to name them in order to be sure it is *not* passing them. See
 * `tempo.ts`.
 */
export const WORKER_FLAG = {
  server: 'server',
  queue: 'queue',
  role: 'role',
  local: 'local',
  args: 'args',
  activityConcurrency: 'activity-concurrency',
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
