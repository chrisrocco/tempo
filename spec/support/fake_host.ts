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

import type {CommandResult, Host} from '../../src/deploy';

/** One thing that was asked of the machine, in the order it was asked. */
export interface RecordedCall {
  kind: 'euid' | 'makeDirectory' | 'installFile' | 'writeFile' | 'run';
  /** The primary argument: a path, or the command name. */
  target?: string;
  /** `installFile`'s destination; `run`'s arguments joined by a space. */
  detail?: string;
}

/** How the fake should answer. Everything defaults to a healthy root machine. */
export interface FakeHostOptions {
  /** What `euid()` reports. Defaults to 0 — root. */
  euid?: number;
  /**
   * Canned answers for `run`, matched against `"<command> <args joined>"` by
   * substring. First match wins; anything unmatched succeeds with empty output.
   */
  responses?: Array<{match: string; result: Partial<CommandResult>}>;
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
      return options.euid ?? 0;
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
      return {
        code: canned?.result.code ?? 0,
        stdout: canned?.result.stdout ?? '',
        stderr: canned?.result.stderr ?? '',
      };
    },
  };
}
