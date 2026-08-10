/**
 * @fileoverview
 * A `Host` that records what was asked of it instead of doing it.
 *
 * This is the whole reason `Host` exists. `up`, `down`, and `status` are about
 * writing `/opt`, installing systemd units, and running `systemctl`, and none of
 * that can happen in a spec — or on a machine that is not Linux, or without root.
 * What is worth testing about them is *what they decide*: the exact text of a
 * unit, the order of copy/reload/enable/restart, whether root is checked before
 * the first write. All of that is visible here.
 *
 * `calls` is one flat, ordered list rather than a list per method, because the
 * ordering **between** kinds of call is most of what matters: a `daemon-reload`
 * after the restart is a deploy that silently served the old command line, and
 * only a single sequence can catch it.
 */

import type {CommandResult, Host, UserPaths} from '../../src/deploy';

/**
 * A fixed home, so unit text is assertable without depending on whose machine the
 * suite runs on — and deliberately not `/home/…`, so a path that leaked from the
 * real environment would be obvious in a failure message.
 */
export const FAKE_USER_PATHS: UserPaths = {
  data: '/fake/home/.local/share',
  config: '/fake/home/.config',
  state: '/fake/home/.local/state',
};

/**
 * The interpreter the fake reports.
 *
 * Deliberately a version-manager path rather than `/usr/bin/node`: that is the
 * case the hardcoded constant used to get wrong, and a unit that reintroduced the
 * constant would pass a spec written against `/usr/bin/node` while failing on every
 * machine that installs node this way.
 */
export const FAKE_NODE = '/fake/home/.nvm/versions/node/v22.15.0/bin/node';

/** One thing that was asked of the machine, in the order it was asked. */
export interface RecordedCall {
  kind: 'euid' | 'makeDirectory' | 'installFile' | 'writeFile' | 'run';
  /** The primary argument: a path, or the command name. */
  target?: string;
  /** `installFile`'s destination; `run`'s arguments joined by a space. */
  detail?: string;
}

/**
 * How the fake should answer. Everything defaults to an ordinary user's machine.
 */
export interface FakeHostOptions {
  /**
   * What `euid()` reports. Defaults to `1000` — an ordinary user, which is what
   * every one of these operations now wants. Pass `0` to exercise the refusals.
   */
  euid?: number;
  /**
   * Where this user's files go. Defaults to a fixed fake home, so unit text is
   * assertable without depending on whose machine the suite runs on.
   */
  userPaths?: UserPaths;
  /**
   * What `interpreterPath()` reports. Defaults to a fake path under a version
   * manager, so a unit that hardcoded `/usr/bin/node` would be obvious.
   */
  interpreterPath?: string;
  /**
   * Canned answers for `run`, matched against `"<command> <args joined>"` by
   * substring. First match wins; anything unmatched succeeds with empty output.
   *
   * `result.throws` makes the call **reject** rather than resolve, which is what
   * the real host does for a command that is not installed — a non-zero exit is an
   * answer and a missing binary is not. That is the difference between "this unit
   * is inactive" and "there is no systemd on this machine", and only a caller that
   * catches can tell them apart.
   */
  responses?: Array<{
    match: string;
    result: Partial<CommandResult> & {throws?: string};
  }>;
  /** Paths whose `installFile` should fail, as a missing artifact would. */
  failInstall?: readonly string[];
}

/** A recording `Host`, plus the recording. */
export interface FakeHost extends Host {
  readonly calls: readonly RecordedCall[];
  /** Contents written, by destination path — the unit files. */
  readonly written: ReadonlyMap<string, string>;
  /** Every `run` as it would have been typed, in order. */
  commands(): string[];
  /** The recorded calls of one kind, in order. */
  callsOf(kind: RecordedCall['kind']): RecordedCall[];
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const calls: RecordedCall[] = [];
  const written = new Map<string, string>();

  function record(call: RecordedCall): void {
    calls.push(call);
  }

  return {
    calls,
    written,

    commands(): string[] {
      return calls
        .filter((c) => c.kind === 'run')
        .map((c) => `${c.target} ${c.detail ?? ''}`.trim());
    },

    callsOf(kind: RecordedCall['kind']): RecordedCall[] {
      return calls.filter((c) => c.kind === kind);
    },

    euid(): number {
      record({kind: 'euid'});
      return options.euid ?? 1000;
    },

    userPaths(): UserPaths {
      return options.userPaths ?? FAKE_USER_PATHS;
    },

    interpreterPath(): string {
      return options.interpreterPath ?? FAKE_NODE;
    },

    async makeDirectory(path: string): Promise<void> {
      record({kind: 'makeDirectory', target: path});
    },

    async installFile(source: string, destination: string): Promise<void> {
      record({kind: 'installFile', target: source, detail: destination});
      if (options.failInstall?.includes(source))
        throw new Error(`ENOENT: no such file or directory, open '${source}'`);
    },

    async writeFile(destination: string, contents: string): Promise<void> {
      record({kind: 'writeFile', target: destination});
      written.set(destination, contents);
    },

    async run(
      command: string,
      args: readonly string[],
    ): Promise<CommandResult> {
      const line = `${command} ${args.join(' ')}`;
      record({kind: 'run', target: command, detail: args.join(' ')});

      const canned = options.responses?.find((r) => line.includes(r.match));
      if (canned?.result.throws) throw new Error(canned.result.throws);
      return {
        code: canned?.result.code ?? 0,
        stdout: canned?.result.stdout ?? '',
        stderr: canned?.result.stderr ?? '',
      };
    },
  };
}
