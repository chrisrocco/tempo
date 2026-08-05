/**
 * @fileoverview
 * Turning a flat history into the spans and marks a timeline draws.
 *
 * The table in `history_timeline.ts` answers "what happened, in order". This
 * answers a different question — *when, and for how long* — which is the one
 * asked by anyone looking at an execution that took nine minutes and wanting to
 * know which part of it did. A table of five hundred rows makes that a
 * subtraction exercise; overlapping bars make it obvious.
 *
 * DOM-free, so the suite covers it (`spec/dashboard/history_spans.spec.ts`).
 * Every hard case here is a data case, and each one has a plausible wrong answer
 * that looks fine on screen.
 *
 * ## Three things a history event can become
 *
 * - **A span**, when a dispatch and its completion are both on the page. It has
 *   a start, an end, and therefore a length worth drawing.
 * - **A mark**, when an event is a point rather than an interval — a signal, a
 *   cancellation — or when a completion's dispatch is *not* on this page. The
 *   second case is the interesting one: the event happened at a known time, and
 *   how long it took is unknowable, so it is drawn where it landed and given no
 *   width. Inferring a start from the left edge of the page would be a guess
 *   presented as a measurement, which is the same rule `durationOf` follows.
 * - **Nothing**, when the event has no `ts`. History written before that field
 *   existed cannot be placed on a time axis at all. Those are counted rather
 *   than dropped silently, because a timeline missing half an execution should
 *   say so rather than look sparse.
 *
 * ## An open span is not necessarily a running one
 *
 * A dispatch with no completion on the page gets `end: undefined`. That means
 * one of two things — the work is genuinely still outstanding, or its completion
 * is on a page that is not loaded — and this module cannot tell them apart,
 * because it is given one page and no idea where that page sits. It reports the
 * fact and leaves the wording to the view, which knows whether it is showing the
 * end of the history.
 */

import type {HistoryEvent} from 'workflow-engine/protocol';

/** What kind of work a span represents. */
export type SpanKind = 'activity' | 'timer' | 'child';

/** How a span ended, or that it has not. */
export type SpanOutcome = 'ok' | 'failed' | 'open';

/** One interval of work: a dispatch, and the completion that closed it. */
export interface HistorySpan {
  seq: number;
  kind: SpanKind;
  /** What to call it — an activity name, a child id, or just "timer". */
  label: string;
  start: number;
  /** Absent when no completion for this `seq` is on the page. */
  end?: number;
  outcome: SpanOutcome;
  /** Present on child spans whose id was recorded. */
  childId?: string;
}

/** A point in time: something with no duration, or none that is knowable. */
export interface TimelineMark {
  at: number;
  label: string;
  tone: 'ok' | 'danger' | 'accent' | 'muted';
}

/** A history laid out on a time axis. */
export interface CompactTimeline {
  spans: HistorySpan[];
  marks: TimelineMark[];
  /** The axis. Equal when everything landed in the same millisecond. */
  start: number;
  end: number;
  /** Events with no `ts`, which no axis can place. */
  unplaceable: number;
  /** True when nothing on the page could be placed, so there is no axis. */
  empty: boolean;
}

interface OpenDispatch {
  seq: number;
  kind: SpanKind;
  label: string;
  start: number;
  childId?: string;
}

/**
 * Lay a page of history out on a time axis.
 *
 * `now` extends the axis past the last recorded event when something is still
 * open, so a span that started ten minutes ago and has not finished is drawn ten
 * minutes long rather than as a sliver at the right edge.
 */
export function buildTimeline(
  history: HistoryEvent[],
  now: number,
): CompactTimeline {
  const open = new Map<number, OpenDispatch>();
  const spans: HistorySpan[] = [];
  const marks: TimelineMark[] = [];
  let unplaceable = 0;

  for (const event of history) {
    if (event.ts === undefined) {
      unplaceable++;
      continue;
    }
    const at = event.ts;

    switch (event.type) {
      case 'activityScheduled':
        open.set(event.seq, {
          seq: event.seq,
          kind: 'activity',
          label: event.name,
          start: at,
        });
        break;
      case 'timerStarted':
        open.set(event.seq, {
          seq: event.seq,
          kind: 'timer',
          label: 'timer',
          start: at,
        });
        break;
      case 'childStarted':
        open.set(event.seq, {
          seq: event.seq,
          kind: 'child',
          label: event.childId,
          start: at,
          childId: event.childId,
        });
        break;

      case 'activityCompleted':
        close(event.seq, at, 'ok');
        break;
      case 'activityFailed':
        close(event.seq, at, 'failed', event.error);
        break;
      case 'timerFired':
        close(event.seq, at, 'ok');
        break;
      case 'childCompleted':
        close(event.seq, at, 'ok', undefined, event.childId);
        break;
      case 'childFailed':
        close(event.seq, at, 'failed', event.error, event.childId);
        break;

      case 'signal':
        marks.push({at, label: `signal ${event.name}`, tone: 'accent'});
        break;
      case 'cancelRequested':
        marks.push({at, label: 'cancellation requested', tone: 'danger'});
        break;
      default:
        return assertNever(event);
    }
  }

  // Whatever never closed is still a span — it just has no end. Sorted with the
  // rest by start, so the timeline reads top-to-bottom in dispatch order.
  for (const dispatch of open.values())
    spans.push({...dispatch, outcome: 'open'});
  spans.sort((a, b) => a.start - b.start || a.seq - b.seq);
  marks.sort((a, b) => a.at - b.at);

  const times: number[] = [
    ...spans.map((s) => s.start),
    ...spans.flatMap((s) => (s.end === undefined ? [] : [s.end])),
    ...marks.map((m) => m.at),
  ];
  // An open span runs to the present, which is what stretches the axis to cover
  // an execution that is still going.
  if (spans.some((s) => s.end === undefined)) times.push(now);

  if (times.length === 0)
    return {spans, marks, start: 0, end: 0, unplaceable, empty: true};

  return {
    spans,
    marks,
    start: Math.min(...times),
    end: Math.max(...times),
    unplaceable,
    empty: false,
  };

  /**
   * Close the dispatch for `seq`, or — when it is not on this page — record the
   * completion as a mark, since its length is not knowable from here.
   */
  function close(
    seq: number,
    at: number,
    outcome: SpanOutcome,
    error?: string,
    childId?: string,
  ): void {
    const dispatch = open.get(seq);
    if (dispatch === undefined) {
      marks.push({
        at,
        label:
          error === undefined
            ? `#${seq} completed`
            : `#${seq} failed — ${error}`,
        tone: outcome === 'failed' ? 'danger' : 'ok',
      });
      return;
    }
    open.delete(seq);
    spans.push({
      ...dispatch,
      end: at,
      outcome,
      childId: dispatch.childId ?? childId,
    });
  }
}

function assertNever(event: never): never {
  throw new Error(`unhandled history event: ${JSON.stringify(event)}`);
}

/**
 * Where a time sits on the axis, as a 0–1 fraction.
 *
 * A zero-width axis — everything in the same millisecond, which is ordinary for
 * a fast local run — collapses to 0 rather than dividing by zero.
 */
export function fractionOf(
  at: number,
  timeline: Pick<CompactTimeline, 'start' | 'end'>,
): number {
  const width = timeline.end - timeline.start;
  if (width <= 0) return 0;
  return (at - timeline.start) / width;
}
