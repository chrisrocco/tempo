/**
 * @fileoverview
 * Turning `process.argv` into positionals and flags, and nothing else.
 *
 * Separate from `cli.ts` because the parsing has rules worth stating and
 * testing on their own — what `--` does, what a bare `--key` means — while
 * `cli.ts` is a table of which word runs which command. Splitting them is also
 * what lets a spec pin the rules without going through a command.
 *
 * ## `--` ends flag parsing
 *
 * Every token after `--` is a positional, whatever it looks like. That is what
 * makes a workflow argument beginning with `-` expressible at all:
 *
 *     tempo start myWorkflow --wait -- --this-is-an-argument
 *
 * `--wait` is the CLI's; `--this-is-an-argument` is the workflow's. Tokens from
 * both sides land in `positionals` in the order they were written, because a
 * command reading `[name, ...args]` should not have to care which side of the
 * separator each argument came from.
 *
 * The deleted CLI had no concept of `--` and treated `--x` anywhere as its own
 * flag, so a workflow argument that looked like a flag was silently eaten. This
 * is new behaviour rather than recovered behaviour.
 *
 * ## A bare `--key` reads as an empty string
 *
 * `--wait` and `--wait=` are the same thing here, and callers ask `has()` rather
 * than reading the value. A flag that *needs* a value says so itself — see
 * `requireFlag` — so that `--server` with a missing value fails where it can name
 * what was missing, rather than resolving to `''` and dialling nowhere.
 */

/** A parsed command line: words in order, flags by name. */
export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/**
 * Parse `--key=value`, bare `--key`, and positionals, stopping flag parsing at
 * `--`.
 *
 * A single-dash token (`-x`) is a positional: this CLI has no short flags, and
 * treating one as a flag would swallow a negative number a workflow wanted.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  const separator = argv.indexOf('--');
  const flagged = separator === -1 ? argv : argv.slice(0, separator);
  const verbatim = separator === -1 ? [] : argv.slice(separator + 1);

  for (const arg of flagged) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.set(body, '');
    else flags.set(body.slice(0, eq), body.slice(eq + 1));
  }

  return {positionals: [...positionals, ...verbatim], flags};
}

/**
 * A flag's value, or `undefined` when it was not given.
 *
 * Bare `--key` collapses to `undefined` rather than `''`: every flag that takes
 * a value here is a thing to dial, a path, or a name, and none of them has a
 * meaningful empty value. This is what lets a caller write `?? DEFAULT` and get
 * the default for both "absent" and "given with nothing".
 */
export function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === undefined || value === '' ? undefined : value;
}

/** Was this flag given at all? For flags that carry no value, like `--wait`. */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/**
 * A flag that must carry a value, failing by name when it does not.
 *
 * `--server` given bare is a mistake worth an error rather than a silent
 * fallback to the default: someone who typed the flag meant to redirect the
 * command somewhere, and quietly using the default sends it to the last place
 * they would look.
 */
export function requireFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (value === undefined)
    throw new Error(
      args.flags.has(name)
        ? `--${name} needs a value, as --${name}=…`
        : `missing --${name}`,
    );
  return value;
}

/** A positional that has to be there, named so the error can say what is missing. */
export function requirePositional(
  positionals: readonly string[],
  index: number,
  what: string,
): string {
  const value = positionals[index];
  if (value === undefined || value === '') throw new Error(`missing ${what}`);
  return value;
}

/**
 * Workflow arguments arrive as strings. Parse each as JSON so numbers, booleans,
 * objects, and arrays survive, falling back to the raw string — which is what
 * makes `tempo start greeter world` pass a string and `tempo start adder 1 2`
 * pass numbers.
 *
 * The fallback is the whole reason this is not plain `JSON.parse`: unquoted words
 * are the common case on a command line, and requiring `'"world"'` would make
 * the simple call the awkward one.
 */
export function parseWorkflowArg(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
