/**
 * @fileoverview
 * How a *target* becomes a process — the CLI's one piece of build-system
 * knowledge, behind an interface so a build system can bring its own.
 *
 * Everything else in `cli/` is build-system agnostic already: `up.ts`
 * supervises children and reads their readiness lines, `client.ts` talks to a
 * server over the RPC, `describe.ts` asks an artifact what it is. Only the
 * question "what do I actually exec, and with which arguments?" has an answer
 * that differs per toolchain, and until now that answer was an extension switch
 * hardcoded in `process.ts`.
 *
 * ## The interface is `launch`, not `build`
 *
 * The obvious shape — `build(target)` then run the output — is the wrong one,
 * and Bazel is what shows why: `bazel run //my:worker -- --describe` builds and
 * runs in a single command, resolving runfiles on the way. An interface with a
 * build step would force that adapter to split what Bazel deliberately joins,
 * then guess at `bazel-bin/` paths to rejoin it.
 *
 * So the contract is *resolution*: hand me a target, give me back something I
 * can spawn. Whether that involved a compiler is the implementation's business.
 * A `source` toolchain compiles nothing; a Bazel one compiles the world; the
 * caller cannot tell and does not need to.
 *
 * ## What is deliberately not here
 *
 * **Installing.** `tempo deploy` — producing an artifact and putting it
 * somewhere durable with a supervisor pointed at it — is a second seam with a
 * genuinely different shape: systemd units, tarballs, containers, rollback. Any
 * interface spanning that and this would be too abstract to say anything. It is
 * not modelled here because it is not modelled anywhere yet.
 *
 * **A registry of toolchains.** There is one implementation in this repo
 * (`source_toolchain.ts`) and a fake in the specs. A named-adapter lookup, or a
 * `--toolchain=` flag, is worth adding the day a second real one lands and not
 * before — `up()` takes a `Toolchain`, so providing one is already possible
 * without any of that machinery.
 */

/**
 * A resolved command: what to exec, and the arguments that come before whatever
 * the caller wants to append.
 *
 * Split rather than a single string because these get spawned without a shell —
 * a path with a space in it is a bug waiting in any design that joins them.
 */
export interface Launchable {
  command: string;
  /** Leading arguments — a module loader, a `bazel run` target, or nothing. */
  args: readonly string[];
}

/** Resolves targets to processes. One implementation per build system. */
export interface Toolchain {
  /**
   * Resolve a user-authored target: a path, a Bazel label, whatever this
   * toolchain's targets look like. May build as a side effect, so it returns a
   * promise even where nothing is built.
   */
  launch(target: string): Promise<Launchable>;

  /**
   * Resolve the engine's own server, which the user did not write and cannot
   * name. `source` answers with the file in `bin/`; a Bazel toolchain would
   * answer with the label the engine publishes.
   */
  server(): Promise<Launchable>;
}
