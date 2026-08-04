/**
 * @fileoverview
 * `tempo` — argument parsing and command dispatch. Commands live in sibling
 * modules; this file owns only the surface: which words map to which call, and
 * turning a thrown error into an exit code.
 *
 * Built today: `up <entry>` (run server + worker in the foreground, or one
 * workflow to completion with `--run`), the workflow-driving commands
 * `start` / `result` / `signal` / `cancel`, and the read-only `list` /
 * `describe` / `queues`.
 *
 * The deployment half of the surface is designed but not built (tracked in
 * planning/sprints/01-deployment-api.md). The target:
 *
 *   tempo build <entry>              build an entrypoint into a binary
 *   tempo server install             install + start the server
 *                                      --port=N       (default 7233)
 *                                      --data-dir=PATH (unset = in-memory)
 *   tempo deploy <binary>            install/update a worker, roll its replicas
 *                                      --workflow-replicas=N (default 1)
 *                                      --activity-replicas=N (default 2)
 *   tempo status                     health of the server + each worker role
 *   tempo logs <name> [--role=]      tail a worker role's logs
 *   tempo rollback <name>            revert to the previous version
 *
 * `deploy` is meant to interrogate the artifact via `--describe` (see
 * describe.ts) rather than be handed a config file, so deployment config lives in
 * the environment and never in code.
 */

import {
  cancelWorkflow,
  describeExecution,
  fetchResult,
  listExecutions,
  listQueues,
  parseWorkflowArg,
  resolveServerUrl,
  sendSignal,
  startWorkflow,
  terminateWorkflow,
} from './client';
import {up} from './up';

const USAGE = `tempo — run and drive workflows

Usage:
  tempo up <entry> [--host=ADDR] [--port=N] [--data-dir=PATH] [--ui]
      Run a server and worker in the foreground. Ctrl-C to stop.
      --host is the interface the server binds; default 127.0.0.1. Use
      0.0.0.0 to let workers or an external CLI connect from other machines.
      The RPC has no auth or TLS, so keep that on a private network.

  tempo up <entry> --run=<workflow> [args...] [--task-queue=NAME]
      One-shot: bring up a server and worker, run one workflow to completion,
      print its result, and stop. The whole distributed round-trip in one
      command — no ports to pick, no readiness to guess at.

  tempo start <workflow> [args...] [--wait] [--task-queue=NAME]
      Start a workflow. Arguments are parsed as JSON, else taken as strings.
      --wait blocks and prints the result instead of the workflow id.
      --task-queue picks the worker pool; default is "default".

  tempo result <workflow-id>       Fetch the outcome of an existing run.
  tempo signal <workflow-id> <name> [payload]
  tempo cancel <workflow-id>       Request cancellation (cooperative).
  tempo terminate <workflow-id> [reason]
      End an execution outright, without replaying it. Use this when cancel
      cannot land — a workflow whose replay is what fails.

  tempo list [--json] [--stuck] [--name=] [--queue=] [--limit=N] [--cursor=]
      Executions the server knows about, newest first.
      Rows the engine cannot replay are marked STUCK with the failure count
      and reason; --stuck shows only those. A stuck execution still reads
      "running" — it is live and retrying, not settled.
  tempo describe <workflow-id> [--json] [--from=N] [--limit=N]
      Status, what the execution is waiting on, and its history. Long
      histories show the most recent page; --from=0 starts at the beginning.
  tempo queues [--json]
      Which task queues workers are polling, per role. The question the
      execution commands cannot answer: an execution parked on an activity
      reads the same whether a worker is about to claim it or nothing has
      ever polled its queue. A queue that reads "live" is being asked for
      work right now. Note that a worker busy inside a long activity stops
      polling, so a silent queue means "nothing is asking" — which is
      either no worker, or every worker saturated.

Options:
  --server=URL   Server to talk to. Default $TEMPO_SERVER_URL, else
                 http://127.0.0.1:7233.
  --json         Machine-readable output, for list, describe, and queues.
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/** `--key=value` and bare `--key` (which reads as an empty string). */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.set(body, '');
    else flags.set(body.slice(0, eq), body.slice(eq + 1));
  }
  return {positionals, flags};
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
  return value;
}

async function dispatch(argv: string[]): Promise<number> {
  const {positionals, flags} = parseArgs(argv);
  const [command, ...rest] = positionals;
  const serverUrl = resolveServerUrl(flags.get('server') || undefined);

  switch (command) {
    case 'up': {
      const port = flags.get('port');
      const run = flags.get('run');
      return up({
        entry: required(rest[0], 'worker entrypoint'),
        host: flags.get('host') || undefined,
        port: port === undefined ? undefined : Number(port),
        dataDir: flags.get('data-dir') || undefined,
        // The dashboard is its own process and its own package; `up` only
        // decides whether to start it.
        dashboard: flags.has('ui'),
        // Positionals after the entry are the workflow's arguments, parsed the
        // same way `tempo start` parses them.
        run: run
          ? {
              name: run,
              args: rest.slice(1).map(parseWorkflowArg),
              taskQueue: flags.get('task-queue') || undefined,
            }
          : undefined,
      });
    }
    case 'start':
      return startWorkflow(
        serverUrl,
        required(rest[0], 'workflow name'),
        rest.slice(1).map(parseWorkflowArg),
        flags.has('wait'),
        flags.get('task-queue') || undefined,
      );
    case 'result':
      return fetchResult(serverUrl, required(rest[0], 'workflow id'));
    case 'signal':
      return sendSignal(
        serverUrl,
        required(rest[0], 'workflow id'),
        required(rest[1], 'signal name'),
        rest[2] === undefined ? undefined : parseWorkflowArg(rest[2]),
      );
    case 'cancel':
      return cancelWorkflow(serverUrl, required(rest[0], 'workflow id'));
    case 'terminate':
      return terminateWorkflow(
        serverUrl,
        required(rest[0], 'workflow id'),
        rest[1] ?? 'terminated via tempo',
      );
    case 'list':
      return listExecutions(serverUrl, flags.has('json'), {
        // Only send what was asked for: an explicit `stuck: false` would mean
        // "only healthy ones", which is not what omitting the flag means.
        ...(flags.has('stuck') ? {stuck: true} : {}),
        ...(flags.get('name') ? {name: flags.get('name')} : {}),
        ...(flags.get('queue') ? {taskQueue: flags.get('queue')} : {}),
        ...(flags.get('limit') ? {limit: Number(flags.get('limit'))} : {}),
        ...(flags.get('cursor') ? {cursor: flags.get('cursor')} : {}),
      });
    case 'queues':
      return listQueues(serverUrl, flags.has('json'));
    case 'describe':
      return describeExecution(
        serverUrl,
        required(rest[0], 'workflow id'),
        flags.has('json'),
        {
          ...(flags.get('from') ? {fromEvent: Number(flags.get('from'))} : {}),
          ...(flags.get('limit') ? {limit: Number(flags.get('limit'))} : {}),
        },
      );
    case undefined:
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

export async function runCli(argv: string[]): Promise<number> {
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
