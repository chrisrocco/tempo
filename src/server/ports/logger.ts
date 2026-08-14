/**
 * @fileoverview
 * The port lifecycle facts are reported through. A `Logger` is called with an
 * event name and a bag of fields; what happens to them is the adapter's business
 * (`server/json_logger.ts` writes one JSON object per line).
 *
 * It is a port rather than a module anyone can import for the same reason the
 * history store is: writing to a stream is I/O, and the layering rules keep `server/`
 * importing only `protocol/`. A shared logging module reachable from every layer
 * would be the `utils/` this codebase deliberately does not have. Injected instead,
 * it is swappable, silent in tests by default, and impossible to reach for by
 * accident from the deterministic side.
 *
 * **Events are structured, never formatted.** No sentences, no interpolation — a
 * stable event name plus fields. That is what makes the log aggregatable later
 * without anyone parsing prose, and it is why the "metrics" decision could be
 * deferred to a choice of sink rather than a rewrite of every call site.
 *
 * Names are `subject.verb` in past tense (`activity.timed_out`), because a log
 * line records something that already happened.
 *
 * ## An event name is a public contract, and renaming one is a break
 *
 * This is easy to miss, because nothing here fails when it happens. An event name
 * and its fields are not internal detail the way a private function's name is: the
 * whole point of "structured, never formatted" is that something downstream reads
 * them, and the moment anything does — a query counting `execution.settled` by
 * `name`, an alert on `workflow_task.failed` — renaming a field breaks it exactly
 * as hard as changing an RPC would, and considerably more quietly. The RPC at
 * least has a type on both ends.
 *
 * So treat an event the way `ROADMAP.md` says to treat a `protocol/` type: adding
 * a field is cheap, renaming or removing one is a break, and a change in meaning
 * under an unchanged name is the worst of the three because nothing anywhere can
 * detect it. `README.md`'s "What is contract, and what is not" lists this beside
 * the other surfaces that carry the same standing.
 *
 * The corollary is that an event should carry the dimensions its own readers need
 * rather than expecting them to be joined on. An event that cannot be aggregated
 * without holding earlier events in memory turns a `GROUP BY` into a stateful
 * stream processor, and pushes that cost onto every consumer separately.
 */

/** Structured detail attached to an event. Values must survive `JSON.stringify`. */
export type LogFields = Record<string, unknown>;

/** Where lifecycle events go. Injected; defaults to `silentLogger`. */
export interface Logger {
  (event: string, fields?: LogFields): void;
}

/**
 * The default. Tests and library embedders get silence unless they ask otherwise
 * — a framework that writes to stderr uninvited is a framework people wrap to
 * shut up.
 */
export const silentLogger: Logger = () => {};
