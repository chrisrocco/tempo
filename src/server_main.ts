/**
 * @fileoverview
 * ★ SERVER ENTRYPOINT — the single call a deployable server binary makes.
 *
 * `startServer({dataDir})` opens the store, builds the host, resumes what was
 * running, binds the port, and wires shutdown. The counterpart to
 * `Tempo.startWorker` in `tempo.ts`: a deployment is **two artifacts**, one per
 * entrypoint, and each is a file whose whole body is one call into this library.
 *
 *   server.ts   startServer({dataDir: '/var/lib/tempo'})
 *   worker.ts   Tempo.startWorker({name: 'orders', workflows, activities})
 *
 * Flags — see `process_flags.ts` for why these are flags and not environment
 * variables:
 *   --host=ADDR            interface to bind (default `127.0.0.1`)
 *   --port=N               listen port (default 7777, 0 = random)
 *   --data-dir=PATH        persist history here and `resume()` on boot; unset is
 *                          in-memory and loses everything on restart
 *   --activity-lease-ms=N  activity-task lease timeout
 *
 * ## Why this is a function and not only a script
 *
 * It used to be only `bin/server-main.ts` — a script, in this repo's tree, whose
 * composition (`createServerHost`, `createRpcServer`, `FileHistoryStore.open`)
 * was unexported and unreachable from outside. Anyone consuming this library
 * under their own build system had no supported way to *produce a server*: they
 * could bundle their own worker, because `startWorker` is a function, and then
 * had nothing to point it at.
 *
 * That asymmetry was invisible while a deployment library lived here and knew
 * both paths itself. Now that assembling a deployment is entirely the consumer's
 * job (see `README.md`), the two artifacts have to be equally buildable, and that
 * means both entrypoints have to be *values*. `bin/server-main.ts` still exists
 * and is still what the specs spawn — it is now the reference invocation of this
 * function, and the file a consumer copies.
 *
 * ## The options object is the configuration, and three flags override it
 *
 * Exactly the rule `tempo.ts` states for workers, for exactly its reasons: the
 * options object is the whole configuration, read in one type-checked place, and
 * the launch site may override the values a *deployment* changes about an
 * artifact it did not build — which server, which port, which interface, and
 * where state goes. An override wins when given.
 *
 * `activityLeaseMs` is also readable from argv, because it is the one knob an
 * operator turns while diagnosing a live redelivery problem, and because
 * `bin/server-main.ts` accepted it before this function existed.
 *
 * ## Readiness: `health()` is the contract, `LISTENING` is a convenience
 *
 * This prints `LISTENING <port> <host>` on stdout once bound, and that line is
 * **not** the supported way to know a server is up. It cannot be: it is only
 * observable by whoever spawned the process, with a pipe held open, on the same
 * machine, at the moment it started. A supervisor that restarts the server, or a
 * tool run an hour later, sees none of it.
 *
 * The supported probe is `RemoteClient.health()` — it answers from anywhere, at
 * any time, about a process nobody here spawned, and it also reports `durable`,
 * which is the field that distinguishes a healthy server from one that will lose
 * every execution on its next restart. `queues()` is its companion for workers.
 *
 * It now also reports **where this server is bound** — interface, port, and
 * machine hostname (see `ServerEndpoint`). That is resolved here, from the
 * `AddressInfo` the listen callback hands back, and pushed into the host: the
 * host is the tier that answers probes and this is the tier that knows, so the
 * knowledge has to cross once, at bind.
 *
 * The line stays for the two jobs it is genuinely good at: a human watching a
 * terminal, and **learning the port after `--port=0`** without a connection —
 * which is how the specs that spawn this as a subprocess get an arbitrary port
 * without racing for one. Anything that can already connect should ask
 * `health()` instead. In-process callers need neither: `Server.port` is the
 * bound port, and `--port=0` resolves in the returned value.
 *
 * ## Operational notes
 *
 * - **Binds `127.0.0.1` by default.** Right for a single VM with everything
 *   co-located, and the right default because it is the only one that is safe
 *   without further thought. Pass `--host=0.0.0.0` to put workers on other
 *   machines — but the RPC has **no auth and no TLS** (see `services/rpc_server`),
 *   so anything that can reach the port can start, signal, and terminate
 *   executions. Keep it on a private network or behind a proxy that terminates
 *   TLS and authenticates; do not expose it to the internet.
 * - **The port defaults to 7777 rather than to 0.** A random default is right for
 *   a test and wrong for a deployment: workers dial `DEFAULT_SERVER_URL`, so a
 *   server that picked its own port would be one nothing could find, with every
 *   process reading healthy.
 * - **One server per data dir.** The `--data-dir` lockfile enforces it. A crashed
 *   server's stale lock self-heals: the next boot checks whether the recorded pid
 *   is still alive and reclaims it, so a supervisor with `Restart=always` will not
 *   deadlock on a lock the dead process never released.
 * - **Single writer, single point of failure.** Scaling is horizontal on
 *   *workers*; server HA is Phase 6 and not built.
 * - **Restart is safe.** On boot with a `dataDir` it reloads history and
 *   `resume()`s: pending timers re-arm, unfinished activities re-dispatch,
 *   blocked children reconnect (proved in `spec/integration/resume.spec.ts`).
 *
 * Lifecycle events go to **stderr as JSON Lines** — one object per event,
 * `{ts, event, ...fields}` (see `server/json_logger.ts`). stdout carries only the
 * readiness line.
 */

import type {AddressInfo} from 'node:net';
import {
  DEFAULT_PORT,
  SERVER_FLAG,
  flagValue,
  numericFlagValue,
} from './process_flags';
import type {ServerEndpoint} from './protocol';
import {FileHistoryStore, createJsonLogger} from './server';
import {createRpcServer, createServerHost, resolveEndpoint} from './services';

/**
 * What a server process is configured with. Every field has a launch-site
 * override; the value here is the default the artifact ships with.
 */
export interface StartServerOptions {
  /** Interface to bind. `--host` overrides. Default `127.0.0.1`. */
  host?: string;
  /** Listen port. `--port` overrides. Default `DEFAULT_PORT`; `0` picks any free one. */
  port?: number;
  /**
   * Where history is persisted, and what makes this server durable.
   *
   * `--data-dir` overrides. **Unset means in-memory**: fast, correct, and losing
   * every execution on the next restart while looking entirely healthy until
   * then. That is the right default for a spec and wrong for anything else, so a
   * deployment sets it — here, or on the command line.
   */
  dataDir?: string;
  /**
   * Activity-task lease timeout. `--activity-lease-ms` overrides.
   *
   * Must exceed the largest `startToCloseTimeoutMs` any activity sets, or the
   * lease redelivers the task before its own deadline is reached and the timeout
   * never gets to decide.
   */
  activityLeaseMs?: number;
}

/** A running server, and the two things a caller needs from one. */
export interface Server {
  /** The port actually bound — the value to read after `port: 0`. */
  readonly port: number;
  /** The interface actually bound. */
  readonly host: string;
  /**
   * Whether history survives a restart — `false` when no `dataDir` was resolved.
   *
   * The same field `health()` reports, available before anything has connected,
   * so a caller that composes a server in-process can assert on it rather than
   * discovering it after the first crash.
   */
  readonly durable: boolean;
  /** Stop listening, release the lockfile, and stop the host's timers. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start a server process.
 *
 * Resolves once the port is bound, so a caller that starts workers next is not
 * racing the listen. Rejects if the port cannot be bound or the data directory
 * is already locked by a live server — both are conditions a supervisor should
 * see as a failed start rather than as a process that came up serving nothing.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<Server> {
  // Read once, from this process's own arguments past the interpreter and script
  // — the same source and the same slice `startWorker` reads.
  const argv = process.argv.slice(2);

  const bindHost =
    flagValue(argv, SERVER_FLAG.host) ?? options.host ?? '127.0.0.1';
  const port =
    numericFlagValue(argv, SERVER_FLAG.port) ?? options.port ?? DEFAULT_PORT;
  const dataDir = flagValue(argv, SERVER_FLAG.dataDir) ?? options.dataDir;
  const activityLeaseMs =
    numericFlagValue(argv, SERVER_FLAG.activityLeaseMs) ??
    options.activityLeaseMs;

  // Durable when a data dir was resolved (a single-writer lockfile guards it);
  // otherwise in-memory. `undefined` lets createServerHost default the store.
  const store = dataDir ? await FileHistoryStore.open(dataDir) : undefined;
  // Filled in below, once there is something to fill it in with. The host is
  // built first because `resume()` has to run before the port opens, so at this
  // point the only truthful answer to "where are you bound" is that nothing is
  // — and under `--port=0` the requested port is not the answer anyway. See
  // `ServerHostOptions.endpoint`.
  let endpoint: ServerEndpoint | undefined;
  const host = createServerHost(store, {
    activityLeaseMs,
    log: createJsonLogger(),
    endpoint: () => endpoint,
  });
  // Re-arm timers, re-dispatch pending work, re-drive running executions. Before
  // the port opens, so nothing observes a server that is listening and has not
  // yet remembered what it was doing.
  if (store) await host.resume();

  const rpc = createRpcServer(host);
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    rpc.once('error', reject);
    rpc.listen(port, bindHost, () => resolve(rpc.address() as AddressInfo));
  });
  endpoint = resolveEndpoint(address);

  // A convenience for humans and for `--port=0`, not the readiness contract —
  // see the fileoverview. The host is appended rather than substituted: existing
  // readers match `LISTENING (\d+)`, and that keeps matching.
  console.log(`LISTENING ${address.port} ${address.address}`);

  let stopping: Promise<void> | undefined;
  const server: Server = {
    port: address.port,
    host: address.address,
    durable: store !== undefined,
    stop(): Promise<void> {
      stopping ??= new Promise<void>((resolve) => {
        host.shutdown();
        // Idle keep-alive sockets would otherwise hold `close` open for as long
        // as a client leaves one around, turning a clean stop into a timeout.
        (rpc as {closeAllConnections?: () => void}).closeAllConnections?.();
        rpc.close(() => resolve());
      }).then(() => {
        // Dropped on the way out, so a process that starts several servers over
        // its lifetime — which a spec does — does not accumulate a handler per
        // server.
        process.off('SIGTERM', shutdown);
        process.off('SIGINT', shutdown);
        return Promise.resolve(store?.close()).then(() => undefined); // release the lockfile
      });
      return stopping;
    },
  };

  function shutdown(): void {
    void server.stop().then(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
