/**
 * @fileoverview
 * The dashboard as a running process, against a real engine.
 *
 * The unit specs cover the file server with a temp directory of made-up files.
 * That is the right shape for path containment and extension rules, and it
 * cannot catch the class of bug this exists for: the *real* shell asking for a
 * path the *real* server does not serve.
 *
 * That is not hypothetical. The shell pointed at `/ui/app.ts` — correct while
 * the engine served the dashboard under `/ui`, wrong the moment it started
 * serving itself at `/`. Every unit test passed. The browser fetched the shell,
 * 404'd on the module, reported nothing, and left a custom element that
 * silently never upgraded.
 *
 * So the assertion that matters here is the boring one: **take the script the
 * shell actually names, and fetch it.**
 *
 * The engine runs in-process; only the dashboard is spawned, because the thing
 * under test is the dashboard's own wiring and its ability to reach an engine
 * it was merely told the URL of.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {createRpcServer, createServerHost} from '../../src/services';
import type {ServerHost} from '../../src/services';

const DASHBOARD_MAIN = path.resolve('dashboard/server/main.ts');

function waitForLine(
  proc: ChildProcess,
  re: RegExp,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${re}\n${out}`)),
      20_000,
    );
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const match = out.match(re);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
  });
}

describe('the dashboard process', () => {
  let host: ServerHost;
  let engine: ReturnType<typeof createRpcServer>;
  let dashboard: ChildProcess;
  let base: string;

  beforeAll(async () => {
    host = createServerHost();
    engine = createRpcServer(host);
    await new Promise<void>((resolve) =>
      engine.listen(0, '127.0.0.1', () => resolve()),
    );
    const enginePort = (engine.address() as AddressInfo).port;
    await host.start('demo', [], {workflowId: 'demo-1'});

    dashboard = spawn(process.execPath, ['--import', 'tsx', DASHBOARD_MAIN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      },
    });
    const [, port] = await waitForLine(dashboard, /LISTENING (\d+)/);
    base = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    dashboard.kill('SIGKILL');
    host.shutdown();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
  });

  it('serves a shell', async () => {
    const html = await (await fetch(base)).text();

    expect(html).toContain('<tempo-app>');
  });

  /**
   * The one that would have caught it. Everything else can pass while the shell
   * names a module the server has never heard of — which is exactly what
   * happened when the app moved and `index.html` did not.
   */
  it('serves the entry module the shell actually asks for', async () => {
    const html = await (await fetch(base)).text();
    const src = /<script type="module" src="([^"]+)"><\/script>/.exec(
      html,
    )?.[1];

    expect(src).toBeDefined();
    const response = await fetch(`${base}${src}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  /**
   * The bundle has to contain the engine's own code, not a reference to it.
   * `isStuck` is a value rather than a type, so a build that resolved the
   * engine only for type-checking would produce a bundle that throws on load —
   * and the page would look identical until an element tried to render.
   */
  it('inlines the engine protocol into the bundle', async () => {
    const html = await (await fetch(base)).text();
    const src = /<script type="module" src="([^"]+)"><\/script>/.exec(
      html,
    )?.[1];
    const bundle = await (await fetch(`${base}${src}`)).text();

    expect(bundle).toContain('isStuck');
    // Nothing left for the browser to resolve: a bare specifier here would mean
    // an unbundled import, which fails at load with no import map to catch it.
    expect(bundle).not.toMatch(/from\s*["']lit["']/);
    expect(bundle).not.toMatch(/from\s*["']workflow-engine/);
  });

  it('forwards an RPC call to the engine', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({method: 'listExecutions', filter: {}}),
    });
    const envelope = (await response.json()) as {
      ok: boolean;
      value: {executions: {workflowId: string}[]};
    };

    expect(envelope.ok).toBeTrue();
    expect(envelope.value.executions.map((e) => e.workflowId)).toContain(
      'demo-1',
    );
  });

  /**
   * An engine that is down must read as an engine that is down. The dashboard's
   * client only knows how to display the RPC's own failure envelope, so a
   * transport error is translated into one rather than surfacing as an HTTP
   * status the page would report as "server returned 502".
   */
  it('reports an unreachable engine in the envelope the client understands', async () => {
    const orphan = spawn(
      process.execPath,
      ['--import', 'tsx', DASHBOARD_MAIN],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Port 1 is reserved and nothing listens there.
        env: {...process.env, PORT: '0', ENGINE_URL: 'http://127.0.0.1:1'},
      },
    );
    try {
      const [, port] = await waitForLine(orphan, /LISTENING (\d+)/);
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({method: 'listExecutions'}),
      });
      const envelope = (await response.json()) as {ok: boolean; error: string};

      expect(response.status).toBe(200);
      expect(envelope.ok).toBeFalse();
      expect(envelope.error).toContain('cannot reach the engine');
    } finally {
      orphan.kill('SIGKILL');
    }
  }, 30_000);
});
