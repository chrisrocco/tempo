/**
 * @fileoverview
 * `tempo` — argument parsing and command dispatch. Commands live in sibling
 * modules; this file owns only the surface: which words map to which call, and
 * turning a thrown error into an exit code.
 *
 * Built today: `up <entry>` (run server + worker in the foreground) and the
 * workflow-driving commands `start` / `result` / `signal` / `cancel`.
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
  fetchResult,
  parseWorkflowArg,
  resolveServerUrl,
  sendSignal,
  startWorkflow,
} from './client';
import { up } from './up';

const USAGE = `tempo — run and drive workflows

Usage:
  tempo up <entry> [--port=N] [--data-dir=PATH]
      Run a server and worker in the foreground. Ctrl-C to stop.

  tempo start <workflow> [args...] [--wait]
      Start a workflow. Arguments are parsed as JSON, else taken as strings.
      --wait blocks and prints the result instead of the workflow id.

  tempo result <workflow-id>       Fetch the outcome of an existing run.
  tempo signal <workflow-id> <name> [payload]
  tempo cancel <workflow-id>       Request cancellation.

Options:
  --server=URL   Server to talk to. Default $TEMPO_SERVER_URL, else
                 http://127.0.0.1:7233.
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
  return { positionals, flags };
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
  return value;
}

async function dispatch(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const [command, ...rest] = positionals;
  const serverUrl = resolveServerUrl(flags.get('server') || undefined);

  switch (command) {
    case 'up': {
      const port = flags.get('port');
      return up({
        entry: required(rest[0], 'worker entrypoint'),
        port: port === undefined ? undefined : Number(port),
        dataDir: flags.get('data-dir') || undefined,
      });
    }
    case 'start':
      return startWorkflow(
        serverUrl,
        required(rest[0], 'workflow name'),
        rest.slice(1).map(parseWorkflowArg),
        flags.has('wait'),
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
    return 1;
  }
}
