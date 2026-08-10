/**
 * @fileoverview
 * `startServer` as a caller meets it: what it binds, what it persists, what it
 * refuses, and what a launch site can override.
 *
 * An internals spec (per AGENTS.md's two-kinds split) — the entrypoint is host
 * wiring, not the programming model. What is pinned here is the half of a
 * deployment this repo still owns now that it deploys nothing: **the two
 * artifacts a consumer builds are both library calls**, so both have to behave
 * the same way about their configuration. The worker's half of that claim is
 * `worker_entrypoint.spec.ts`, and these two files should read as a pair.
 *
 * The cases are chosen by what silently produces a server that is up and useless:
 * a launch site whose flag was ignored, a data directory that was not opened, and
 * a lock that outlived the process that held it.
 */

import 'jasmine';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {createRemoteClient} from '../../src/client';
import {DEFAULT_PORT} from '../../src/process_flags';
import {startServer, type Server} from '../../src/server_main';
import {createRemoteService} from '../../src/services';

/**
 * `startServer` reads `process.argv` directly, because a deployed binary has no
 * caller to pass it — the same reason and the same mechanism as `startWorker`.
 * Specs that exercise that reading put it back afterwards.
 */
const originalArgv = process.argv;

/** Run as if launched with these flags appended to the command line. */
function launchedWith(...flags: string[]): void {
  process.argv = [...originalArgv, ...flags];
}

/** Servers started by the case, stopped in reverse — a leaked one holds a port. */
let running: Server[] = [];

async function start(...args: Parameters<typeof startServer>): Promise<Server> {
  const server = await startServer(...args);
  running.push(server);
  return server;
}

let dirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-server-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.argv = originalArgv;
  for (const server of running.reverse()) await server.stop();
  running = [];
  for (const dir of dirs) await fs.rm(dir, {recursive: true, force: true});
  dirs = [];
});

describe('server entrypoint — the options object is the configuration', () => {
  it('reports the port it actually bound, which is the answer for port 0', async () => {
    const server = await start({port: 0});

    // Not the requested value: `0` means "pick one", and a caller that could not
    // read back which one would have started a server nothing can find. This is
    // what makes the stdout readiness line a convenience rather than a contract
    // for anything running in-process.
    expect(server.port).toBeGreaterThan(0);
    expect(server.host).toBe('127.0.0.1');
  });

  it('is reachable the moment it resolves', async () => {
    const server = await start({port: 0});

    // The promise resolves after `listen` calls back, so a caller that starts
    // workers next is not racing the bind. If this ever regressed, the failure
    // downstream would be a worker's first poll landing on a closed port — which
    // it survives by backing off, so it would show up as a slow start rather than
    // as an error, and nothing would point here.
    const client = createRemoteClient(
      createRemoteService(`http://127.0.0.1:${server.port}`),
    );
    await expectAsync(client.health()).toBeResolved();
  });

  it('binds loopback unless told otherwise', async () => {
    const server = await start({port: 0, host: '127.0.0.1'});

    // The default is the only one that is safe without further thought: the RPC
    // has no auth and no TLS.
    expect(server.host).toBe('127.0.0.1');
  });

  it('is not durable when no data dir is resolved, and says so', async () => {
    const server = await start({port: 0});

    // The field exists because this is the failure that looks like health: an
    // in-memory server serves correctly and loses every execution on its next
    // restart. Reading it here — before anything has connected — is the cheapest
    // place a deployment can catch a missing `dataDir`.
    expect(server.durable).toBeFalse();

    const client = createRemoteClient(
      createRemoteService(`http://127.0.0.1:${server.port}`),
    );
    expect((await client.health()).durable).toBeFalse();
  });

  it('is durable when given a data dir, and reports where state lives', async () => {
    const dir = await dataDir();
    const server = await start({port: 0, dataDir: dir});

    expect(server.durable).toBeTrue();

    const health = await createRemoteClient(
      createRemoteService(`http://127.0.0.1:${server.port}`),
    ).health();
    expect(health.durable).toBeTrue();
    expect(health.dataLocation).toBe(dir);
  });
});

describe('server entrypoint — the launch site overrides the code', () => {
  it('takes the port from --port over the options object', async () => {
    launchedWith('--port=0');

    // The precedence that keeps one artifact redeployable: the code's value is
    // the default it ships with, and the launch site is the deployment. Written
    // with a conflicting option so that "the flag was read" and "the option was
    // read" cannot both be true — asserting on a flag alone would pass against a
    // function that ignored options entirely.
    const server = await start({port: DEFAULT_PORT});

    expect(server.port).not.toBe(DEFAULT_PORT);
  });

  it('takes the data dir from --data-dir over the options object', async () => {
    const shipped = await dataDir();
    const deployed = await dataDir();
    launchedWith('--data-dir=' + deployed);

    const server = await start({port: 0, dataDir: shipped});

    const health = await createRemoteClient(
      createRemoteService(`http://127.0.0.1:${server.port}`),
    ).health();
    expect(health.dataLocation).toBe(deployed);
  });

  it('refuses a flag given without a value rather than reading it as absent', async () => {
    launchedWith('--data-dir');

    // `--data-dir` alone is someone who meant to say where history goes. Reading
    // it as unset would start an in-memory server that looks healthy and loses
    // everything on restart — see `process_flags.ts`.
    await expectAsync(startServer({port: 0})).toBeRejectedWithError(
      /--data-dir needs a value/,
    );
  });
});

describe('server entrypoint — one server per data dir', () => {
  it('refuses to start on a data dir a live server already holds', async () => {
    const dir = await dataDir();
    await start({port: 0, dataDir: dir});

    // The single-writer lockfile is what makes the file store's append-only log
    // safe. Two servers on one dir is not a slow deployment, it is two writers
    // interleaving history, so this fails the start rather than degrading.
    await expectAsync(
      startServer({port: 0, dataDir: dir}),
    ).toBeRejectedWithError(/locked by a live process/);
  });

  it('releases the lock on stop, so a restart onto the same dir works', async () => {
    const dir = await dataDir();
    const first = await start({port: 0, dataDir: dir});
    await first.stop();

    // The restart case a supervisor produces on every redeploy. If `stop` left
    // the lockfile behind, the unit would come back up and stay down, and the
    // reason would be a file rather than anything in the logs.
    const second = await start({port: 0, dataDir: dir});
    expect(second.durable).toBeTrue();
  });

  it('stops idempotently', async () => {
    const server = await start({port: 0});

    // A supervisor sending SIGTERM to a process already shutting down is the
    // ordinary case, and the second call must not throw on a closed server.
    await server.stop();
    await expectAsync(server.stop()).toBeResolved();
  });
});
