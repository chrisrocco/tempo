/**
 * @fileoverview
 * The listing's time window: the vocabulary of ranges, and what each one means
 * as a bound on `createdAt`.
 *
 * DOM-free and specified (`spec/dashboard/time_range.spec.ts`), because the
 * decision here is not layout. `execution_list.ts` renders a `<select>` over
 * `TIME_RANGES`; everything about what those options *mean* is in this file.
 *
 * ## The URL holds the duration, not the instant it resolved to
 *
 * `ExecutionFilter` is absolute — epoch milliseconds, because it is a wire
 * contract and two ends cannot share "an hour ago". The URL is the opposite:
 * `?since=1h` rather than the timestamp that came out of it. The window is
 * therefore **sliding** — it is re-resolved on every poll, against the clock at
 * that moment.
 *
 * The alternative was to resolve once, on the click, and write the resulting
 * instant into the URL. That was rejected for two reasons, the second of which
 * is the one that matters:
 *
 * - A link saying `since=1h` explains itself; one saying `after=1754400000000`
 *   does not, and the reader has no way to tell an hour-long window from a
 *   week-long one without doing arithmetic.
 * - A frozen window in a view that polls every two seconds is a **live display
 *   that has quietly stopped being live**. Pick "last hour" at 14:00, come back
 *   at 16:00, and the listing is still showing 13:00–14:00 while every other
 *   element on the page updates around it. Nothing on screen would say so.
 *
 * The cost is that a pasted link shows a different set of executions to whoever
 * opens it later. That is the honest reading of what it says: it names a
 * duration, so it means a duration. Someone who needs to point at a specific
 * execution links to the execution.
 *
 * There is no lower bound in the vocabulary — no "between 2pm and 3pm". The
 * protocol carries `createdBefore` and the server honours it, so the capability
 * exists for a caller that wants it; what is missing is a control, and a date
 * picker is a large thing to build for a question ("what broke *then*") that a
 * debugging dashboard is rarely asked.
 */

/** How far back the listing reaches. Absent means all of time. */
export type TimeRange = '15m' | '1h' | '24h' | '7d';

/** Every range, shortest first — the order the control offers them. */
export const TIME_RANGES: readonly TimeRange[] = ['15m', '1h', '24h', '7d'];

/**
 * How long each range is, in milliseconds.
 *
 * A day is 86_400_000 here regardless of what the calendar did — these are
 * durations subtracted from now, not calendar arithmetic, so a DST boundary
 * shifts the window by an hour and that is the correct behaviour for "the last
 * 24 hours".
 */
const RANGE_MS: Readonly<Record<TimeRange, number>> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** Is this a range the dashboard knows? Guards a value read from the URL. */
export function isTimeRange(value: string | null): value is TimeRange {
  return value !== null && (TIME_RANGES as readonly string[]).includes(value);
}

/**
 * The instant a range begins, given the current time.
 *
 * The returned value is `createdAfter`, which is inclusive — an execution
 * created exactly `range` ago is inside the window.
 */
export function rangeStart(range: TimeRange, now: number): number {
  return now - RANGE_MS[range];
}

/**
 * How each range reads in the control.
 *
 * A `Record` keyed by the union rather than a `switch`, so adding a range is a
 * compile error here until it is given words — the same exhaustiveness the
 * style guide's `assertNever` buys, without a runtime branch that cannot fire.
 */
const RANGE_LABELS: Readonly<Record<TimeRange, string>> = {
  '15m': 'last 15 minutes',
  '1h': 'last hour',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
};

/** How a range reads in the control. */
export function rangeLabel(range: TimeRange): string {
  return RANGE_LABELS[range];
}
