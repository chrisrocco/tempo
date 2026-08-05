/**
 * @fileoverview
 * How the text in the start form's arguments box becomes an argument list.
 *
 * Separate from `start_form.ts` — which owns the fields and the request — for
 * the reason `routes.ts` is separate from `router.ts`: this half touches no DOM,
 * so it runs in the suite (`spec/dashboard/start_args.spec.ts`), and every case
 * worth pinning down is a text case.
 *
 * ## A JSON array, not a JSON value
 *
 * `[1, 2, 3]` is genuinely ambiguous: three arguments, or one array argument?
 * Both are things a workflow takes, and guessing wrong is invisible until the
 * workflow reads its first parameter and finds a number where it expected a
 * list — by which point an execution exists and has already gone wrong.
 *
 * Requiring the brackets resolves it. The outer array is *always* the argument
 * list, so one array argument is `[[1, 2, 3]]` and says so. The cost is that the
 * common single-argument case needs brackets it might not have expected, which
 * is what the error message is for: it names the fix rather than reporting that
 * the input was not an array.
 */

/** Either the parsed argument list, or why the text is not one. */
export type ParsedArgs = {args: unknown[]} | {error: string};

/**
 * Parse the arguments box.
 *
 * Empty means no arguments rather than an error: plenty of workflows take none,
 * and making that case type `[]` would be pedantry. Everything else must be a
 * JSON array — see the fileoverview for why the brackets are not optional.
 */
export function parseArgs(text: string): ParsedArgs {
  const trimmed = text.trim();
  if (trimmed === '') return {args: []};

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    // The parser's own message carries the offset, which is the only part of
    // this a reader can act on.
    return {error: `not valid JSON — ${e instanceof Error ? e.message : e}`};
  }

  if (!Array.isArray(value))
    return {
      error: 'arguments must be a JSON array — wrap a single value in []',
    };

  return {args: value};
}
