/**
 * @fileoverview
 * The seam between `tempo up` and a build system.
 *
 * Two things are pinned here. **What the source toolchain resolves**, which is
 * the behaviour the CLI has always had, now stated somewhere rather than
 * implied by a switch inside a spawn call. And **that `up` goes through the
 * interface**, proven by handing it a toolchain made of `node -e` scripts —
 * targets that are not files, in a language no build system compiles, which
 * only work if `up` never looked at the path it was given.
 *
 * That second one is the point of the refactor. Until now `up` could only be
 * exercised by spawning the real topology (`spec/integration/cli.spec.ts`), so
 * every test of its supervision logic cost two processes and a port. A fake
 * toolchain makes the supervisor testable on its own, which is worth as much as
 * the Bazel adapter this was extracted for.
 */

import 'jasmine';
import {createSourceToolchain} from '../../src/cli/source_toolchain';
import type {Launchable, Toolchain} from '../../src/cli/ports/toolchain';
import {up} from '../../src/cli/up';
import {repoPath} from '../support/repo_root';

describe('the source toolchain', () => {
  it('runs a TypeScript entry under a loader resolved to an absolute path', async () => {
    const launchable = await createSourceToolchain().launch('worker.ts');

    expect(launchable.command).toBe(process.execPath);
    expect(launchable.args[0]).toBe('--import');
    // Absolute, so the child resolves it from us rather than from its own cwd.
    expect(launchable.args[1]).toMatch(/^\/.*tsx/);
    expect(launchable.args[2]).toBe('worker.ts');
  });

  it('runs a JavaScript entry under plain node', async () => {
    const launchable = await createSourceToolchain().launch('worker.js');

    expect(launchable.command).toBe(process.execPath);
    expect(launchable.args).toEqual(['worker.js']);
  });

  /**
   * The built-binary case, and the reason this toolchain needs no special
   * handling for one: anything that is not a script is already a command.
   */
  it('runs anything else as a self-contained executable', async () => {
    const launchable = await createSourceToolchain().launch('/opt/bin/worker');

    expect(launchable.command).toBe('/opt/bin/worker');
    expect(launchable.args).toEqual([]);
  });

  it('answers with the engine server nobody else can name', async () => {
    const launchable = await createSourceToolchain().server();

    expect(launchable.args).toContain(repoPath('bin/server-main.ts'));
  });
});

/**
 * A toolchain of inline `node -e` scripts: targets that are not paths, in a
 * shape no build system produces. `up` can only drive these if it spawns
 * exactly what it was handed and never looks at the target itself.
 *
 * The trailing `--` is what makes appended arguments reach the script rather
 * than node's own option parser — `node -e … --describe` is a bad-option error.
 * A Bazel launchable ends the same way (`bazel run <target> --`), which is why
 * the interface hands back leading arguments rather than a joined command line.
 */
function fakeToolchain(options: {
  worker: string;
  server: string;
}): Toolchain & {asked: string[]} {
  const asked: string[] = [];
  const script = (source: string): Launchable => ({
    command: process.execPath,
    args: ['-e', source, '--'],
  });
  return {
    asked,
    launch(target: string): Promise<Launchable> {
      asked.push(target);
      return Promise.resolve(script(options.worker));
    },
    server(): Promise<Launchable> {
      asked.push('<server>');
      return Promise.resolve(script(options.server));
    },
  };
}

/** A worker that describes itself and then idles, which is the healthy shape. */
const HEALTHY_WORKER = `
  if (process.argv.includes('--describe')) {
    console.log(JSON.stringify({name: 'fake', workflows: ['w'], activities: ['a']}));
  } else {
    console.log('WORKER_READY fake workflow,activity default');
    setInterval(() => {}, 1000);
  }
`;

/**
 * These drive `up` into an early failure on purpose. Supervising a healthy
 * topology to completion is `spec/integration/cli.spec.ts`, with the real
 * toolchain and real processes; what is left to prove here is narrower — that
 * both halves come from the interface — and a failure that arrives in
 * milliseconds proves it without a signal, a sleep, or a port.
 */
describe('tempo up — through whatever toolchain it is given', () => {
  /**
   * A Bazel label is not a path, and `up` must never treat it as one. The target
   * reaches the toolchain verbatim, and what gets spawned is what came back —
   * visible here because the failure quotes the command it ran.
   */
  it('hands the target to the toolchain and spawns what it gets back', async () => {
    const toolchain = fakeToolchain({
      worker: `console.error('DESCRIBE_REFUSED'); process.exit(3);`,
      server: `console.log('LISTENING 1 127.0.0.1');`,
    });

    await expectAsync(
      up({entry: '@tempo//examples:greeter', toolchain}),
    ).toBeRejectedWithError(/DESCRIBE_REFUSED/);

    // Both targets are resolved before anything is spawned — under a build
    // system resolving *is* building, and a compile error should not arrive
    // with a server already listening.
    expect(toolchain.asked).toEqual(['@tempo//examples:greeter', '<server>']);
  }, 20000);

  /**
   * The server is the target the *user* cannot name, so it has to come from the
   * toolchain too — a build system publishes its own label for it. Proven by a
   * server that dies before it is ready: `up` fails on the readiness line it was
   * waiting for, which it could only be waiting on if it launched this one.
   */
  it('takes the engine server from the toolchain as well', async () => {
    const toolchain = fakeToolchain({
      worker: HEALTHY_WORKER,
      server: `console.error('SERVER_REFUSED'); process.exit(4);`,
    });

    await expectAsync(
      up({entry: '//my:worker', toolchain}),
    ).toBeRejectedWithError(/SERVER_REFUSED/);

    expect(toolchain.asked).toEqual(['//my:worker', '<server>']);
  }, 20000);
});
