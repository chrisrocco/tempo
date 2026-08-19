/**
 * @fileoverview
 * Durations as authors write them: `'30 minutes'`, `'1h 30m'`, or plain
 * milliseconds. `durationToMs` is the one place the string form becomes a number.
 *
 * ## Strings never reach the wire
 *
 * Every consumer parses at its own edge — `sleep` before the command is issued,
 * `proxyActivities` at declaration, `ScheduleClient.create` before the definition
 * is stored — so commands, history, and stored state carry only the `…Ms` numbers
 * they always have. Old histories replay untouched, and the server never learns
 * this syntax exists. Parsing is a pure function of the string, which is what
 * makes it legal on the deterministic side of the boundary: the same source line
 * yields the same milliseconds on every replay.
 *
 * ## No months, no years
 *
 * Rejected by name rather than merely unknown, because they are the units people
 * reach for first and the ones a duration cannot honestly carry: "a month" is
 * calendar arithmetic — 28 to 31 days depending on *which* month — and silently
 * picking 30 would be a schedule the author didn't write. The error says where
 * that need is actually served (a calendar `ScheduleSpec`).
 *
 * A bare number in a string (`'500'`) is rejected too: the caller who means
 * milliseconds already has a type for that — the number 500 — and a unitless
 * string is more often a variable that lost its unit than a decision.
 */

/**
 * A span of time as an author writes one: milliseconds, or a string of
 * `<value><unit>` terms — `'30 minutes'`, `'90s'`, `'1h 30m'`, `'1.5 days'`.
 * Units: `ms`, `s`, `m` (minutes), `h`, `d`, `w`, long forms included.
 */
export type Duration = number | string;

/** Milliseconds per unit, keyed by every spelling the grammar accepts. */
const UNIT_MS: Record<string, number> = {};
const UNITS: ReadonlyArray<[number, string[]]> = [
  [1, ['ms', 'msec', 'msecs', 'millisecond', 'milliseconds']],
  [1_000, ['s', 'sec', 'secs', 'second', 'seconds']],
  [60_000, ['m', 'min', 'mins', 'minute', 'minutes']],
  [3_600_000, ['h', 'hr', 'hrs', 'hour', 'hours']],
  [86_400_000, ['d', 'day', 'days']],
  [604_800_000, ['w', 'week', 'weeks']],
];
for (const [ms, names] of UNITS) for (const name of names) UNIT_MS[name] = ms;

/**
 * The units that look like they should work and must fail *helpfully*. A generic
 * "unknown unit" for `'1 month'` reads as a spelling problem; the real problem is
 * that the request is not a duration.
 */
const CALENDAR_UNITS = new Set([
  'mo',
  'month',
  'months',
  'y',
  'yr',
  'yrs',
  'year',
  'years',
]);

const TERM = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * A `Duration` as milliseconds. Numbers pass through untouched — they already
 * are milliseconds — and strings are parsed per the grammar above, terms summed,
 * and the total rounded to a whole millisecond.
 *
 * Throws on anything else, with the offending input in the message. Every caller
 * parses at declaration or call time, so a typo fails loudly the first time the
 * line runs — never mid-replay, because the parse is deterministic.
 */
export function durationToMs(duration: Duration): number {
  if (typeof duration === 'number') return duration;

  let totalMs = 0;
  let matchedLength = 0;
  TERM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM.exec(duration)) !== null) {
    const unit = m[2]!.toLowerCase();
    if (CALENDAR_UNITS.has(unit))
      throw new Error(
        `"${duration}" is not a duration: months and years are calendar arithmetic, not fixed spans — use a calendar ScheduleSpec for wall-clock rules`,
      );
    const unitMs = UNIT_MS[unit];
    if (unitMs === undefined)
      throw new Error(
        `unknown unit "${m[2]}" in duration "${duration}" — use ms, s, m, h, d or w (or their long forms)`,
      );
    totalMs += Number(m[1]) * unitMs;
    matchedLength += m[0].length;
  }

  // Whole-string coverage: everything outside the matched terms must be
  // whitespace, or part of the input was silently ignored — `'5'` (no unit),
  // `'-5m'` (a sign the grammar deliberately has no rule for), `'5m and 3s'`.
  if (matchedLength === 0 || duration.replace(TERM, '').trim() !== '')
    throw new Error(
      `cannot parse duration "${duration}" — expected terms like '30 minutes', '90s', '1h 30m' (a bare number means nothing without a unit; pass a number for milliseconds)`,
    );

  return Math.round(totalMs);
}
