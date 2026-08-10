/**
 * @fileoverview
 * What a durable history event means to a reader: the line it renders as, the
 * family it belongs to, and the pairing that turns two events into a duration.
 *
 * Separate from `history_timeline.ts`, which lays these out in a table, because
 * this half is the part with decisions in it and it touches no DOM — so it runs
 * in the suite (`spec/dashboard/history_view.spec.ts`). The interesting cases
 * are all data cases: a completion whose dispatch is on a different page, an
 * event from before `ts` existed, a duration that should not be rendered in
 * milliseconds.
 *
 * ## Pairing, not just listing
 *
 * Dispatch and completion are two events keyed by the same `seq`
 * (`activityScheduled` → `activityCompleted`, `timerStarted` → `timerFired`,
 * `childStarted` → `childCompleted`). Duration is the gap between them, so a
 * completion is measured against the timestamp of *its* marker rather than
 * against the row above it. That is why the marker index is built over the
 * whole page before rendering rather than tracked while walking it — a
 * completion can be many events after its dispatch.
 *
 * A marker outside the current page leaves the duration unknown, and it stays
 * unknown. Inferring one from the page boundary would be a guess presented as a
 * measurement.
 */

import type {HistoryEvent} from 'workflow-engine/protocol';

function assertNever(event: never): never {
  throw new Error(`unhandled history event: ${JSON.stringify(event)}`);
}

/** How an event reads: its headline, and whether it is good news. */
export interface EventView {
  label: string;
  tone: 'ok' | 'danger' | 'accent' | 'muted';
  /** The event's payload, if it has one worth showing. */
  payload?: unknown;
  /** A stack, for the one event kind that carries one. */
  stack?: string;
  /**
   * A child execution this event refers to, when the event names one. The
   * timeline renders it as a link — which is the whole reason `childId` is
   * denormalized onto the outcome events (see `ChildCompletedEvent`).
   *
   * Absent on history written before that field existed, so the row degrades to
   * plain text rather than to a link that goes nowhere.
   */
  childId?: string;
}

/**
 * The one-line description of an event.
 *
 * The `switch` ends in `assertNever` rather than a bare default, so adding a
 * history event kind is a compile error here instead of a row that silently
 * renders as nothing (see AGENTS.md).
 */
export function describeEvent(event: HistoryEvent): EventView {
  switch (event.type) {
    case 'activityScheduled':
      return {
        label: `activity ${event.name} scheduled`,
        tone: 'muted',
        payload: event.args,
      };
    case 'activityCompleted':
      return {label: 'activity completed', tone: 'ok', payload: event.result};
    case 'activityFailed':
      return {
        label: `activity failed — ${event.error}`,
        tone: 'danger',
        stack: event.stack,
      };
    case 'timerStarted':
      return {
        label: `timer started, fires ${new Date(event.fireAt).toISOString()}`,
        tone: 'muted',
      };
    case 'timerFired':
      return {label: 'timer fired', tone: 'accent'};
    case 'childStarted':
      return {
        // The policy is on the label rather than hidden in the payload because
        // it is the answer to "why did this child get terminated?", asked from
        // the parent's history after the fact.
        label:
          `${event.detached ? 'detached child' : 'child'} started` +
          ` (on close: ${event.parentClosePolicy ?? 'abandon'})`,
        tone: 'muted',
        childId: event.childId,
      };
    case 'childCompleted':
      return {
        label: 'child completed',
        tone: 'ok',
        payload: event.result,
        childId: event.childId,
      };
    case 'childFailed':
      return {
        label: `child failed — ${event.error}`,
        tone: 'danger',
        childId: event.childId,
      };
    case 'signal':
      return {
        label: `signal ${event.name}`,
        tone: 'accent',
        payload: event.payload,
      };
    case 'childCancelRequested':
      return {
        label: `cancel requested for child at seq ${event.targetSeq}`,
        tone: 'danger',
      };
    case 'workflowSignaled':
      // `delivered: false` is the whole reason this row is worth rendering: the
      // sender never sees the failure, so the history is where it surfaces.
      return event.delivered
        ? {
            label: `signal ${event.signalName} sent to ${event.targetId}`,
            tone: 'muted',
          }
        : {
            label: `signal ${event.signalName} undelivered — no running ${event.targetId}`,
            tone: 'danger',
          };
    case 'cancelRequested':
      return {label: 'cancellation requested', tone: 'danger'};
    default:
      return assertNever(event);
  }
}

/**
 * The families a reader narrows a history to.
 *
 * Five, rather than the eleven event types, because the question is never "show me
 * `activityFailed`" — it is "show me the activities", and a dispatch is only
 * legible next to its outcome. Splitting them would let a reader filter to the
 * failures and lose the `activityScheduled` rows that say which activity failed.
 */
export type EventCategory =
  'activity' | 'timer' | 'child' | 'signal' | 'cancellation';

/** Every category, in the order the filter offers them. */
export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'activity',
  'timer',
  'child',
  'signal',
  'cancellation',
];

/**
 * Which family an event belongs to.
 *
 * `assertNever` again: a new event kind has to be assigned a family here, rather
 * than silently belonging to none and disappearing whenever a filter is on —
 * which is the version of this bug nobody would notice, since the row is only
 * missing when someone is already looking at a subset.
 */
export function eventCategory(event: HistoryEvent): EventCategory {
  switch (event.type) {
    case 'activityScheduled':
    case 'activityCompleted':
    case 'activityFailed':
      return 'activity';
    case 'timerStarted':
    case 'timerFired':
      return 'timer';
    case 'childStarted':
    case 'childCompleted':
    case 'childFailed':
    // A cancel names a `targetSeq` and nothing else, so it is unreadable away
    // from the `childStarted` it points at — the same "a dispatch is only
    // legible next to its outcome" argument that keeps the three above together.
    // It is not `cancellation`: that family is this execution being cancelled,
    // which is a different thing happening to a different workflow.
    case 'childCancelRequested':
      return 'child';
    case 'signal':
    // The sending end of a signal, filed with the receiving end: someone
    // filtering to signals wants both halves of the conversation this execution
    // is having, not only the half aimed at it.
    case 'workflowSignaled':
      return 'signal';
    case 'cancelRequested':
      return 'cancellation';
    default:
      return assertNever(event);
  }
}

/** The event kinds that complete a dispatch, and so can carry a duration. */
const COMPLETIONS: ReadonlySet<HistoryEvent['type']> = new Set([
  'activityCompleted',
  'activityFailed',
  'timerFired',
  'childCompleted',
  'childFailed',
]);

/**
 * When each dispatched command was dispatched, by `seq`.
 *
 * Events with no `ts` are left out rather than recorded as zero: history
 * written before that field existed has none, and a duration measured from the
 * epoch would be a very confident wrong answer.
 */
export function markerTimes(history: HistoryEvent[]): Map<number, number> {
  const times = new Map<number, number>();
  for (const event of history) {
    if (
      (event.type === 'activityScheduled' ||
        event.type === 'timerStarted' ||
        event.type === 'childStarted') &&
      event.ts !== undefined
    )
      times.set(event.seq, event.ts);
  }
  return times;
}

/**
 * How long this event took, or undefined if that is not knowable — because it
 * is not a completion, because it has no timestamp, or because its dispatch is
 * on a page that is not loaded.
 */
export function durationOf(
  event: HistoryEvent,
  markers: Map<number, number>,
): number | undefined {
  if (!COMPLETIONS.has(event.type) || !('seq' in event)) return undefined;
  if (event.ts === undefined) return undefined;
  const started = markers.get(event.seq);
  return started === undefined ? undefined : event.ts - started;
}

/** A duration in the largest unit that keeps it readable. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
