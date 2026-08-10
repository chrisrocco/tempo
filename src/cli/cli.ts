/**
 * @fileoverview
 * `tempo` — argument parsing and command dispatch. Commands live in sibling
 * modules; this file owns only the surface: which words map to which call, and
 * turning a thrown error into an exit code.
 *
 * The surface being built is in `src/cli/README.md`, which is the design this
 * implements: `up` and `down` to deploy and undeploy, `start` and `result` to
 * drive workflows, `status` to see what a deployment is doing. Commands land one
 * at a time and `USAGE` lists only what exists, so what this prints is always
 * what it can do.
 *
 * **No command reads the environment for its configuration.** Every input is a
 * flag with a default — the reasoning is in the README, and the short version is
 * that an environment variable is inherited and a flag is not.
 */

import {
  flag,
  hasFlag,
  parseArgs,
  parseWorkflowArg,
  requirePositional,
} from './args';
import {fetchResult, resolveServerUrl, startWorkflow} from './executions';

const USAGE = `tempo — deploy and drive workflows

Usage:
  tempo start <workflow> [args...] [--wait] [--queue=NAME]
      Start a workflow. Arguments are parsed as JSON, else taken as strings.
      Prints the workflow id; --wait blocks and prints the result instead,
      exiting non-zero if the workflow failed.
      --queue picks the worker pool; default is "default". A queue nothing
      is polling parks the execution, so it has to match the deployment.

  tempo result <workflow-id>
      The outcome of an execution that already exists, blocking until it
      settles. What the id from a bare "tempo start" is for.

Options:
  --server=URL   Server to talk to. Default ${resolveServerUrl(undefined)}.
  --            Ends flag parsing: everything after it is an argument for
                the workflow, so "-- --thing" passes "--thing" through.
`;

async function dispatch(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positionals;
  const serverUrl = resolveServerUrl(flag(args, 'server'));

  switch (command) {
    case 'start':
      return startWorkflow({
        serverUrl,
        name: requirePositional(rest, 0, 'workflow name'),
        args: rest.slice(1).map(parseWorkflowArg),
        wait: hasFlag(args, 'wait'),
        taskQueue: flag(args, 'queue'),
      });
    case 'result':
      return fetchResult(serverUrl, requirePositional(rest, 0, 'workflow id'));
    case undefined:
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

/** Run one command line. Returns the process exit code; never throws. */
export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    process.stderr.write(
      `tempo: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    // A workflow that failed carries the stack from where it actually broke —
    // in an activity, in another process. Usage errors and unreachable-server
    // errors are thrown right here, and their stack is only ever this file, so
    // they are filtered out by asking whether the stack says anything the
    // message did not.
    if (e instanceof Error && e.stack && !isLocalStack(e.stack))
      process.stderr.write(`${e.stack}\n`);
    return 1;
  }
}

/**
 * Was this error thrown by the CLI itself? Such a stack begins in `src/cli/` and
 * tells the user nothing they cannot see from the message — printing it turns
 * every typo into a wall of frames.
 */
function isLocalStack(stack: string): boolean {
  const firstFrame = stack.split('\n').find((l) => l.trim().startsWith('at '));
  return firstFrame === undefined || /[/\\]src[/\\]cli[/\\]/.test(firstFrame);
}
